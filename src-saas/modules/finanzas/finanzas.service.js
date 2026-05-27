import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import {
  applyCuentaPorCobrarMovement,
  applyCuentaPorPagarMovement,
  ensureCashSessionForFinance,
  isCashPaymentMethod,
} from "../../shared/finance/accounts.js";
import {
  assertPeriodOpen,
  getClosureArea,
} from "../../shared/finance/period-closure.js";
import { HttpError } from "../../shared/http/http-error.js";

const ALLOWED_NOTE_DESTINATIONS = new Set(["CXC", "CXP"]);
const ALLOWED_NOTE_TYPES = new Set(["CREDITO", "DEBITO"]);
const ALLOWED_PAYMENT_METHODS = new Set([
  "EFECTIVO",
  "TRANSFERENCIA",
  "TARJETA",
  "CHEQUE",
  "AJUSTE",
]);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const normalizeText = (value) => String(value || "").trim();
const normalizeState = (value) => String(value || "").trim().toUpperCase();
const toInteger = (value) => Math.trunc(Number(value || 0));

const ACCOUNT_STATE_SQL = (alias) => `
  case
    when coalesce(${alias}.saldo_actual, 0) <= 0 then 'PAGADA'
    when ${alias}.fecha_vencimiento is not null and ${alias}.fecha_vencimiento < current_date then 'VENCIDA'
    when coalesce(${alias}.saldo_actual, 0) < coalesce(${alias}.monto_original, 0) then 'PARCIAL'
    else 'PENDIENTE'
  end
`;

const toIsoDate = (value) => {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
};

const getMoney = (value, fieldName) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw HttpError.badRequest(`${fieldName} debe ser un numero mayor a 0`);
  }

  return roundMoney(parsed);
};

const getPaymentMethod = (value) => {
  const method = normalizeState(value || "TRANSFERENCIA");

  if (!ALLOWED_PAYMENT_METHODS.has(method)) {
    throw HttpError.badRequest("metodo_pago invalido", {
      metodos_permitidos: [...ALLOWED_PAYMENT_METHODS],
    });
  }

  return method;
};

const normalizeOverviewRow = (row) => ({
  cxc_abiertas: toInteger(row.cxc_abiertas),
  cxc_total: roundMoney(row.cxc_total),
  cxc_vencidas: toInteger(row.cxc_vencidas),
  cxc_vencido_total: roundMoney(row.cxc_vencido_total),
  cxp_abiertas: toInteger(row.cxp_abiertas),
  cxp_total: roundMoney(row.cxp_total),
  cxp_vencidas: toInteger(row.cxp_vencidas),
  cxp_vencido_total: roundMoney(row.cxp_vencido_total),
  notas_mes: toInteger(row.notas_mes),
  notas_monto_mes: roundMoney(row.notas_monto_mes),
  cierres_mes: toInteger(row.cierres_mes),
});

const normalizeAccountRow = (row) => ({
  ...row,
  monto_original: roundMoney(row.monto_original),
  saldo_actual: roundMoney(row.saldo_actual),
});

const normalizeMovementRow = (row) => ({
  ...row,
  monto: roundMoney(row.monto),
  saldo_anterior: roundMoney(row.saldo_anterior),
  saldo_nuevo: roundMoney(row.saldo_nuevo),
});

const normalizeNoteRow = (row) => ({
  ...row,
  monto: roundMoney(row.monto),
});

const getFinanceOverviewContext = async ({ auth, scope }) => {
  const [branchResult, companyResult] = await Promise.all([
    pool.query(
      `
        select id_sucursal, codigo, nombre
        from sucursales
        where id_empresa = $1
          and id_sucursal = $2
        limit 1
      `,
      [auth.id_empresa, scope.id_sucursal]
    ),
    pool.query(
      `
        select id_empresa, nombre_legal
        from empresas
        where id_empresa = $1
        limit 1
      `,
      [auth.id_empresa]
    ),
  ]);

  const branch = branchResult.rows[0];
  const company = companyResult.rows[0];

  if (!branch || !company) {
    throw HttpError.notFound("No se pudo resolver el contexto financiero");
  }

  return {
    empresa: {
      id_empresa: Number(company.id_empresa),
      nombre_legal: company.nombre_legal,
    },
    sucursal: {
      id_sucursal: Number(branch.id_sucursal),
      codigo: branch.codigo,
      nombre: branch.nombre,
    },
  };
};

const getNextNoteDocumentNumber = async (
  db,
  { auth, scope, destino, tipoNota }
) => {
  const normalizedDestination = normalizeState(destino);
  const normalizedType = normalizeState(tipoNota);
  const serie = `${normalizedDestination === "CXC" ? "NC" : "NP"}${
    normalizedType === "CREDITO" ? "C" : "D"
  }`;
  const nombre = `Nota ${normalizedType.toLowerCase()} ${normalizedDestination}`;

  await db.query(
    `
      insert into comprobante_series (
        id_empresa,
        id_sucursal,
        modulo,
        tipo_comprobante,
        nombre,
        serie,
        ultimo_correlativo,
        activo,
        created_by,
        updated_by
      )
      values ($1,$2,'FINANZAS',$3,$4,$5,0,true,$6,$6)
      on conflict (id_empresa, id_sucursal, modulo, tipo_comprobante, serie) do nothing
    `,
    [
      auth.id_empresa,
      scope.id_sucursal,
      `${normalizedDestination}_${normalizedType}`,
      nombre,
      serie,
      auth.id_usuario,
    ]
  );

  const result = await db.query(
    `
      select *
      from comprobante_series
      where id_empresa = $1
        and id_sucursal = $2
        and modulo = 'FINANZAS'
        and tipo_comprobante = $3
        and activo = true
      order by id_comprobante_serie asc
      limit 1
      for update
    `,
    [
      auth.id_empresa,
      scope.id_sucursal,
      `${normalizedDestination}_${normalizedType}`,
    ]
  );

  const series = result.rows[0];
  const nextCorrelative = Number(series.ultimo_correlativo || 0) + 1;

  await db.query(
    `
      update comprobante_series
      set ultimo_correlativo = $1
      where id_comprobante_serie = $2
    `,
    [nextCorrelative, series.id_comprobante_serie]
  );

  return `${series.serie}-${String(nextCorrelative).padStart(8, "0")}`;
};

const getCxcByIdInternal = async (db, { auth, scope, idCuentaPorCobrar }) => {
  const accountResult = await db.query(
    `
      select
        cxc.*,
        ${ACCOUNT_STATE_SQL("cxc")} as estado_resuelto,
        cl.nombre as cliente_nombre,
        cl.telefono as cliente_telefono,
        v.numero_comprobante as venta_numero_comprobante
      from cuentas_por_cobrar cxc
      inner join clientes cl
        on cl.id_empresa = cxc.id_empresa
       and cl.id_cliente = cxc.id_cliente
      left join ventas v
        on v.id_empresa = cxc.id_empresa
       and v.id_venta = cxc.id_venta
      where cxc.id_empresa = $1
        and cxc.id_cuenta_por_cobrar = $2
        and cxc.id_sucursal = $3
      limit 1
    `,
    [auth.id_empresa, idCuentaPorCobrar, scope.id_sucursal]
  );

  const account = accountResult.rows[0];

  if (!account) {
    throw HttpError.notFound("Cuenta por cobrar no encontrada");
  }

  const movementResult = await db.query(
    `
      select
        mov.*,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from cuentas_por_cobrar_movimientos mov
      inner join usuarios u
        on u.id_empresa = mov.id_empresa
       and u.id_usuario = mov.id_usuario
      where mov.id_empresa = $1
        and mov.id_cuenta_por_cobrar = $2
      order by mov.fecha_movimiento desc, mov.id_cxc_movimiento desc
    `,
    [auth.id_empresa, idCuentaPorCobrar]
  );

  return {
    cuenta: normalizeAccountRow(account),
    movimientos: movementResult.rows.map(normalizeMovementRow),
  };
};

const getCxpByIdInternal = async (db, { auth, scope, idCuentaPorPagar }) => {
  const accountResult = await db.query(
    `
      select
        cxp.*,
        ${ACCOUNT_STATE_SQL("cxp")} as estado_resuelto,
        pr.nombre as proveedor_nombre,
        pr.telefono as proveedor_telefono,
        c.numero_documento as compra_numero_documento
      from cuentas_por_pagar cxp
      inner join proveedores pr
        on pr.id_empresa = cxp.id_empresa
       and pr.id_proveedor = cxp.id_proveedor
      left join compras c
        on c.id_empresa = cxp.id_empresa
       and c.id_compra = cxp.id_compra
      where cxp.id_empresa = $1
        and cxp.id_cuenta_por_pagar = $2
        and cxp.id_sucursal = $3
      limit 1
    `,
    [auth.id_empresa, idCuentaPorPagar, scope.id_sucursal]
  );

  const account = accountResult.rows[0];

  if (!account) {
    throw HttpError.notFound("Cuenta por pagar no encontrada");
  }

  const movementResult = await db.query(
    `
      select
        mov.*,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from cuentas_por_pagar_movimientos mov
      inner join usuarios u
        on u.id_empresa = mov.id_empresa
       and u.id_usuario = mov.id_usuario
      where mov.id_empresa = $1
        and mov.id_cuenta_por_pagar = $2
      order by mov.fecha_movimiento desc, mov.id_cxp_movimiento desc
    `,
    [auth.id_empresa, idCuentaPorPagar]
  );

  return {
    cuenta: normalizeAccountRow(account),
    movimientos: movementResult.rows.map(normalizeMovementRow),
  };
};

const getClosingSummary = async (
  db,
  { idEmpresa, idSucursal = null, area, fechaDesde, fechaHasta }
) => {
  const params = [idEmpresa, fechaDesde, fechaHasta, idSucursal];

  if (area === "VENTAS") {
    const result = await db.query(
      `
        select
          count(*)::int as documentos,
          coalesce(sum(greatest(coalesce(total, 0) - coalesce(monto_revertido, 0), 0)), 0) as total
        from ventas
        where id_empresa = $1
          and fecha_venta::date >= $2::date
          and fecha_venta::date <= $3::date
          and ($4::bigint is null or id_sucursal = $4)
      `,
      params
    );

    const row = result.rows[0] || {};

    return {
      documentos: toInteger(row.documentos),
      total: roundMoney(row.total),
    };
  }

  if (area === "COMPRAS") {
    const result = await db.query(
      `
        select
          count(*)::int as documentos,
          coalesce(sum(greatest(coalesce(total, 0) - coalesce(monto_revertido, 0), 0)), 0) as total
        from compras
        where id_empresa = $1
          and fecha_compra::date >= $2::date
          and fecha_compra::date <= $3::date
          and ($4::bigint is null or id_sucursal = $4)
      `,
      params
    );

    const row = result.rows[0] || {};

    return {
      documentos: toInteger(row.documentos),
      total: roundMoney(row.total),
    };
  }

  const [cxcResult, cxpResult, notesResult] = await Promise.all([
    db.query(
      `
        select
          count(*)::int as cuentas,
          coalesce(sum(saldo_actual), 0) as saldo
        from cuentas_por_cobrar
        where id_empresa = $1
          and fecha_documento >= $2::date
          and fecha_documento <= $3::date
          and ($4::bigint is null or id_sucursal = $4)
      `,
      params
    ),
    db.query(
      `
        select
          count(*)::int as cuentas,
          coalesce(sum(saldo_actual), 0) as saldo
        from cuentas_por_pagar
        where id_empresa = $1
          and fecha_documento >= $2::date
          and fecha_documento <= $3::date
          and ($4::bigint is null or id_sucursal = $4)
      `,
      params
    ),
    db.query(
      `
        select
          count(*)::int as notas,
          coalesce(sum(monto), 0) as monto
        from notas_formales
        where id_empresa = $1
          and fecha_emision >= $2::date
          and fecha_emision <= $3::date
          and ($4::bigint is null or id_sucursal = $4)
      `,
      params
    ),
  ]);

  return {
    cuentas_por_cobrar: {
      cuentas: toInteger(cxcResult.rows[0]?.cuentas),
      saldo: roundMoney(cxcResult.rows[0]?.saldo),
    },
    cuentas_por_pagar: {
      cuentas: toInteger(cxpResult.rows[0]?.cuentas),
      saldo: roundMoney(cxpResult.rows[0]?.saldo),
    },
    notas: {
      cantidad: toInteger(notesResult.rows[0]?.notas),
      monto: roundMoney(notesResult.rows[0]?.monto),
    },
  };
};

export const getOverview = async ({ auth, scope }) => {
  const [context, overviewResult] = await Promise.all([
    getFinanceOverviewContext({ auth, scope }),
    pool.query(
      `
        with cxc as (
          select
            count(*) filter (where coalesce(saldo_actual, 0) > 0)::int as cxc_abiertas,
            coalesce(sum(saldo_actual) filter (where coalesce(saldo_actual, 0) > 0), 0) as cxc_total,
            count(*) filter (
              where coalesce(saldo_actual, 0) > 0
                and fecha_vencimiento is not null
                and fecha_vencimiento < current_date
            )::int as cxc_vencidas,
            coalesce(sum(saldo_actual) filter (
              where coalesce(saldo_actual, 0) > 0
                and fecha_vencimiento is not null
                and fecha_vencimiento < current_date
            ), 0) as cxc_vencido_total
          from cuentas_por_cobrar
          where id_empresa = $1
            and id_sucursal = $2
        ),
        cxp as (
          select
            count(*) filter (where coalesce(saldo_actual, 0) > 0)::int as cxp_abiertas,
            coalesce(sum(saldo_actual) filter (where coalesce(saldo_actual, 0) > 0), 0) as cxp_total,
            count(*) filter (
              where coalesce(saldo_actual, 0) > 0
                and fecha_vencimiento is not null
                and fecha_vencimiento < current_date
            )::int as cxp_vencidas,
            coalesce(sum(saldo_actual) filter (
              where coalesce(saldo_actual, 0) > 0
                and fecha_vencimiento is not null
                and fecha_vencimiento < current_date
            ), 0) as cxp_vencido_total
          from cuentas_por_pagar
          where id_empresa = $1
            and id_sucursal = $2
        ),
        notas as (
          select
            count(*)::int as notas_mes,
            coalesce(sum(monto), 0) as notas_monto_mes
          from notas_formales
          where id_empresa = $1
            and id_sucursal = $2
            and date_trunc('month', fecha_emision::timestamp) = date_trunc('month', current_date::timestamp)
        ),
        cierres as (
          select count(*)::int as cierres_mes
          from cierres_periodo
          where id_empresa = $1
            and (id_sucursal is null or id_sucursal = $2)
            and date_trunc('month', cerrado_en) = date_trunc('month', now())
        )
        select *
        from cxc
        cross join cxp
        cross join notas
        cross join cierres
      `,
      [auth.id_empresa, scope.id_sucursal]
    ),
  ]);

  return {
    ...context,
    resumen: normalizeOverviewRow(overviewResult.rows[0] || {}),
  };
};

export const listCuentasPorCobrar = async ({ auth, scope, query }) => {
  const filters = ["cxc.id_empresa = $1", "cxc.id_sucursal = $2"];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (query?.search) {
    filters.push(
      `(coalesce(cxc.numero_documento, '') ilike $${index} or coalesce(cl.nombre, '') ilike $${index})`
    );
    params.push(`%${normalizeText(query.search)}%`);
    index += 1;
  }

  if (query?.estado) {
    filters.push(`${ACCOUNT_STATE_SQL("cxc")} = $${index}`);
    params.push(normalizeState(query.estado));
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 30, 100));
  params.push(limit);

  const result = await pool.query(
    `
      select
        cxc.*,
        ${ACCOUNT_STATE_SQL("cxc")} as estado_resuelto,
        cl.nombre as cliente_nombre,
        v.numero_comprobante as venta_numero_comprobante
      from cuentas_por_cobrar cxc
      inner join clientes cl
        on cl.id_empresa = cxc.id_empresa
       and cl.id_cliente = cxc.id_cliente
      left join ventas v
        on v.id_empresa = cxc.id_empresa
       and v.id_venta = cxc.id_venta
      where ${filters.join(" and ")}
      order by
        case when cxc.fecha_vencimiento is null then 1 else 0 end asc,
        cxc.fecha_vencimiento asc,
        cxc.id_cuenta_por_cobrar desc
      limit $${index}
    `,
    params
  );

  return result.rows.map(normalizeAccountRow);
};

export const getCuentaPorCobrarById = async ({
  auth,
  scope,
  idCuentaPorCobrar,
}) => getCxcByIdInternal(pool, { auth, scope, idCuentaPorCobrar });

export const createCobroCuentaPorCobrar = async ({
  auth,
  scope,
  idCuentaPorCobrar,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (db) => {
      const monto = getMoney(body?.monto, "monto");
      const metodoPago = getPaymentMethod(body?.metodo_pago || "TRANSFERENCIA");
      const fechaMovimiento = toIsoDate(body?.fecha_movimiento) || new Date();

      await assertPeriodOpen(db, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "FINANZAS",
        fechaOperacion: fechaMovimiento,
      });

      let idCajaSesion = null;

      if (isCashPaymentMethod(metodoPago)) {
        idCajaSesion = await ensureCashSessionForFinance(db, {
          auth,
          scope,
          categoria: "COBRO_CXC",
          monto,
          descripcion:
            normalizeText(body?.observacion) ||
            `Cobro cuenta por cobrar ${idCuentaPorCobrar}`,
          referenciaTipo: "CXC",
          referenciaId: idCuentaPorCobrar,
          tipo: "INGRESO",
        });
      }

      const detailBefore = await getCxcByIdInternal(db, {
        auth,
        scope,
        idCuentaPorCobrar,
      });

      await applyCuentaPorCobrarMovement(db, {
        auth,
        scope,
        idCuentaPorCobrar,
        tipoMovimiento: "COBRO",
        monto,
        saldoDelta: -monto,
        metodoPago,
        referenciaTipo: "COBRO_CXC",
        referenciaId: idCuentaPorCobrar,
        fechaMovimiento,
        observacion: normalizeText(body?.observacion) || null,
        idCajaSesion,
        actorId: auth.id_usuario,
      });

      const detail = await getCxcByIdInternal(db, {
        auth,
        scope,
        idCuentaPorCobrar,
      });

      await writeAuditEvent(db, {
        auth,
        scope,
        requestMeta,
        modulo: "FINANZAS",
        entidad: "CXC_COBRO",
        entidadId: idCuentaPorCobrar,
        accion: "CREATE",
        antes: detailBefore.cuenta,
        despues: detail.cuenta,
      });

      return detail;
    },
    { auth }
  );

export const listCuentasPorPagar = async ({ auth, scope, query }) => {
  const filters = ["cxp.id_empresa = $1", "cxp.id_sucursal = $2"];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (query?.search) {
    filters.push(
      `(coalesce(cxp.numero_documento, '') ilike $${index} or coalesce(pr.nombre, '') ilike $${index})`
    );
    params.push(`%${normalizeText(query.search)}%`);
    index += 1;
  }

  if (query?.estado) {
    filters.push(`${ACCOUNT_STATE_SQL("cxp")} = $${index}`);
    params.push(normalizeState(query.estado));
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 30, 100));
  params.push(limit);

  const result = await pool.query(
    `
      select
        cxp.*,
        ${ACCOUNT_STATE_SQL("cxp")} as estado_resuelto,
        pr.nombre as proveedor_nombre,
        c.numero_documento as compra_numero_documento
      from cuentas_por_pagar cxp
      inner join proveedores pr
        on pr.id_empresa = cxp.id_empresa
       and pr.id_proveedor = cxp.id_proveedor
      left join compras c
        on c.id_empresa = cxp.id_empresa
       and c.id_compra = cxp.id_compra
      where ${filters.join(" and ")}
      order by
        case when cxp.fecha_vencimiento is null then 1 else 0 end asc,
        cxp.fecha_vencimiento asc,
        cxp.id_cuenta_por_pagar desc
      limit $${index}
    `,
    params
  );

  return result.rows.map(normalizeAccountRow);
};

export const getCuentaPorPagarById = async ({
  auth,
  scope,
  idCuentaPorPagar,
}) => getCxpByIdInternal(pool, { auth, scope, idCuentaPorPagar });

export const createPagoCuentaPorPagar = async ({
  auth,
  scope,
  idCuentaPorPagar,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (db) => {
      const monto = getMoney(body?.monto, "monto");
      const metodoPago = getPaymentMethod(body?.metodo_pago || "TRANSFERENCIA");
      const fechaMovimiento = toIsoDate(body?.fecha_movimiento) || new Date();

      await assertPeriodOpen(db, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "FINANZAS",
        fechaOperacion: fechaMovimiento,
      });

      let idCajaSesion = null;

      if (isCashPaymentMethod(metodoPago)) {
        idCajaSesion = await ensureCashSessionForFinance(db, {
          auth,
          scope,
          categoria: "PAGO_CXP",
          monto,
          descripcion:
            normalizeText(body?.observacion) ||
            `Pago cuenta por pagar ${idCuentaPorPagar}`,
          referenciaTipo: "CXP",
          referenciaId: idCuentaPorPagar,
          tipo: "EGRESO",
        });
      }

      const detailBefore = await getCxpByIdInternal(db, {
        auth,
        scope,
        idCuentaPorPagar,
      });

      await applyCuentaPorPagarMovement(db, {
        auth,
        scope,
        idCuentaPorPagar,
        tipoMovimiento: "PAGO",
        monto,
        saldoDelta: -monto,
        metodoPago,
        referenciaTipo: "PAGO_CXP",
        referenciaId: idCuentaPorPagar,
        fechaMovimiento,
        observacion: normalizeText(body?.observacion) || null,
        idCajaSesion,
        actorId: auth.id_usuario,
      });

      const detail = await getCxpByIdInternal(db, {
        auth,
        scope,
        idCuentaPorPagar,
      });

      await writeAuditEvent(db, {
        auth,
        scope,
        requestMeta,
        modulo: "FINANZAS",
        entidad: "CXP_PAGO",
        entidadId: idCuentaPorPagar,
        accion: "CREATE",
        antes: detailBefore.cuenta,
        despues: detail.cuenta,
      });

      return detail;
    },
    { auth }
  );

export const listNotasFormales = async ({ auth, scope, query }) => {
  const filters = [
    "nf.id_empresa = $1",
    "(nf.id_sucursal = $2 or nf.id_sucursal is null)",
  ];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (query?.destino) {
    filters.push(`upper(nf.destino) = $${index}`);
    params.push(normalizeState(query.destino));
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 30, 100));
  params.push(limit);

  const result = await pool.query(
    `
      select
        nf.*,
        cl.nombre as cliente_nombre,
        pr.nombre as proveedor_nombre
      from notas_formales nf
      left join clientes cl
        on cl.id_empresa = nf.id_empresa
       and cl.id_cliente = nf.id_cliente
      left join proveedores pr
        on pr.id_empresa = nf.id_empresa
       and pr.id_proveedor = nf.id_proveedor
      where ${filters.join(" and ")}
      order by nf.fecha_emision desc, nf.id_nota_formal desc
      limit $${index}
    `,
    params
  );

  return result.rows.map(normalizeNoteRow);
};

export const createNotaFormal = async ({
  auth,
  scope,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (db) => {
      const destino = normalizeState(body?.destino);
      const tipoNota = normalizeState(body?.tipo_nota);
      const fechaEmision = toIsoDate(body?.fecha_emision) || new Date();
      const motivo = normalizeText(body?.motivo);
      const observaciones = normalizeText(body?.observaciones) || null;
      const monto = getMoney(body?.monto, "monto");

      if (!ALLOWED_NOTE_DESTINATIONS.has(destino)) {
        throw HttpError.badRequest("destino de nota invalido", {
          destinos_permitidos: [...ALLOWED_NOTE_DESTINATIONS],
        });
      }

      if (!ALLOWED_NOTE_TYPES.has(tipoNota)) {
        throw HttpError.badRequest("tipo_nota invalido", {
          tipos_permitidos: [...ALLOWED_NOTE_TYPES],
        });
      }

      if (!motivo) {
        throw HttpError.badRequest("motivo es requerido");
      }

      await assertPeriodOpen(db, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "FINANZAS",
        fechaOperacion: fechaEmision,
      });

      const numeroDocumento =
        normalizeText(body?.numero_documento) ||
        (await getNextNoteDocumentNumber(db, {
          auth,
          scope,
          destino,
          tipoNota,
        }));

      let noteValues = {
        id_cliente: null,
        id_proveedor: null,
        id_cuenta_por_cobrar: null,
        id_cuenta_por_pagar: null,
        id_venta: null,
        id_compra: null,
      };

      if (destino === "CXC") {
        const idCuentaPorCobrar = Number(body?.id_cuenta_por_cobrar);

        if (!Number.isInteger(idCuentaPorCobrar) || idCuentaPorCobrar <= 0) {
          throw HttpError.badRequest("id_cuenta_por_cobrar es requerido");
        }

        const detail = await getCxcByIdInternal(db, {
          auth,
          scope,
          idCuentaPorCobrar,
        });

        await applyCuentaPorCobrarMovement(db, {
          auth,
          scope,
          idCuentaPorCobrar,
          tipoMovimiento:
            tipoNota === "CREDITO" ? "NOTA_CREDITO" : "NOTA_DEBITO",
          monto,
          saldoDelta: tipoNota === "CREDITO" ? -monto : monto,
          metodoPago: "AJUSTE",
          referenciaTipo: "NOTA_FORMAL",
          referenciaId: idCuentaPorCobrar,
          fechaMovimiento: fechaEmision,
          observacion: motivo,
          actorId: auth.id_usuario,
        });

        noteValues = {
          id_cliente: Number(detail.cuenta.id_cliente),
          id_proveedor: null,
          id_cuenta_por_cobrar: idCuentaPorCobrar,
          id_cuenta_por_pagar: null,
          id_venta: detail.cuenta.id_venta ? Number(detail.cuenta.id_venta) : null,
          id_compra: null,
        };
      } else {
        const idCuentaPorPagar = Number(body?.id_cuenta_por_pagar);

        if (!Number.isInteger(idCuentaPorPagar) || idCuentaPorPagar <= 0) {
          throw HttpError.badRequest("id_cuenta_por_pagar es requerido");
        }

        const detail = await getCxpByIdInternal(db, {
          auth,
          scope,
          idCuentaPorPagar,
        });

        await applyCuentaPorPagarMovement(db, {
          auth,
          scope,
          idCuentaPorPagar,
          tipoMovimiento:
            tipoNota === "CREDITO" ? "NOTA_CREDITO" : "NOTA_DEBITO",
          monto,
          saldoDelta: tipoNota === "CREDITO" ? -monto : monto,
          metodoPago: "AJUSTE",
          referenciaTipo: "NOTA_FORMAL",
          referenciaId: idCuentaPorPagar,
          fechaMovimiento: fechaEmision,
          observacion: motivo,
          actorId: auth.id_usuario,
        });

        noteValues = {
          id_cliente: null,
          id_proveedor: Number(detail.cuenta.id_proveedor),
          id_cuenta_por_cobrar: null,
          id_cuenta_por_pagar: idCuentaPorPagar,
          id_venta: null,
          id_compra: detail.cuenta.id_compra ? Number(detail.cuenta.id_compra) : null,
        };
      }

      const insertResult = await db.query(
        `
          insert into notas_formales (
            id_empresa,
            id_sucursal,
            id_usuario,
            destino,
            tipo_nota,
            numero_documento,
            id_cliente,
            id_proveedor,
            id_cuenta_por_cobrar,
            id_cuenta_por_pagar,
            id_venta,
            id_compra,
            monto,
            fecha_emision,
            motivo,
            observaciones,
            estado,
            created_by,
            updated_by
          )
          values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15,$16,'EMITIDA',$3,$3
          )
          returning *
        `,
        [
          auth.id_empresa,
          scope.id_sucursal,
          auth.id_usuario,
          destino,
          tipoNota,
          numeroDocumento,
          noteValues.id_cliente,
          noteValues.id_proveedor,
          noteValues.id_cuenta_por_cobrar,
          noteValues.id_cuenta_por_pagar,
          noteValues.id_venta,
          noteValues.id_compra,
          monto,
          fechaEmision,
          motivo,
          observaciones,
        ]
      );

      const note = insertResult.rows[0];

      await writeAuditEvent(db, {
        auth,
        scope,
        requestMeta,
        modulo: "FINANZAS",
        entidad: "NOTA_FORMAL",
        entidadId: note.id_nota_formal,
        accion: "CREATE",
        despues: note,
      });

      return normalizeNoteRow(note);
    },
    { auth }
  );

export const listCierresPeriodo = async ({ auth, scope, query }) => {
  const filters = [
    "cp.id_empresa = $1",
    "(cp.id_sucursal is null or cp.id_sucursal = $2)",
  ];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (query?.area) {
    filters.push(`upper(cp.area) = $${index}`);
    params.push(getClosureArea(query.area));
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 20, 100));
  params.push(limit);

  const result = await pool.query(
    `
      select
        cp.*,
        u.username as cerrado_por_username,
        concat(u.nombre, ' ', u.apellido) as cerrado_por_nombre
      from cierres_periodo cp
      inner join usuarios u
        on u.id_empresa = cp.id_empresa
       and u.id_usuario = cp.cerrado_por
      where ${filters.join(" and ")}
      order by cp.fecha_hasta desc, cp.id_cierre_periodo desc
      limit $${index}
    `,
    params
  );

  return result.rows;
};

export const createCierrePeriodo = async ({
  auth,
  scope,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (db) => {
      const area = getClosureArea(body?.area);
      const fechaDesde = toIsoDate(body?.fecha_desde);
      const fechaHasta = toIsoDate(body?.fecha_hasta);
      const requestedBranchId = body?.id_sucursal ? Number(body.id_sucursal) : null;
      const isCompanyWide =
        body?.alcance === "EMPRESA" ||
        body?.empresa_completa === true ||
        requestedBranchId == null;
      const closureBranchId = isCompanyWide ? null : requestedBranchId;

      if (!fechaDesde || !fechaHasta) {
        throw HttpError.badRequest("fecha_desde y fecha_hasta son requeridas");
      }

      if (fechaDesde > fechaHasta) {
        throw HttpError.badRequest("fecha_desde no puede ser mayor que fecha_hasta");
      }

      if (
        closureBranchId != null &&
        (!Number.isInteger(closureBranchId) || closureBranchId <= 0)
      ) {
        throw HttpError.badRequest("id_sucursal invalido para el cierre");
      }

      const overlapResult = await db.query(
        `
          select id_cierre_periodo
          from cierres_periodo
          where id_empresa = $1
            and upper(area) = $2
            and coalesce(id_sucursal, 0) = coalesce($3, 0)
            and daterange(fecha_desde, fecha_hasta, '[]') && daterange($4::date, $5::date, '[]')
          limit 1
        `,
        [auth.id_empresa, area, closureBranchId, fechaDesde, fechaHasta]
      );

      if (overlapResult.rows[0]) {
        throw HttpError.conflict(
          "Ya existe un cierre que se traslapa con el rango solicitado"
        );
      }

      const resumen = await getClosingSummary(db, {
        idEmpresa: auth.id_empresa,
        idSucursal: closureBranchId,
        area,
        fechaDesde,
        fechaHasta,
      });

      const insertResult = await db.query(
        `
          insert into cierres_periodo (
            id_empresa,
            id_sucursal,
            area,
            fecha_desde,
            fecha_hasta,
            estado,
            resumen,
            observaciones,
            cerrado_por,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4::date,$5::date,'CERRADO',$6::jsonb,$7,$8,$8,$8)
          returning *
        `,
        [
          auth.id_empresa,
          closureBranchId,
          area,
          fechaDesde,
          fechaHasta,
          JSON.stringify(resumen),
          normalizeText(body?.observaciones) || null,
          auth.id_usuario,
        ]
      );

      const cierre = insertResult.rows[0];

      await writeAuditEvent(db, {
        auth,
        scope,
        requestMeta,
        modulo: "FINANZAS",
        entidad: "CIERRE_PERIODO",
        entidadId: cierre.id_cierre_periodo,
        accion: "CREATE",
        despues: cierre,
      });

      return cierre;
    },
    { auth }
  );
