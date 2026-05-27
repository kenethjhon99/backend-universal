import crypto from "node:crypto";
import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

/**
 * Genera N cupones unicos basados en una promocion plantilla.
 * Cada cupón es una promoción separada (mismo tipo/valor) con un código único.
 *
 * Útil para campañas:
 *   - QR impresos en flyers
 *   - Email blast con código único por cliente
 *   - "100 primeros clientes" con códigos pre-generados
 */

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I para evitar confusión

const generateCode = (prefix = "", length = 8) => {
  let suffix = "";
  for (let i = 0; i < length; i += 1) {
    suffix += CHARSET[crypto.randomInt(0, CHARSET.length)];
  }
  return prefix ? `${prefix.toUpperCase()}-${suffix}` : suffix;
};

/**
 * Genera N cupones unicos basados en una promocion plantilla.
 *
 * body: {
 *   plantilla: { tipo, valor, productos_elegibles?, monto_minimo?, vigente_desde?, vigente_hasta?, usos_max_por_cliente? },
 *   cantidad: number,
 *   prefijo?: string,
 *   length?: number,
 *   nombre_base?: string
 * }
 */
export const generateBulk = async ({ auth, body }) => {
  const cantidad = Math.min(5000, Math.max(1, Number(body?.cantidad || 1)));
  const plantilla = body?.plantilla || {};
  const prefix = body?.prefijo || "";
  const length = Math.min(16, Math.max(6, Number(body?.length) || 8));
  const nombreBase = body?.nombre_base || "Cupon campaña";

  const tipo = String(plantilla?.tipo || "CUPON").toUpperCase();
  if (!["PORCENTAJE_VENTA", "MONTO_VENTA", "PORCENTAJE_LINEA", "CUPON"].includes(tipo)) {
    throw HttpError.badRequest("tipo de plantilla invalido");
  }
  const valor = Number(plantilla?.valor || 0);
  if (!Number.isFinite(valor) || valor < 0) {
    throw HttpError.badRequest("valor de plantilla invalido");
  }

  const codigosGenerados = [];
  const errores = [];

  // Intentar insertar uno por uno; si hay colisión de codigo, reintentamos
  // hasta 3 veces. (Improbable con 8 chars del CHARSET sin ambiguos.)
  for (let i = 0; i < cantidad; i += 1) {
    let intento = 0;
    let exito = false;
    while (intento < 3 && !exito) {
      const codigo = generateCode(prefix, length);
      try {
        const r = await pool.query(
          `
            insert into promociones (
              id_empresa, codigo, nombre, descripcion, tipo, valor,
              productos_elegibles, monto_minimo,
              vigente_desde, vigente_hasta,
              usos_max_total, usos_max_por_cliente,
              prioridad, combinable, activa, created_by, updated_by
            )
            values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 1, $11, 100, false, true, $12, $12)
            on conflict (id_empresa, codigo) do nothing
            returning id_promocion, codigo
          `,
          [
            auth.id_empresa,
            codigo,
            `${nombreBase} ${i + 1}/${cantidad}`,
            plantilla?.descripcion || null,
            tipo,
            valor,
            JSON.stringify(plantilla?.productos_elegibles || null),
            Number(plantilla?.monto_minimo || 0),
            plantilla?.vigente_desde || null,
            plantilla?.vigente_hasta || null,
            // usos_max_total: 1 por cupon (de campaña, un solo uso)
            // usos_max_por_cliente: lo que diga la plantilla
            Number(plantilla?.usos_max_por_cliente || 1),
            auth.id_usuario,
          ]
        );
        if (r.rowCount > 0) {
          codigosGenerados.push({
            id_promocion: Number(r.rows[0].id_promocion),
            codigo: r.rows[0].codigo,
          });
          exito = true;
        }
      } catch (error) {
        errores.push({ intento: i + 1, error: error.message });
        exito = true; // no reintentar errores de DB no relacionados a duplicado
      }
      intento += 1;
    }
  }

  return {
    cantidad_solicitada: cantidad,
    cantidad_generada: codigosGenerados.length,
    cupones: codigosGenerados,
    errores,
  };
};

/**
 * Genera la URL de un QR que el cliente puede escanear para ver / aplicar
 * el cupon. La URL apunta a una pagina publica del frontend.
 *
 * No se genera el PNG aqui (eso es responsabilidad del frontend con un
 * componente QrCode). Solo devolvemos el deeplink a codificar.
 */
export const getCuponQrUrl = async ({ auth, idPromocion, frontendOrigin = null }) => {
  const r = await pool.query(
    `select codigo, nombre from promociones where id_empresa = $1 and id_promocion = $2 and activa = true`,
    [auth.id_empresa, idPromocion]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Promocion no encontrada o inactiva");
  const codigo = r.rows[0].codigo;
  if (!codigo) {
    throw HttpError.badRequest("La promocion no tiene codigo (no es cupon)");
  }

  // El frontend define la ruta publica /cupon/:codigo (futura). Por ahora,
  // devolvemos un deep-link con el codigo. La empresa puede usar este texto
  // como contenido de QR (con qrcode lib en su preferencia).
  const origin =
    frontendOrigin ||
    process.env.FRONTEND_ORIGIN ||
    "https://app.pos-saas.example.com";

  return {
    codigo,
    nombre: r.rows[0].nombre,
    url: `${origin}/#/cupon/${encodeURIComponent(codigo)}`,
    qr_payload: codigo, // si el receptor solo necesita el código plano
  };
};
