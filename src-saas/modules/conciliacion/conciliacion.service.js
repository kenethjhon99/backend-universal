import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { parseCsv } from "../importador/csv-parser.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));

// ============================================================
// Cuentas bancarias (CRUD basico)
// ============================================================
export const listCuentas = async ({ auth }) => {
  const r = await pool.query(
    `select * from cuentas_bancarias where id_empresa = $1 order by activa desc, banco asc`,
    [auth.id_empresa]
  );
  return r.rows;
};

export const createCuenta = async ({ auth, scope, body, requestMeta }) => {
  const r = await pool.query(
    `
      insert into cuentas_bancarias (
        id_empresa, banco, numero_cuenta, alias, moneda, saldo_inicial, activa,
        created_by, updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      returning *
    `,
    [
      auth.id_empresa,
      String(body?.banco || "").trim(),
      String(body?.numero_cuenta || "").trim(),
      body?.alias || null,
      (body?.moneda || "GTQ").toUpperCase(),
      Number(body?.saldo_inicial || 0),
      body?.activa !== false,
      auth.id_usuario,
    ]
  );

  await writeAuditEvent(pool, {
    auth, scope, requestMeta,
    modulo: "CONCILIACION", entidad: "CUENTA_BANCARIA",
    entidadId: r.rows[0].id_cuenta, accion: "CREATE", despues: r.rows[0],
  });

  return r.rows[0];
};

// ============================================================
// Importacion de extracto (CSV con headers: fecha,descripcion,referencia,tipo,monto)
// tipo: CREDITO|DEBITO ; fecha: YYYY-MM-DD ; monto: numero positivo
// ============================================================
export const importExtracto = async ({
  auth,
  scope,
  idCuenta,
  csvText,
  periodoDesde,
  periodoHasta,
  archivoOrigen = null,
  requestMeta,
}) => {
  const { headers, rows } = parseCsv(csvText);
  if (!headers.includes("fecha") || !headers.includes("monto") || !headers.includes("tipo")) {
    throw HttpError.badRequest(
      "El CSV debe tener al menos columnas: fecha, monto, tipo (CREDITO/DEBITO)"
    );
  }

  return runInTransaction(
    async (client) => {
      // Validar cuenta
      const cuentaResult = await client.query(
        `select id_cuenta from cuentas_bancarias where id_empresa = $1 and id_cuenta = $2`,
        [auth.id_empresa, idCuenta]
      );
      if (cuentaResult.rowCount === 0) {
        throw HttpError.notFound("Cuenta bancaria no encontrada");
      }

      const ext = await client.query(
        `
          insert into banco_extractos (
            id_empresa, id_cuenta, periodo_desde, periodo_hasta,
            archivo_origen, total_movimientos, created_by, updated_by
          )
          values ($1, $2, $3::date, $4::date, $5, 0, $6, $6)
          returning id_extracto
        `,
        [
          auth.id_empresa,
          idCuenta,
          periodoDesde,
          periodoHasta,
          archivoOrigen,
          auth.id_usuario,
        ]
      );
      const idExtracto = Number(ext.rows[0].id_extracto);

      let count = 0;
      const errors = [];

      for (const [idx, row] of rows.entries()) {
        const linea = idx + 2;
        const tipo = String(row.tipo || "").toUpperCase();
        const monto = Number(row.monto);
        if (!["CREDITO", "DEBITO"].includes(tipo) || !Number.isFinite(monto) || monto < 0) {
          errors.push({ linea, error: "tipo o monto invalido" });
          continue;
        }
        try {
          await client.query(
            `
              insert into banco_movimientos (
                id_empresa, id_extracto, fecha, descripcion, referencia, tipo, monto
              )
              values ($1, $2, $3::date, $4, $5, $6, $7)
            `,
            [
              auth.id_empresa,
              idExtracto,
              row.fecha,
              row.descripcion || null,
              row.referencia || null,
              tipo,
              round2(monto),
            ]
          );
          count += 1;
        } catch (err) {
          errors.push({ linea, error: err.message });
        }
      }

      await client.query(
        `update banco_extractos set total_movimientos = $1 where id_extracto = $2`,
        [count, idExtracto]
      );

      await writeAuditEvent(client, {
        auth, scope, requestMeta,
        modulo: "CONCILIACION", entidad: "EXTRACTO",
        entidadId: idExtracto, accion: "IMPORT",
        despues: { idCuenta, count, errors: errors.length },
      });

      return { id_extracto: idExtracto, total_movimientos: count, errors };
    },
    { auth }
  );
};

// ============================================================
// Auto-match: para cada movimiento del banco no conciliado, buscar
// candidatos en caja_movimientos por (fecha +/- 2d, monto exacto).
// ============================================================
export const autoMatch = async ({ auth, scope, idExtracto, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const movs = await client.query(
        `
          select * from banco_movimientos
          where id_empresa = $1 and id_extracto = $2 and conciliado = false
        `,
        [auth.id_empresa, idExtracto]
      );

      let matched = 0;
      const detalle = [];

      for (const m of movs.rows) {
        // Buscar caja_movimientos del mismo monto en la ventana de fechas
        // Para CREDITO bancario -> INGRESO en caja; DEBITO -> EGRESO
        const tipoCaja = m.tipo === "CREDITO" ? "INGRESO" : "EGRESO";
        const cands = await client.query(
          `
            select id_caja_movimiento, monto, fecha
            from caja_movimientos cm
            inner join caja_sesiones cs
              on cs.id_empresa = cm.id_empresa and cs.id_caja_sesion = cm.id_caja_sesion
            where cm.id_empresa = $1
              and cm.tipo = $2
              and cm.monto = $3
              and cs.fecha_apertura::date between ($4::date - interval '2 days') and ($4::date + interval '2 days')
              and not exists (
                select 1 from conciliacion_matches mc
                where mc.id_empresa = cm.id_empresa and mc.id_caja_movimiento = cm.id_caja_movimiento
              )
            limit 1
          `,
          [auth.id_empresa, tipoCaja, round2(m.monto), m.fecha]
        );

        if (cands.rowCount > 0) {
          const cand = cands.rows[0];
          await client.query(
            `
              insert into conciliacion_matches (
                id_empresa, id_banco_mov, id_caja_movimiento, monto_match, manual, created_by
              )
              values ($1, $2, $3, $4, false, $5)
            `,
            [auth.id_empresa, m.id_mov, cand.id_caja_movimiento, round2(m.monto), auth.id_usuario]
          );
          await client.query(
            `update banco_movimientos set conciliado = true where id_mov = $1`,
            [m.id_mov]
          );
          matched += 1;
          detalle.push({ id_banco_mov: m.id_mov, id_caja_movimiento: cand.id_caja_movimiento });
        }
      }

      await client.query(
        `update banco_extractos set estado = 'EN_CONCILIACION' where id_extracto = $1`,
        [idExtracto]
      );

      await writeAuditEvent(client, {
        auth, scope, requestMeta,
        modulo: "CONCILIACION", entidad: "AUTO_MATCH",
        entidadId: idExtracto, accion: "MATCH",
        despues: { matched, total: movs.rowCount },
      });

      return { matched, total: movs.rowCount, detalle };
    },
    { auth }
  );

// ============================================================
// Match manual
// ============================================================
export const matchManual = async ({ auth, body }) => {
  const idBancoMov = Number(body?.id_banco_mov);
  const idCajaMov = body?.id_caja_movimiento ? Number(body.id_caja_movimiento) : null;
  if (!idBancoMov) throw HttpError.badRequest("id_banco_mov requerido");
  if (!idCajaMov) throw HttpError.badRequest("id_caja_movimiento requerido");

  const mov = await pool.query(
    `select monto from banco_movimientos where id_empresa = $1 and id_mov = $2`,
    [auth.id_empresa, idBancoMov]
  );
  if (mov.rowCount === 0) throw HttpError.notFound("Movimiento bancario no encontrado");

  await pool.query(
    `
      insert into conciliacion_matches (
        id_empresa, id_banco_mov, id_caja_movimiento, monto_match, manual,
        notas, created_by
      )
      values ($1, $2, $3, $4, true, $5, $6)
    `,
    [
      auth.id_empresa,
      idBancoMov,
      idCajaMov,
      round2(mov.rows[0].monto),
      body?.notas || null,
      auth.id_usuario,
    ]
  );

  await pool.query(
    `update banco_movimientos set conciliado = true where id_empresa = $1 and id_mov = $2`,
    [auth.id_empresa, idBancoMov]
  );

  return { ok: true };
};

// ============================================================
// Resumen de un extracto
// ============================================================
export const getResumenExtracto = async ({ auth, idExtracto }) => {
  const ext = await pool.query(
    `select * from banco_extractos where id_empresa = $1 and id_extracto = $2`,
    [auth.id_empresa, idExtracto]
  );
  if (ext.rowCount === 0) throw HttpError.notFound("Extracto no encontrado");

  const stats = await pool.query(
    `
      select
        count(*)::int as total,
        count(*) filter (where conciliado)::int as conciliados,
        count(*) filter (where not conciliado)::int as pendientes,
        coalesce(sum(monto) filter (where tipo='CREDITO'), 0) as total_creditos,
        coalesce(sum(monto) filter (where tipo='DEBITO'), 0) as total_debitos
      from banco_movimientos
      where id_empresa = $1 and id_extracto = $2
    `,
    [auth.id_empresa, idExtracto]
  );

  const pendientes = await pool.query(
    `
      select id_mov, fecha, descripcion, referencia, tipo, monto
      from banco_movimientos
      where id_empresa = $1 and id_extracto = $2 and not conciliado
      order by fecha asc
      limit 100
    `,
    [auth.id_empresa, idExtracto]
  );

  return {
    extracto: ext.rows[0],
    resumen: {
      ...stats.rows[0],
      total_creditos: round2(stats.rows[0].total_creditos),
      total_debitos: round2(stats.rows[0].total_debitos),
    },
    pendientes: pendientes.rows.map((r) => ({ ...r, monto: round2(r.monto) })),
  };
};
