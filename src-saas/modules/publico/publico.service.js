import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

/**
 * Devuelve el estado publico de una orden de servicio identificada por su
 * `codigo_publico` (no por id, para evitar enumeracion).
 *
 * NO requiere autenticacion porque la URL es la unica forma de obtener
 * informacion (deep link enviado al cliente o impreso como QR en el ticket).
 *
 * Solo expone informacion no-sensible: numero, estado, fechas de cambio,
 * nombre/placa/color del vehiculo, nombre del servicio.
 * NO expone montos, costos ni datos del usuario que la registro.
 */
export const getOrdenPublica = async ({ codigoPublico }) => {
  const result = await pool.query(
    `
      select
        os.codigo_publico,
        os.numero_orden,
        upper(os.modulo) as modulo,
        upper(os.estado) as estado,
        upper(coalesce(os.estado_cobro, 'PENDIENTE')) as estado_cobro,
        os.placa,
        os.vehiculo_tipo,
        os.color,
        os.marca,
        os.modelo,
        os.fecha_servicio,
        os.fecha_inicio,
        os.fecha_finalizacion,
        os.fecha_entrega,
        sc.nombre as servicio_nombre,
        sc.duracion_minutos,
        s.nombre as sucursal_nombre,
        e.nombre_legal as empresa_nombre,
        e.nombre_comercial as empresa_comercial
      from ordenes_servicio os
      inner join servicios_catalogo sc
        on sc.id_empresa = os.id_empresa
       and sc.id_servicio_catalogo = os.id_servicio_catalogo
      inner join sucursales s
        on s.id_empresa = os.id_empresa
       and s.id_sucursal = os.id_sucursal
      inner join empresas e
        on e.id_empresa = os.id_empresa
      where os.codigo_publico = $1
      limit 1
    `,
    [String(codigoPublico).trim()]
  );

  const row = result.rows[0];
  if (!row) {
    throw HttpError.notFound("Orden no encontrada o codigo invalido");
  }

  // Linea de tiempo legible para el cliente
  const timeline = [
    { etapa: "Recibido", fecha: row.fecha_servicio, alcanzado: true },
    {
      etapa: "En proceso",
      fecha: row.fecha_inicio,
      alcanzado: row.estado === "EN_PROCESO" || ["LISTO", "ENTREGADO"].includes(row.estado),
    },
    {
      etapa: "Listo",
      fecha: row.fecha_finalizacion,
      alcanzado: ["LISTO", "ENTREGADO"].includes(row.estado),
    },
    {
      etapa: "Entregado",
      fecha: row.fecha_entrega,
      alcanzado: row.estado === "ENTREGADO",
    },
  ];

  return {
    codigo_publico: row.codigo_publico,
    numero_orden: row.numero_orden,
    modulo: row.modulo,
    estado: row.estado,
    estado_cobro: row.estado_cobro,
    vehiculo: {
      placa: row.placa,
      tipo: row.vehiculo_tipo,
      color: row.color,
      marca: row.marca,
      modelo: row.modelo,
    },
    servicio: {
      nombre: row.servicio_nombre,
      duracion_minutos: row.duracion_minutos,
    },
    empresa: {
      nombre: row.empresa_comercial || row.empresa_nombre,
    },
    sucursal: {
      nombre: row.sucursal_nombre,
    },
    timeline,
  };
};
