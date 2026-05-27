import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));

const ensureConfig = async (idEmpresa) => {
  const result = await pool.query(
    `select * from fidelidad_config where id_empresa = $1`,
    [idEmpresa]
  );
  return result.rows[0] || null;
};

export const getConfig = async ({ auth }) => {
  const config = await ensureConfig(auth.id_empresa);
  return config || { id_empresa: auth.id_empresa, activo: false };
};

export const upsertConfig = async ({ auth, body, scope, requestMeta }) => {
  const result = await pool.query(
    `
      insert into fidelidad_config (
        id_empresa, activo, puntos_por_unidad, unidad_monetaria,
        redencion_monto, redencion_min_puntos, vigencia_dias,
        created_by, updated_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
      on conflict (id_empresa) do update set
        activo = excluded.activo,
        puntos_por_unidad = excluded.puntos_por_unidad,
        unidad_monetaria = excluded.unidad_monetaria,
        redencion_monto = excluded.redencion_monto,
        redencion_min_puntos = excluded.redencion_min_puntos,
        vigencia_dias = excluded.vigencia_dias,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      auth.id_empresa,
      body?.activo === true,
      Number(body?.puntos_por_unidad ?? 1),
      Number(body?.unidad_monetaria ?? 1),
      Number(body?.redencion_monto ?? 0.1),
      Number(body?.redencion_min_puntos ?? 100),
      body?.vigencia_dias || null,
      auth.id_usuario,
    ]
  );

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "FIDELIDAD",
    entidad: "CONFIG",
    entidadId: auth.id_empresa,
    accion: "UPSERT",
    despues: result.rows[0],
  });

  return result.rows[0];
};

export const getSaldoCliente = async ({ auth, idCliente }) => {
  const result = await pool.query(
    `select * from fidelidad_saldos where id_empresa = $1 and id_cliente = $2`,
    [auth.id_empresa, idCliente]
  );
  return (
    result.rows[0] || {
      id_empresa: auth.id_empresa,
      id_cliente: idCliente,
      saldo: 0,
      ganados_total: 0,
      canjeados_total: 0,
      ultimo_movimiento: null,
    }
  );
};

export const listMovimientosCliente = async ({ auth, idCliente, limit = 50 }) => {
  const result = await pool.query(
    `
      select id_movimiento, tipo, puntos, id_venta, motivo, vigente_hasta, created_at
      from fidelidad_movimientos
      where id_empresa = $1 and id_cliente = $2
      order by created_at desc
      limit $3
    `,
    [auth.id_empresa, idCliente, Math.min(200, Number(limit) || 50)]
  );
  return result.rows;
};

/**
 * Acumula puntos GANADO al cerrar una venta. Llamado desde createVenta.
 * Idempotente: si la venta ya generó GANADO, no duplica.
 */
export const acumularPorVenta = async (
  client,
  { idEmpresa, idCliente, idVenta, total, actorId = null }
) => {
  if (!idCliente) return null;
  const cfg = (await client.query(
    `select * from fidelidad_config where id_empresa = $1`,
    [idEmpresa]
  )).rows[0];
  if (!cfg || !cfg.activo) return null;

  // Idempotencia: ya hay GANADO para esta venta?
  const dup = await client.query(
    `select 1 from fidelidad_movimientos where id_empresa = $1 and id_venta = $2 and tipo = 'GANADO' limit 1`,
    [idEmpresa, idVenta]
  );
  if (dup.rowCount > 0) return null;

  const puntos = Math.floor(
    (Number(total) / Number(cfg.unidad_monetaria || 1)) *
      Number(cfg.puntos_por_unidad || 1)
  );
  if (puntos <= 0) return null;

  let vigenteHasta = null;
  if (cfg.vigencia_dias) {
    const d = new Date();
    d.setDate(d.getDate() + Number(cfg.vigencia_dias));
    vigenteHasta = d.toISOString().slice(0, 10);
  }

  const result = await client.query(
    `
      insert into fidelidad_movimientos (
        id_empresa, id_cliente, tipo, puntos, id_venta, motivo, vigente_hasta, created_by
      )
      values ($1, $2, 'GANADO', $3, $4, $5, $6::date, $7)
      returning id_movimiento
    `,
    [idEmpresa, idCliente, puntos, idVenta, `Venta #${idVenta}`, vigenteHasta, actorId]
  );

  return { id_movimiento: result.rows[0].id_movimiento, puntos };
};

/**
 * Canjea puntos en una venta. El cajero indica cuantos puntos quiere usar.
 * Devuelve el monto descontado en moneda.
 */
export const canjearEnVenta = async (
  client,
  { idEmpresa, idCliente, idVenta, puntosACanjear, actorId = null }
) => {
  if (!idCliente || !puntosACanjear || puntosACanjear <= 0) {
    return { puntos: 0, monto: 0 };
  }

  const cfg = (await client.query(
    `select * from fidelidad_config where id_empresa = $1`,
    [idEmpresa]
  )).rows[0];
  if (!cfg || !cfg.activo) {
    throw HttpError.badRequest("Programa de fidelidad no esta activo");
  }
  if (puntosACanjear < cfg.redencion_min_puntos) {
    throw HttpError.badRequest(
      `Minimo de canje: ${cfg.redencion_min_puntos} puntos`
    );
  }

  const saldoResult = await client.query(
    `select coalesce(sum(puntos), 0)::int as saldo
     from fidelidad_movimientos
     where id_empresa = $1 and id_cliente = $2`,
    [idEmpresa, idCliente]
  );
  const saldo = Number(saldoResult.rows[0].saldo);
  if (saldo < puntosACanjear) {
    throw HttpError.badRequest(
      `Puntos insuficientes. Saldo actual: ${saldo}`
    );
  }

  const monto = round2(Number(puntosACanjear) * Number(cfg.redencion_monto || 0));

  await client.query(
    `
      insert into fidelidad_movimientos (
        id_empresa, id_cliente, tipo, puntos, id_venta, motivo, created_by
      )
      values ($1, $2, 'CANJEADO', $3, $4, $5, $6)
    `,
    [idEmpresa, idCliente, -Number(puntosACanjear), idVenta, `Canje en venta #${idVenta}`, actorId]
  );

  return { puntos: Number(puntosACanjear), monto };
};

/**
 * Expira puntos GANADO cuya vigencia ya paso, generando un movimiento
 * EXPIRADO compensatorio. Diseñado para correr en cron diario.
 */
export const expirarVigentes = async () => {
  const result = await pool.query(
    `
      with vencidos as (
        select id_empresa, id_cliente, sum(puntos) as puntos_a_expirar
        from fidelidad_movimientos
        where tipo = 'GANADO'
          and vigente_hasta is not null
          and vigente_hasta < current_date
          and not exists (
            select 1 from fidelidad_movimientos m2
            where m2.id_empresa = fidelidad_movimientos.id_empresa
              and m2.id_cliente = fidelidad_movimientos.id_cliente
              and m2.tipo = 'EXPIRADO'
              and m2.motivo = 'Expiracion ' || fidelidad_movimientos.id_movimiento::text
          )
        group by id_empresa, id_cliente
      )
      insert into fidelidad_movimientos (id_empresa, id_cliente, tipo, puntos, motivo)
      select id_empresa, id_cliente, 'EXPIRADO', -puntos_a_expirar,
             'Expiracion automatica diaria'
      from vencidos
      where puntos_a_expirar > 0
      returning id_movimiento
    `
  );
  return { expirados: result.rowCount || 0 };
};
