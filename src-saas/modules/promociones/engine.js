/**
 * Motor de aplicacion de promociones.
 * Stateless: recibe la lista de promociones aplicables y los items de la venta,
 * devuelve un breakdown con el descuento por promocion y total.
 */

const round2 = (n) => Number(Number(n || 0).toFixed(2));

const promoCubreProducto = (promo, idProducto) => {
  if (!promo.productos_elegibles) return true;
  const arr = Array.isArray(promo.productos_elegibles)
    ? promo.productos_elegibles
    : [];
  if (arr.length === 0) return true;
  return arr.map(Number).includes(Number(idProducto));
};

const calcularPorcentajeVenta = (promo, items) => {
  const aplicables = items.filter((it) => promoCubreProducto(promo, it.id_producto));
  const subtotal = aplicables.reduce(
    (acc, it) => acc + Number(it.cantidad) * Number(it.precio_unitario),
    0
  );
  return round2((subtotal * Number(promo.valor || 0)) / 100);
};

const calcularMontoVenta = (promo, items) => {
  const subtotal = items.reduce(
    (acc, it) => acc + Number(it.cantidad) * Number(it.precio_unitario),
    0
  );
  return round2(Math.min(Number(promo.valor || 0), subtotal));
};

const calcularPorcentajeLinea = (promo, items) => {
  let total = 0;
  for (const it of items) {
    if (!promoCubreProducto(promo, it.id_producto)) continue;
    const sub = Number(it.cantidad) * Number(it.precio_unitario);
    total += (sub * Number(promo.valor || 0)) / 100;
  }
  return round2(total);
};

const calcularNxM = (promo, items) => {
  const n = Math.max(2, Number(promo.nx_n || 0));
  const m = Math.max(1, Number(promo.nx_m || 0));
  if (n <= m) return 0;

  let total = 0;
  for (const it of items) {
    if (!promoCubreProducto(promo, it.id_producto)) continue;
    const cant = Math.floor(Number(it.cantidad));
    const grupos = Math.floor(cant / n);
    if (grupos === 0) continue;
    const gratis = grupos * (n - m);
    total += gratis * Number(it.precio_unitario);
  }
  return round2(total);
};

const ahora = (clock = null) => (clock instanceof Date ? clock : new Date());

const enVigencia = (promo, clock = null) => {
  const t = ahora(clock);
  if (promo.vigente_desde && new Date(promo.vigente_desde) > t) return false;
  if (promo.vigente_hasta && new Date(promo.vigente_hasta) < t) return false;

  if (Array.isArray(promo.dias_semana) && promo.dias_semana.length > 0) {
    // 0=domingo, 1=lunes, ..., 6=sabado (consistente con getDay)
    if (!promo.dias_semana.map(Number).includes(t.getDay())) return false;
  }

  if (promo.horario_desde) {
    const [h, m] = String(promo.horario_desde).split(":");
    const hd = Number(h) * 60 + Number(m || 0);
    const tm = t.getHours() * 60 + t.getMinutes();
    if (tm < hd) return false;
  }
  if (promo.horario_hasta) {
    const [h, m] = String(promo.horario_hasta).split(":");
    const hh = Number(h) * 60 + Number(m || 0);
    const tm = t.getHours() * 60 + t.getMinutes();
    if (tm > hh) return false;
  }

  return true;
};

/**
 * Calcula el descuento de una promocion aplicada a items.
 * Devuelve null si la promocion no aplica (subtotal < monto_minimo, etc.).
 */
export const evaluarPromocion = (promo, { items, clock = null }) => {
  if (!enVigencia(promo, clock)) return null;

  const subtotalGeneral = items.reduce(
    (acc, it) => acc + Number(it.cantidad) * Number(it.precio_unitario),
    0
  );

  if (Number(promo.monto_minimo || 0) > subtotalGeneral) return null;

  let monto = 0;
  switch (String(promo.tipo).toUpperCase()) {
    case "PORCENTAJE_VENTA":
      monto = calcularPorcentajeVenta(promo, items);
      break;
    case "MONTO_VENTA":
      monto = calcularMontoVenta(promo, items);
      break;
    case "PORCENTAJE_LINEA":
      monto = calcularPorcentajeLinea(promo, items);
      break;
    case "NX_M":
      monto = calcularNxM(promo, items);
      break;
    case "CUPON":
      // CUPON usa la misma logica del campo `valor` interpretandolo como porcentaje
      // por defecto. En la realidad, el cupon deberia tener un sub-tipo. Para
      // simplicidad: si tiene nx_n>0 -> NX_M; si tiene productos_elegibles ->
      // PORCENTAJE_LINEA; si no -> PORCENTAJE_VENTA.
      if (Number(promo.nx_n) > 0) monto = calcularNxM(promo, items);
      else if (promo.productos_elegibles && promo.productos_elegibles.length > 0)
        monto = calcularPorcentajeLinea(promo, items);
      else monto = calcularPorcentajeVenta(promo, items);
      break;
    default:
      monto = 0;
  }

  if (monto <= 0) return null;

  return {
    id_promocion: Number(promo.id_promocion),
    codigo: promo.codigo || null,
    nombre: promo.nombre,
    tipo: promo.tipo,
    monto_descontado: round2(monto),
  };
};

/**
 * Aplica todas las promociones aplicables (respetando combinable y prioridad).
 * Returns: { descuento_total, aplicadas: [...] }
 */
export const aplicarPromociones = (promociones, { items, clock = null }) => {
  // Ordenar por prioridad ASC (menor numero = mas prioritaria)
  const ordenadas = [...promociones].sort(
    (a, b) =>
      (a.prioridad ?? 100) - (b.prioridad ?? 100) ||
      Number(a.id_promocion) - Number(b.id_promocion)
  );

  const aplicadas = [];
  let totalDescuento = 0;
  let yaAplicoNoCombi = false;

  for (const promo of ordenadas) {
    if (yaAplicoNoCombi) break;
    if (aplicadas.length > 0 && !promo.combinable) continue;

    const result = evaluarPromocion(promo, { items, clock });
    if (!result) continue;

    aplicadas.push(result);
    totalDescuento += result.monto_descontado;

    if (!promo.combinable) {
      yaAplicoNoCombi = true;
    }
  }

  return {
    descuento_total: round2(totalDescuento),
    aplicadas,
  };
};
