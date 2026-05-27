import { HttpError } from "../http/http-error.js";

const CASH_PAYMENT_METHODS = new Set(["EFECTIVO"]);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const normalizeText = (value) => String(value || "").trim();
const normalizeState = (value) => String(value || "").trim().toUpperCase();
const normalizePaymentMethod = (value) =>
  String(value || "").trim().toUpperCase();

const toIsoDate = (value) => {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();

  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
};

const shiftIsoDate = (isoDate, offsetDays) => {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(offsetDays || 0));
  return parsed.toISOString().slice(0, 10);
};

const getAccountState = ({ saldoActual, montoOriginal, fechaVencimiento }) => {
  const saldo = roundMoney(saldoActual);
  const total = roundMoney(montoOriginal);
  const dueDate = toIsoDate(fechaVencimiento);
  const today = new Date().toISOString().slice(0, 10);

  if (saldo <= 0) {
    return "PAGADA";
  }

  if (dueDate && dueDate < today) {
    return "VENCIDA";
  }

  if (saldo < total) {
    return "PARCIAL";
  }

  return "PENDIENTE";
};

const insertCxcMovement = async (
  db,
  {
    idEmpresa,
    idCuentaPorCobrar,
    idSucursal,
    idUsuario,
    tipoMovimiento,
    metodoPago = null,
    monto,
    saldoAnterior,
    saldoNuevo,
    referenciaTipo = null,
    referenciaId = null,
    fechaMovimiento = null,
    observacion = null,
    idCajaSesion = null,
    actorId = null,
  }
) => {
  await db.query(
    `
      insert into cuentas_por_cobrar_movimientos (
        id_empresa,
        id_cuenta_por_cobrar,
        id_sucursal,
        id_usuario,
        tipo_movimiento,
        metodo_pago,
        monto,
        saldo_anterior,
        saldo_nuevo,
        referencia_tipo,
        referencia_id,
        fecha_movimiento,
        observacion,
        id_caja_sesion,
        created_by,
        updated_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::date, current_date),$13,$14,$15,$15
      )
    `,
    [
      idEmpresa,
      idCuentaPorCobrar,
      idSucursal,
      idUsuario,
      normalizeState(tipoMovimiento),
      metodoPago ? normalizePaymentMethod(metodoPago) : null,
      roundMoney(monto),
      roundMoney(saldoAnterior),
      roundMoney(saldoNuevo),
      referenciaTipo ? normalizeState(referenciaTipo) : null,
      referenciaId != null ? Number(referenciaId) : null,
      toIsoDate(fechaMovimiento),
      normalizeText(observacion) || null,
      idCajaSesion != null ? Number(idCajaSesion) : null,
      actorId != null ? Number(actorId) : null,
    ]
  );
};

const insertCxpMovement = async (
  db,
  {
    idEmpresa,
    idCuentaPorPagar,
    idSucursal,
    idUsuario,
    tipoMovimiento,
    metodoPago = null,
    monto,
    saldoAnterior,
    saldoNuevo,
    referenciaTipo = null,
    referenciaId = null,
    fechaMovimiento = null,
    observacion = null,
    idCajaSesion = null,
    actorId = null,
  }
) => {
  await db.query(
    `
      insert into cuentas_por_pagar_movimientos (
        id_empresa,
        id_cuenta_por_pagar,
        id_sucursal,
        id_usuario,
        tipo_movimiento,
        metodo_pago,
        monto,
        saldo_anterior,
        saldo_nuevo,
        referencia_tipo,
        referencia_id,
        fecha_movimiento,
        observacion,
        id_caja_sesion,
        created_by,
        updated_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::date, current_date),$13,$14,$15,$15
      )
    `,
    [
      idEmpresa,
      idCuentaPorPagar,
      idSucursal,
      idUsuario,
      normalizeState(tipoMovimiento),
      metodoPago ? normalizePaymentMethod(metodoPago) : null,
      roundMoney(monto),
      roundMoney(saldoAnterior),
      roundMoney(saldoNuevo),
      referenciaTipo ? normalizeState(referenciaTipo) : null,
      referenciaId != null ? Number(referenciaId) : null,
      toIsoDate(fechaMovimiento),
      normalizeText(observacion) || null,
      idCajaSesion != null ? Number(idCajaSesion) : null,
      actorId != null ? Number(actorId) : null,
    ]
  );
};

export const hasModuleEnabled = (auth, moduleCode) =>
  (Array.isArray(auth?.modulos) ? auth.modulos : [])
    .map((item) => String(item || "").trim().toUpperCase())
    .includes(String(moduleCode || "").trim().toUpperCase());

export const ensureFinanceModuleEnabled = (auth) => {
  if (!hasModuleEnabled(auth, "FINANZAS")) {
    throw HttpError.forbidden(
      "El modulo FINANZAS debe estar habilitado para registrar operaciones a credito"
    );
  }
};

export const isCreditSale = ({ tipo_venta, metodo_pago }) =>
  normalizeState(tipo_venta) === "CREDITO" ||
  normalizeState(metodo_pago) === "CREDITO";

export const isCreditPurchase = ({ condicion_pago }) =>
  normalizeState(condicion_pago) === "CREDITO";

export const resolveCreditDays = (value) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
};

export const resolveDueDate = ({
  baseDate,
  providedDueDate = null,
  creditDays = 0,
}) => {
  const fallbackDate =
    toIsoDate(baseDate) || new Date().toISOString().slice(0, 10);
  const dueDate = toIsoDate(providedDueDate);

  if (dueDate) {
    return dueDate;
  }

  return shiftIsoDate(fallbackDate, resolveCreditDays(creditDays));
};

export const ensureCashSessionForFinance = async (
  db,
  { auth, scope, categoria, monto, descripcion, referenciaTipo, referenciaId, tipo }
) => {
  const sessionResult = await db.query(
    `
      select id_caja_sesion
      from caja_sesiones
      where id_empresa = $1
        and id_usuario = $2
        and id_sucursal = $3
        and estado = 'ABIERTA'
      order by fecha_apertura desc
      limit 1
    `,
    [auth.id_empresa, auth.id_usuario, scope.id_sucursal]
  );

  const session = sessionResult.rows[0];

  if (!session) {
    throw HttpError.badRequest(
      "Debes abrir una caja en la sucursal activa para registrar movimientos en efectivo"
    );
  }

  await db.query(
    `
      insert into caja_movimientos (
        id_empresa,
        id_caja_sesion,
        id_sucursal,
        id_usuario,
        tipo,
        categoria,
        monto,
        descripcion,
        referencia_tipo,
        referencia_id,
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$4,$4)
    `,
    [
      auth.id_empresa,
      Number(session.id_caja_sesion),
      scope.id_sucursal,
      auth.id_usuario,
      normalizeState(tipo),
      normalizeState(categoria),
      roundMoney(monto),
      normalizeText(descripcion) || null,
      normalizeState(referenciaTipo),
      Number(referenciaId),
    ]
  );

  return Number(session.id_caja_sesion);
};

export const upsertCuentaPorCobrarFromVenta = async (
  db,
  { auth, ventaId, actorId = null, movementType = null, movementDate = null }
) => {
  const ventaResult = await db.query(
    `
      select
        v.id_venta,
        v.id_empresa,
        v.id_sucursal,
        v.id_cliente,
        v.numero_comprobante,
        v.tipo_comprobante,
        v.fecha_venta::date as fecha_documento,
        v.fecha_vencimiento,
        v.total,
        v.saldo_pendiente,
        v.tipo_venta,
        v.metodo_pago
      from ventas v
      where v.id_empresa = $1
        and v.id_venta = $2
      limit 1
    `,
    [auth.id_empresa, ventaId]
  );

  const venta = ventaResult.rows[0];

  if (!venta || !isCreditSale(venta) || !venta.id_cliente) {
    return null;
  }

  const saldoDeseado = roundMoney(venta.saldo_pendiente);
  const dueDate = resolveDueDate({
    baseDate: venta.fecha_documento,
    providedDueDate: venta.fecha_vencimiento,
    creditDays: 0,
  });

  const accountResult = await db.query(
    `
      select *
      from cuentas_por_cobrar
      where id_empresa = $1
        and id_venta = $2
      limit 1
      for update
    `,
    [auth.id_empresa, ventaId]
  );

  const existing = accountResult.rows[0];

  if (!existing) {
    const insertResult = await db.query(
      `
        insert into cuentas_por_cobrar (
          id_empresa,
          id_sucursal,
          id_cliente,
          id_venta,
          numero_documento,
          tipo_documento,
          estado,
          fecha_documento,
          fecha_vencimiento,
          monto_original,
          saldo_actual,
          observaciones,
          created_by,
          updated_by
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$13
        )
        returning *
      `,
      [
        auth.id_empresa,
        Number(venta.id_sucursal),
        Number(venta.id_cliente),
        Number(venta.id_venta),
        venta.numero_comprobante,
        "VENTA_CREDITO",
        getAccountState({
          saldoActual: saldoDeseado,
          montoOriginal: venta.total,
          fechaVencimiento: dueDate,
        }),
        venta.fecha_documento,
        dueDate,
        roundMoney(venta.total),
        saldoDeseado,
        `Generada desde venta ${venta.numero_comprobante}`,
        actorId != null ? Number(actorId) : null,
      ]
    );

    const account = insertResult.rows[0];

    if (saldoDeseado > 0) {
      await insertCxcMovement(db, {
        idEmpresa: auth.id_empresa,
        idCuentaPorCobrar: account.id_cuenta_por_cobrar,
        idSucursal: venta.id_sucursal,
        idUsuario: auth.id_usuario,
        tipoMovimiento: "EMISION",
        monto: saldoDeseado,
        saldoAnterior: 0,
        saldoNuevo: saldoDeseado,
        referenciaTipo: "VENTA",
        referenciaId: ventaId,
        fechaMovimiento: venta.fecha_documento,
        observacion: `Creacion de cuenta por cobrar para ${venta.numero_comprobante}`,
        actorId,
      });
    }

    return account;
  }

  const saldoAnterior = roundMoney(existing.saldo_actual);

  await db.query(
    `
      update cuentas_por_cobrar
      set
        id_sucursal = $1,
        id_cliente = $2,
        numero_documento = $3,
        tipo_documento = 'VENTA_CREDITO',
        fecha_documento = $4::date,
        fecha_vencimiento = $5::date,
        estado = $6,
        saldo_actual = $7,
        updated_by = $8
      where id_cuenta_por_cobrar = $9
    `,
    [
      Number(venta.id_sucursal),
      Number(venta.id_cliente),
      venta.numero_comprobante,
      venta.fecha_documento,
      dueDate,
      getAccountState({
        saldoActual: saldoDeseado,
        montoOriginal: existing.monto_original,
        fechaVencimiento: dueDate,
      }),
      saldoDeseado,
      actorId != null ? Number(actorId) : null,
      Number(existing.id_cuenta_por_cobrar),
    ]
  );

  if (movementType && roundMoney(saldoDeseado) !== roundMoney(saldoAnterior)) {
    await insertCxcMovement(db, {
      idEmpresa: auth.id_empresa,
      idCuentaPorCobrar: existing.id_cuenta_por_cobrar,
      idSucursal: venta.id_sucursal,
      idUsuario: auth.id_usuario,
      tipoMovimiento: movementType,
      monto: Math.abs(saldoDeseado - saldoAnterior),
      saldoAnterior,
      saldoNuevo: saldoDeseado,
      referenciaTipo: "VENTA",
      referenciaId: ventaId,
      fechaMovimiento: movementDate || new Date(),
      observacion: `Sincronizacion por venta ${venta.numero_comprobante}`,
      actorId,
    });
  }

  return {
    ...existing,
    saldo_actual: saldoDeseado,
  };
};

export const upsertCuentaPorPagarFromCompra = async (
  db,
  { auth, compraId, actorId = null, movementType = null, movementDate = null }
) => {
  const compraResult = await db.query(
    `
      select
        c.id_compra,
        c.id_empresa,
        c.id_sucursal,
        c.id_proveedor,
        c.numero_documento,
        c.tipo_documento,
        c.fecha_compra::date as fecha_documento,
        c.fecha_vencimiento,
        c.total,
        c.saldo_pendiente,
        c.condicion_pago
      from compras c
      where c.id_empresa = $1
        and c.id_compra = $2
      limit 1
    `,
    [auth.id_empresa, compraId]
  );

  const compra = compraResult.rows[0];

  if (!compra || !isCreditPurchase(compra)) {
    return null;
  }

  const saldoDeseado = roundMoney(compra.saldo_pendiente);
  const dueDate = resolveDueDate({
    baseDate: compra.fecha_documento,
    providedDueDate: compra.fecha_vencimiento,
    creditDays: 0,
  });

  const accountResult = await db.query(
    `
      select *
      from cuentas_por_pagar
      where id_empresa = $1
        and id_compra = $2
      limit 1
      for update
    `,
    [auth.id_empresa, compraId]
  );

  const existing = accountResult.rows[0];

  if (!existing) {
    const insertResult = await db.query(
      `
        insert into cuentas_por_pagar (
          id_empresa,
          id_sucursal,
          id_proveedor,
          id_compra,
          numero_documento,
          tipo_documento,
          estado,
          fecha_documento,
          fecha_vencimiento,
          monto_original,
          saldo_actual,
          observaciones,
          created_by,
          updated_by
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$13
        )
        returning *
      `,
      [
        auth.id_empresa,
        Number(compra.id_sucursal),
        Number(compra.id_proveedor),
        Number(compra.id_compra),
        compra.numero_documento || `COMPRA-${compra.id_compra}`,
        "COMPRA_CREDITO",
        getAccountState({
          saldoActual: saldoDeseado,
          montoOriginal: compra.total,
          fechaVencimiento: dueDate,
        }),
        compra.fecha_documento,
        dueDate,
        roundMoney(compra.total),
        saldoDeseado,
        `Generada desde compra ${compra.numero_documento || compra.id_compra}`,
        actorId != null ? Number(actorId) : null,
      ]
    );

    const account = insertResult.rows[0];

    if (saldoDeseado > 0) {
      await insertCxpMovement(db, {
        idEmpresa: auth.id_empresa,
        idCuentaPorPagar: account.id_cuenta_por_pagar,
        idSucursal: compra.id_sucursal,
        idUsuario: auth.id_usuario,
        tipoMovimiento: "EMISION",
        monto: saldoDeseado,
        saldoAnterior: 0,
        saldoNuevo: saldoDeseado,
        referenciaTipo: "COMPRA",
        referenciaId: compraId,
        fechaMovimiento: compra.fecha_documento,
        observacion: `Creacion de cuenta por pagar para ${compra.numero_documento || compra.id_compra}`,
        actorId,
      });
    }

    return account;
  }

  const saldoAnterior = roundMoney(existing.saldo_actual);

  await db.query(
    `
      update cuentas_por_pagar
      set
        id_sucursal = $1,
        id_proveedor = $2,
        numero_documento = $3,
        tipo_documento = 'COMPRA_CREDITO',
        fecha_documento = $4::date,
        fecha_vencimiento = $5::date,
        estado = $6,
        saldo_actual = $7,
        updated_by = $8
      where id_cuenta_por_pagar = $9
    `,
    [
      Number(compra.id_sucursal),
      Number(compra.id_proveedor),
      compra.numero_documento || `COMPRA-${compra.id_compra}`,
      compra.fecha_documento,
      dueDate,
      getAccountState({
        saldoActual: saldoDeseado,
        montoOriginal: existing.monto_original,
        fechaVencimiento: dueDate,
      }),
      saldoDeseado,
      actorId != null ? Number(actorId) : null,
      Number(existing.id_cuenta_por_pagar),
    ]
  );

  if (movementType && roundMoney(saldoDeseado) !== roundMoney(saldoAnterior)) {
    await insertCxpMovement(db, {
      idEmpresa: auth.id_empresa,
      idCuentaPorPagar: existing.id_cuenta_por_pagar,
      idSucursal: compra.id_sucursal,
      idUsuario: auth.id_usuario,
      tipoMovimiento: movementType,
      monto: Math.abs(saldoDeseado - saldoAnterior),
      saldoAnterior,
      saldoNuevo: saldoDeseado,
      referenciaTipo: "COMPRA",
      referenciaId: compraId,
      fechaMovimiento: movementDate || new Date(),
      observacion: `Sincronizacion por compra ${compra.numero_documento || compra.id_compra}`,
      actorId,
    });
  }

  return {
    ...existing,
    saldo_actual: saldoDeseado,
  };
};

export const applyCuentaPorCobrarMovement = async (
  db,
  {
    auth,
    scope,
    idCuentaPorCobrar,
    tipoMovimiento,
    monto,
    saldoDelta,
    metodoPago = null,
    referenciaTipo = null,
    referenciaId = null,
    fechaMovimiento = null,
    observacion = null,
    idCajaSesion = null,
    actorId = null,
  }
) => {
  const result = await db.query(
    `
      select *
      from cuentas_por_cobrar
      where id_empresa = $1
        and id_cuenta_por_cobrar = $2
        and id_sucursal = $3
      limit 1
      for update
    `,
    [auth.id_empresa, idCuentaPorCobrar, scope.id_sucursal]
  );

  const account = result.rows[0];

  if (!account) {
    throw HttpError.notFound("Cuenta por cobrar no encontrada");
  }

  const saldoAnterior = roundMoney(account.saldo_actual);
  const saldoNuevo = roundMoney(saldoAnterior + Number(saldoDelta || 0));

  if (saldoNuevo < 0) {
    throw HttpError.badRequest(
      "El movimiento supera el saldo pendiente de la cuenta por cobrar"
    );
  }

  await db.query(
    `
      update cuentas_por_cobrar
      set
        saldo_actual = $1,
        estado = $2,
        updated_by = $3
      where id_cuenta_por_cobrar = $4
    `,
    [
      saldoNuevo,
      getAccountState({
        saldoActual: saldoNuevo,
        montoOriginal: account.monto_original,
        fechaVencimiento: account.fecha_vencimiento,
      }),
      actorId != null ? Number(actorId) : null,
      Number(account.id_cuenta_por_cobrar),
    ]
  );

  await insertCxcMovement(db, {
    idEmpresa: auth.id_empresa,
    idCuentaPorCobrar: account.id_cuenta_por_cobrar,
    idSucursal: account.id_sucursal,
    idUsuario: auth.id_usuario,
    tipoMovimiento,
    metodoPago,
    monto,
    saldoAnterior,
    saldoNuevo,
    referenciaTipo,
    referenciaId,
    fechaMovimiento,
    observacion,
    idCajaSesion,
    actorId,
  });

  if (account.id_venta) {
    await db.query(
      `
        update ventas
        set saldo_pendiente = $1,
            updated_by = $2
        where id_empresa = $3
          and id_venta = $4
      `,
      [
        saldoNuevo,
        actorId != null ? Number(actorId) : null,
        auth.id_empresa,
        Number(account.id_venta),
      ]
    );
  }

  return {
    ...account,
    saldo_actual: saldoNuevo,
  };
};

export const applyCuentaPorPagarMovement = async (
  db,
  {
    auth,
    scope,
    idCuentaPorPagar,
    tipoMovimiento,
    monto,
    saldoDelta,
    metodoPago = null,
    referenciaTipo = null,
    referenciaId = null,
    fechaMovimiento = null,
    observacion = null,
    idCajaSesion = null,
    actorId = null,
  }
) => {
  const result = await db.query(
    `
      select *
      from cuentas_por_pagar
      where id_empresa = $1
        and id_cuenta_por_pagar = $2
        and id_sucursal = $3
      limit 1
      for update
    `,
    [auth.id_empresa, idCuentaPorPagar, scope.id_sucursal]
  );

  const account = result.rows[0];

  if (!account) {
    throw HttpError.notFound("Cuenta por pagar no encontrada");
  }

  const saldoAnterior = roundMoney(account.saldo_actual);
  const saldoNuevo = roundMoney(saldoAnterior + Number(saldoDelta || 0));

  if (saldoNuevo < 0) {
    throw HttpError.badRequest(
      "El movimiento supera el saldo pendiente de la cuenta por pagar"
    );
  }

  await db.query(
    `
      update cuentas_por_pagar
      set
        saldo_actual = $1,
        estado = $2,
        updated_by = $3
      where id_cuenta_por_pagar = $4
    `,
    [
      saldoNuevo,
      getAccountState({
        saldoActual: saldoNuevo,
        montoOriginal: account.monto_original,
        fechaVencimiento: account.fecha_vencimiento,
      }),
      actorId != null ? Number(actorId) : null,
      Number(account.id_cuenta_por_pagar),
    ]
  );

  await insertCxpMovement(db, {
    idEmpresa: auth.id_empresa,
    idCuentaPorPagar: account.id_cuenta_por_pagar,
    idSucursal: account.id_sucursal,
    idUsuario: auth.id_usuario,
    tipoMovimiento,
    metodoPago,
    monto,
    saldoAnterior,
    saldoNuevo,
    referenciaTipo,
    referenciaId,
    fechaMovimiento,
    observacion,
    idCajaSesion,
    actorId,
  });

  if (account.id_compra) {
    await db.query(
      `
        update compras
        set saldo_pendiente = $1,
            updated_by = $2
        where id_empresa = $3
          and id_compra = $4
      `,
      [
        saldoNuevo,
        actorId != null ? Number(actorId) : null,
        auth.id_empresa,
        Number(account.id_compra),
      ]
    );
  }

  return {
    ...account,
    saldo_actual: saldoNuevo,
  };
};

export const isCashPaymentMethod = (value) =>
  CASH_PAYMENT_METHODS.has(normalizePaymentMethod(value));
