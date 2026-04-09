import { pool } from "../config/db.js";
import { getCajaSesionActiva } from "./caja.model.js";

const MODULO_AUTOLAVADO = "AUTOLAVADO";
const MODULO_REPARACION = "REPARACION";
const ESTADOS_ORDEN_AUTOLAVADO = [
  "RECIBIDO",
  "EN_PROCESO",
  "LAVADO",
  "FINALIZADO",
  "ENTREGADO",
];
const ESTADOS_ORDEN_REPARACION = [
  "RECIBIDO",
  "DIAGNOSTICO",
  "EN_REPARACION",
  "PRUEBAS",
  "LISTO",
  "ENTREGADO",
];
const ROLES_TECNICO_ASIGNABLES = ["MECANICO", "ADMIN", "SUPER_ADMIN"];

const canMoveToNextEstado = (estadoActual, siguienteEstado, estadosPermitidos) => {
  const actual = String(estadoActual || "").trim().toUpperCase();
  const siguiente = String(siguienteEstado || "").trim().toUpperCase();
  const actualIndex = estadosPermitidos.indexOf(actual);
  const siguienteIndex = estadosPermitidos.indexOf(siguiente);

  if (siguienteIndex === -1) {
    return false;
  }

  if (actualIndex === -1) {
    return true;
  }

  return siguienteIndex === actualIndex || siguienteIndex === actualIndex + 1;
};

const slugify = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const getTecnicoAsignableById = async (idUsuario) => {
  const result = await pool.query(
    `
      SELECT
        u.id_usuario,
        u.username,
        u.nombre,
        ARRAY_AGG(DISTINCT UPPER(TRIM(r.nombre_rol))) AS roles
      FROM "Usuario" u
      INNER JOIN "Detalle_usuario" du
        ON du.id_usuario = u.id_usuario
       AND COALESCE(du.activo, true) = true
      INNER JOIN "Rol" r
        ON r.id_rol = du.id_rol
      WHERE u.id_usuario = $1
        AND COALESCE(u.activo, true) = true
        AND UPPER(TRIM(r.nombre_rol)) = ANY($2::text[])
      GROUP BY u.id_usuario, u.username, u.nombre
      LIMIT 1
    `,
    [Number(idUsuario), ROLES_TECNICO_ASIGNABLES]
  );

  return result.rows[0] || null;
};

export const getTecnicosAsignables = async () => {
  const result = await pool.query(
    `
      SELECT
        u.id_usuario,
        u.username,
        u.nombre,
        ARRAY_AGG(DISTINCT UPPER(TRIM(r.nombre_rol)) ORDER BY UPPER(TRIM(r.nombre_rol))) AS roles
      FROM "Usuario" u
      INNER JOIN "Detalle_usuario" du
        ON du.id_usuario = u.id_usuario
       AND COALESCE(du.activo, true) = true
      INNER JOIN "Rol" r
        ON r.id_rol = du.id_rol
      WHERE COALESCE(u.activo, true) = true
        AND UPPER(TRIM(r.nombre_rol)) = ANY($1::text[])
      GROUP BY u.id_usuario, u.username, u.nombre
      ORDER BY
        MAX(CASE WHEN UPPER(TRIM(r.nombre_rol)) = 'MECANICO' THEN 1 ELSE 0 END) DESC,
        COALESCE(u.nombre, u.username) ASC
    `,
    [ROLES_TECNICO_ASIGNABLES]
  );

  return result.rows;
};

export const getAutolavadoCatalogo = async () => {
  const [vehiculosResult, serviciosResult] = await Promise.all([
    pool.query(
      `
        SELECT
          id_tipo_vehiculo,
          modulo,
          nombre,
          slug,
          descripcion,
          icono,
          orden,
          activo
        FROM "Servicio_tipo_vehiculo"
        WHERE modulo = '${MODULO_AUTOLAVADO}'
          AND activo = true
        ORDER BY orden ASC, nombre ASC
      `
    ),
    pool.query(
      `
        SELECT
          sc.id_servicio_catalogo,
          sc.id_tipo_vehiculo,
          sc.modulo,
          sc.nombre,
          sc.slug,
          sc.descripcion,
          sc.precio_base,
          sc.duracion_minutos,
          sc.icono,
          sc.orden,
          sc.activo,
          stv.nombre AS tipo_vehiculo_nombre,
          stv.slug AS tipo_vehiculo_slug
        FROM "Servicio_catalogo" sc
        INNER JOIN "Servicio_tipo_vehiculo" stv
          ON stv.id_tipo_vehiculo = sc.id_tipo_vehiculo
        WHERE sc.modulo = '${MODULO_AUTOLAVADO}'
          AND sc.activo = true
          AND stv.activo = true
        ORDER BY stv.orden ASC, sc.orden ASC, sc.nombre ASC
      `
    ),
  ]);

  return {
    vehiculos: vehiculosResult.rows,
    servicios: serviciosResult.rows,
  };
};

export const getReparacionCatalogo = async () => {
  const [vehiculosResult, serviciosResult] = await Promise.all([
    pool.query(
      `
        SELECT
          id_tipo_vehiculo,
          modulo,
          nombre,
          slug,
          descripcion,
          icono,
          orden,
          activo
        FROM "Servicio_tipo_vehiculo"
        WHERE modulo = '${MODULO_REPARACION}'
          AND activo = true
        ORDER BY orden ASC, nombre ASC
      `
    ),
    pool.query(
      `
        SELECT
          sc.id_servicio_catalogo,
          sc.id_tipo_vehiculo,
          sc.modulo,
          sc.nombre,
          sc.slug,
          sc.descripcion,
          sc.precio_base,
          sc.duracion_minutos,
          sc.icono,
          sc.orden,
          sc.activo,
          stv.nombre AS tipo_vehiculo_nombre,
          stv.slug AS tipo_vehiculo_slug
        FROM "Servicio_catalogo" sc
        INNER JOIN "Servicio_tipo_vehiculo" stv
          ON stv.id_tipo_vehiculo = sc.id_tipo_vehiculo
        WHERE sc.modulo = '${MODULO_REPARACION}'
          AND sc.activo = true
          AND stv.activo = true
        ORDER BY stv.orden ASC, sc.orden ASC, sc.nombre ASC
      `
    ),
  ]);

  return {
    vehiculos: vehiculosResult.rows,
    servicios: serviciosResult.rows,
  };
};

const existsTipoVehiculoSlug = async (modulo, slug, excludeId = null) => {
  const result = await pool.query(
    `
      SELECT 1
      FROM "Servicio_tipo_vehiculo"
      WHERE modulo = $1
        AND slug = $2
        AND ($3::int IS NULL OR id_tipo_vehiculo <> $3)
      LIMIT 1
    `,
    [modulo, slug, excludeId]
  );

  return result.rowCount > 0;
};

const existsServicioSlug = async (idTipoVehiculo, slug, excludeId = null) => {
  const result = await pool.query(
    `
      SELECT 1
      FROM "Servicio_catalogo"
      WHERE id_tipo_vehiculo = $1
        AND slug = $2
        AND ($3::int IS NULL OR id_servicio_catalogo <> $3)
      LIMIT 1
    `,
    [idTipoVehiculo, slug, excludeId]
  );

  return result.rowCount > 0;
};

export const createTipoVehiculo = async ({
  modulo = MODULO_AUTOLAVADO,
  nombre,
  descripcion = null,
  icono = "directions_car",
  actorId = null,
}) => {
  const slug = slugify(nombre);

  if (!slug) {
    throw new Error("No se pudo generar un identificador valido para el vehiculo");
  }

  if (await existsTipoVehiculoSlug(modulo, slug)) {
    const error = new Error("Ya existe un tipo de vehiculo con ese nombre");
    error.statusCode = 409;
    throw error;
  }

  const ordenResult = await pool.query(
    `
      SELECT COALESCE(MAX(orden), 0) + 1 AS next_order
      FROM "Servicio_tipo_vehiculo"
      WHERE modulo = $1
    `,
    [modulo]
  );

  const result = await pool.query(
    `
      INSERT INTO "Servicio_tipo_vehiculo" (
        modulo,
        nombre,
        slug,
        descripcion,
        icono,
        orden,
        activo,
        created_by,
        updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7)
      RETURNING
        id_tipo_vehiculo,
        modulo,
        nombre,
        slug,
        descripcion,
        icono,
        orden,
        activo
    `,
    [
      modulo,
      nombre,
      slug,
      descripcion,
      icono,
      Number(ordenResult.rows[0]?.next_order || 1),
      actorId,
    ]
  );

  return result.rows[0];
};

export const updateTipoVehiculo = async (
  idTipoVehiculo,
  {
    modulo = MODULO_AUTOLAVADO,
    nombre,
    descripcion = null,
    icono = "directions_car",
  },
  actorId = null
) => {
  const slug = slugify(nombre);

  if (!slug) {
    throw new Error("No se pudo generar un identificador valido para el vehiculo");
  }

  if (await existsTipoVehiculoSlug(modulo, slug, idTipoVehiculo)) {
    const error = new Error("Ya existe un tipo de vehiculo con ese nombre");
    error.statusCode = 409;
    throw error;
  }

  const result = await pool.query(
    `
      UPDATE "Servicio_tipo_vehiculo"
      SET nombre = $1,
          slug = $2,
          descripcion = $3,
          icono = $4,
          updated_by = $5
      WHERE id_tipo_vehiculo = $6
        AND modulo = $7
      RETURNING
        id_tipo_vehiculo,
        modulo,
        nombre,
        slug,
        descripcion,
        icono,
        orden,
        activo
    `,
    [nombre, slug, descripcion, icono, actorId, idTipoVehiculo, modulo]
  );

  return result.rows[0];
};

export const createServicioCatalogo = async ({
  modulo = MODULO_AUTOLAVADO,
  idTipoVehiculo,
  nombre,
  descripcion = null,
  precioBase,
  duracionMinutos,
  icono = "cleaning_services",
  actorId = null,
}) => {
  const slug = slugify(nombre);

  if (!slug) {
    throw new Error("No se pudo generar un identificador valido para el servicio");
  }

  if (await existsServicioSlug(idTipoVehiculo, slug)) {
    const error = new Error("Ya existe un servicio con ese nombre para este vehiculo");
    error.statusCode = 409;
    throw error;
  }

  const ordenResult = await pool.query(
    `
      SELECT COALESCE(MAX(orden), 0) + 1 AS next_order
      FROM "Servicio_catalogo"
      WHERE id_tipo_vehiculo = $1
    `,
    [idTipoVehiculo]
  );

  const result = await pool.query(
    `
      INSERT INTO "Servicio_catalogo" (
        id_tipo_vehiculo,
        modulo,
        nombre,
        slug,
        descripcion,
        precio_base,
        duracion_minutos,
        icono,
        orden,
        activo,
        created_by,
        updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $10)
      RETURNING
        id_servicio_catalogo,
        id_tipo_vehiculo,
        modulo,
        nombre,
        slug,
        descripcion,
        precio_base,
        duracion_minutos,
        icono,
        orden,
        activo
    `,
    [
      idTipoVehiculo,
      modulo,
      nombre,
      slug,
      descripcion,
      precioBase,
      duracionMinutos,
      icono,
      Number(ordenResult.rows[0]?.next_order || 1),
      actorId,
    ]
  );

  return result.rows[0];
};

export const updateServicioCatalogo = async (
  idServicioCatalogo,
  {
    modulo = MODULO_AUTOLAVADO,
    idTipoVehiculo,
    nombre,
    descripcion = null,
    precioBase,
    duracionMinutos,
    icono = "cleaning_services",
  },
  actorId = null
) => {
  const slug = slugify(nombre);

  if (!slug) {
    throw new Error("No se pudo generar un identificador valido para el servicio");
  }

  if (await existsServicioSlug(idTipoVehiculo, slug, idServicioCatalogo)) {
    const error = new Error("Ya existe un servicio con ese nombre para este vehiculo");
    error.statusCode = 409;
    throw error;
  }

  const result = await pool.query(
    `
      UPDATE "Servicio_catalogo"
      SET id_tipo_vehiculo = $1,
          nombre = $2,
          slug = $3,
          descripcion = $4,
          precio_base = $5,
          duracion_minutos = $6,
          icono = $7,
          updated_by = $8
      WHERE id_servicio_catalogo = $9
        AND modulo = $10
      RETURNING
        id_servicio_catalogo,
        id_tipo_vehiculo,
        modulo,
        nombre,
        slug,
        descripcion,
        precio_base,
        duracion_minutos,
        icono,
        orden,
        activo
    `,
    [
      idTipoVehiculo,
      nombre,
      slug,
      descripcion,
      precioBase,
      duracionMinutos,
      icono,
      actorId,
      idServicioCatalogo,
      modulo,
    ]
  );

  return result.rows[0];
};

export const registrarCobroAutolavado = async ({
  idTipoVehiculo,
  idServicioCatalogo,
  idUsuario,
  idSucursal = 1,
  nombreCliente = null,
  placa = null,
  color = null,
  observaciones = null,
  metodoPago,
  precioServicio = null,
  montoCobrado,
  montoRecibido = null,
  noCobrar = false,
  noCobradoMotivo = null,
  noCobradoAutorizadoPor = null,
}) => {
  const ventaSinCobro = Boolean(noCobrar);
  const metodoPagoNormalizado = String(metodoPago || "").trim().toUpperCase();
  const metodoPagoPersistido = ventaSinCobro ? "NO_COBRADO" : metodoPagoNormalizado;
  if (!["EFECTIVO", "TARJETA", "TRANSFERENCIA"].includes(metodoPagoNormalizado)) {
    if (!ventaSinCobro) {
      throw new Error("metodo_pago invalido");
    }
  }

  const montoCobradoNormalizado = Number(montoCobrado);
  if (!Number.isFinite(montoCobradoNormalizado) || montoCobradoNormalizado <= 0) {
    throw new Error("monto_cobrado debe ser mayor a 0");
  }

  const montoRecibidoNormalizado =
    montoRecibido == null || montoRecibido === ""
      ? null
      : Number(montoRecibido);

  if (
    !ventaSinCobro &&
    metodoPagoNormalizado === "EFECTIVO" &&
    (!Number.isFinite(montoRecibidoNormalizado) ||
      montoRecibidoNormalizado < montoCobradoNormalizado)
  ) {
    throw new Error("El monto recibido no cubre el total del servicio");
  }

  const sesionCaja = await getCajaSesionActiva(idUsuario);
  if (!sesionCaja) {
    throw new Error("Debes abrir una caja antes de cobrar un servicio");
  }

  const servicioResult = await pool.query(
    `
      SELECT
        sc.id_servicio_catalogo,
        sc.id_tipo_vehiculo,
        sc.nombre,
        sc.slug,
        sc.precio_base,
        stv.nombre AS tipo_vehiculo_nombre
      FROM "Servicio_catalogo" sc
      INNER JOIN "Servicio_tipo_vehiculo" stv
        ON stv.id_tipo_vehiculo = sc.id_tipo_vehiculo
      WHERE sc.id_servicio_catalogo = $1
        AND sc.id_tipo_vehiculo = $2
        AND sc.modulo = $3
        AND sc.activo = true
        AND stv.activo = true
      LIMIT 1
    `,
    [idServicioCatalogo, idTipoVehiculo, MODULO_AUTOLAVADO]
  );

  const servicio = servicioResult.rows[0];
  if (!servicio) {
    throw new Error("Servicio de autolavado no encontrado");
  }

  const precioServicioPersistido =
    String(servicio.slug || "").trim().toLowerCase() === "otro"
      ? Number(precioServicio)
      : Number(servicio.precio_base || 0);

  if (!Number.isFinite(precioServicioPersistido) || precioServicioPersistido <= 0) {
    throw new Error("Debes indicar un precio valido para el servicio");
  }

  const vuelto =
    !ventaSinCobro && metodoPagoNormalizado === "EFECTIVO"
      ? Math.max(0, Number((montoRecibidoNormalizado - montoCobradoNormalizado).toFixed(2)))
      : 0;

  const result = await pool.query(
    `
      INSERT INTO "Autolavado_orden" (
        id_tipo_vehiculo,
        id_servicio_catalogo,
        id_usuario,
        id_caja_sesion,
        id_sucursal,
        nombre_cliente,
        placa,
        color,
        observaciones,
        metodo_pago,
        precio_servicio,
        monto_cobrado,
        monto_recibido,
        vuelto,
        estado,
        estado_trabajo,
        no_cobrado_motivo,
        no_cobrado_autorizado_por,
        no_cobrado_autorizado_en,
        no_cobrado_validado_por,
        no_cobrado_validado_en,
        no_cobrado_validacion_nota,
        created_by,
        updated_by
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, 'RECIBIDO',
        $16, $17, CASE WHEN $18 THEN now() ELSE NULL END, NULL, NULL, NULL,
        $3, $3
      )
      RETURNING
        id_autolavado_orden,
        id_tipo_vehiculo,
        id_servicio_catalogo,
        id_usuario,
        id_caja_sesion,
        id_sucursal,
        nombre_cliente,
        placa,
        color,
        observaciones,
        metodo_pago,
        precio_servicio,
        monto_cobrado,
        monto_recibido,
        vuelto,
        estado,
        estado_trabajo,
        no_cobrado_motivo,
        no_cobrado_autorizado_por,
        no_cobrado_autorizado_en,
        fecha
    `,
    [
      idTipoVehiculo,
      idServicioCatalogo,
      idUsuario,
      sesionCaja.id_caja_sesion,
      Number(idSucursal || 1),
      nombreCliente || null,
      placa || null,
      color || null,
      observaciones || null,
      metodoPagoPersistido,
      precioServicioPersistido,
      montoCobradoNormalizado,
      ventaSinCobro ? null : montoRecibidoNormalizado,
      vuelto,
      ventaSinCobro ? "NO_COBRADO" : "PAGADO",
      ventaSinCobro ? noCobradoMotivo : null,
      ventaSinCobro ? noCobradoAutorizadoPor : null,
      ventaSinCobro,
    ]
  );

  return {
    orden: result.rows[0],
    servicio,
    caja: sesionCaja,
  };
};

export const registrarCobroReparacion = async ({
  idReparacionOrden = null,
  idTipoVehiculo,
  idServicioCatalogo,
  idUsuario,
  idSucursal = 1,
  nombreCliente = null,
  placa = null,
  color = null,
  kilometraje = null,
  diagnosticoInicial = null,
  observaciones = null,
  metodoPago,
  precioServicio = null,
  montoCobrado,
  montoRecibido = null,
  productos = [],
  noCobrar = false,
  noCobradoMotivo = null,
  noCobradoAutorizadoPor = null,
}) => {
  const ventaSinCobro = Boolean(noCobrar);
  const metodoPagoNormalizado = String(metodoPago || "").trim().toUpperCase();
  const metodoPagoPersistido = ventaSinCobro ? "NO_COBRADO" : metodoPagoNormalizado;
  if (!["EFECTIVO", "TARJETA", "TRANSFERENCIA"].includes(metodoPagoNormalizado)) {
    if (!ventaSinCobro) {
      throw new Error("metodo_pago invalido");
    }
  }

  const montoCobradoNormalizado = Number(montoCobrado);
  if (!Number.isFinite(montoCobradoNormalizado) || montoCobradoNormalizado <= 0) {
    throw new Error("monto_cobrado debe ser mayor a 0");
  }

  const montoRecibidoNormalizado =
    montoRecibido == null || montoRecibido === "" ? null : Number(montoRecibido);

  if (
    !ventaSinCobro &&
    metodoPagoNormalizado === "EFECTIVO" &&
    (!Number.isFinite(montoRecibidoNormalizado) ||
      montoRecibidoNormalizado < montoCobradoNormalizado)
  ) {
    throw new Error("El monto recibido no cubre el total del servicio");
  }

  const sesionCaja = await getCajaSesionActiva(idUsuario);
  if (!sesionCaja) {
    throw new Error("Debes abrir una caja antes de cobrar un servicio");
  }

  const servicioResult = await pool.query(
    `
      SELECT
        sc.id_servicio_catalogo,
        sc.id_tipo_vehiculo,
        sc.nombre,
        sc.slug,
        sc.precio_base,
        stv.nombre AS tipo_vehiculo_nombre
      FROM "Servicio_catalogo" sc
      INNER JOIN "Servicio_tipo_vehiculo" stv
        ON stv.id_tipo_vehiculo = sc.id_tipo_vehiculo
      WHERE sc.id_servicio_catalogo = $1
        AND sc.id_tipo_vehiculo = $2
        AND sc.modulo = $3
        AND sc.activo = true
        AND stv.activo = true
      LIMIT 1
    `,
    [idServicioCatalogo, idTipoVehiculo, MODULO_REPARACION]
  );

  const servicio = servicioResult.rows[0];
  if (!servicio) {
    throw new Error("Servicio de reparacion no encontrado");
  }

  const precioServicioPersistido =
    String(servicio.slug || "").trim().toLowerCase() === "otro"
      ? Number(precioServicio)
      : Number(servicio.precio_base || 0);

  if (!Number.isFinite(precioServicioPersistido) || precioServicioPersistido <= 0) {
    throw new Error("Debes indicar un precio valido para el servicio");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const idBodega = Number(idSucursal || 1);
    const detallesProductos = [];
    let totalProductosCobrados = 0;

    for (const item of Array.isArray(productos) ? productos : []) {
      const idProducto = Number(item.idProducto);
      const cantidad = Number(item.cantidad);
      const cobraAlCliente = Boolean(item.cobraAlCliente);

      const productoResult = await client.query(
        `
          SELECT
            p.id_producto,
            p.nombre,
            p.codigo_barras,
            p.precio_venta,
            p.precio_compra,
            s.existencia
          FROM "Producto" p
          INNER JOIN "Stock_producto" s
            ON s.id_producto = p.id_producto
           AND s.id_bodega = $2
          WHERE p.id_producto = $1
            AND COALESCE(p.activo, true) = true
          FOR UPDATE OF s
        `,
        [idProducto, idBodega]
      );

      const producto = productoResult.rows[0];
      if (!producto) {
        throw new Error("Producto no encontrado en stock para esta sucursal");
      }

      const existenciaAntes = Number(producto.existencia || 0);
      if (existenciaAntes < cantidad) {
        throw new Error(
          `Stock insuficiente para "${producto.nombre}". Disponible: ${existenciaAntes}`
        );
      }

      const existenciaDespues = existenciaAntes - cantidad;
      const precioUnitario = Number(producto.precio_venta || 0);
      const precioCompraUnitario = Number(producto.precio_compra || 0);
      const subtotalCobrado = cobraAlCliente
        ? Number((precioUnitario * cantidad).toFixed(2))
        : 0;

      totalProductosCobrados += subtotalCobrado;
      detallesProductos.push({
        idProducto,
        nombre: producto.nombre,
        codigoBarras: producto.codigo_barras,
        cantidad,
        cobraAlCliente,
        precioUnitario,
        precioCompraUnitario,
        subtotalCobrado,
        existenciaAntes,
        existenciaDespues,
      });
    }

    const totalCalculado = Number(
      (precioServicioPersistido + totalProductosCobrados).toFixed(2)
    );

    if (montoCobradoNormalizado < totalCalculado) {
      throw new Error(
        `El total enviado no cubre el servicio y repuestos. Total minimo: Q ${totalCalculado.toFixed(2)}`
      );
    }

    if (
      !ventaSinCobro &&
      metodoPagoNormalizado === "EFECTIVO" &&
      (!Number.isFinite(montoRecibidoNormalizado) ||
        montoRecibidoNormalizado < totalCalculado)
    ) {
      throw new Error("El monto recibido no cubre el total del servicio");
    }

    const vuelto =
      !ventaSinCobro && metodoPagoNormalizado === "EFECTIVO"
        ? Math.max(0, Number((montoRecibidoNormalizado - totalCalculado).toFixed(2)))
        : 0;

    const result = await client.query(
      `
        INSERT INTO "Reparacion_orden" (
          id_tipo_vehiculo,
          id_servicio_catalogo,
          id_usuario,
          id_caja_sesion,
          id_sucursal,
          nombre_cliente,
          placa,
          color,
          kilometraje,
          diagnostico_inicial,
          observaciones,
          metodo_pago,
          precio_servicio,
          monto_cobrado,
          monto_recibido,
          vuelto,
          estado,
          estado_trabajo,
          no_cobrado_motivo,
          no_cobrado_autorizado_por,
          no_cobrado_autorizado_en,
          no_cobrado_validado_por,
          no_cobrado_validado_en,
          no_cobrado_validacion_nota,
          created_by,
          updated_by
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, 'RECIBIDO',
          $18, $19, CASE WHEN $20 THEN now() ELSE NULL END, NULL, NULL, NULL,
          $3, $3
        )
        RETURNING
          id_reparacion_orden,
          id_tipo_vehiculo,
          id_servicio_catalogo,
          id_usuario,
          id_caja_sesion,
          id_sucursal,
          nombre_cliente,
          placa,
          color,
          kilometraje,
          diagnostico_inicial,
          observaciones,
          metodo_pago,
          precio_servicio,
          monto_cobrado,
          monto_recibido,
          vuelto,
          estado,
          estado_trabajo,
          no_cobrado_motivo,
          no_cobrado_autorizado_por,
          no_cobrado_autorizado_en,
          fecha
      `,
      [
        idTipoVehiculo,
        idServicioCatalogo,
        idUsuario,
        sesionCaja.id_caja_sesion,
        Number(idSucursal || 1),
        nombreCliente || null,
        placa || null,
        color || null,
        kilometraje == null || kilometraje === "" ? null : Number(kilometraje),
        diagnosticoInicial || null,
        observaciones || null,
        metodoPagoPersistido,
        precioServicioPersistido,
        totalCalculado,
        ventaSinCobro ? null : montoRecibidoNormalizado,
        vuelto,
        ventaSinCobro ? "NO_COBRADO" : "PAGADO",
        ventaSinCobro ? noCobradoMotivo : null,
        ventaSinCobro ? noCobradoAutorizadoPor : null,
        ventaSinCobro,
      ]
    );

    const orden = result.rows[0];

    for (const item of detallesProductos) {
      await client.query(
        `
          INSERT INTO "Reparacion_orden_producto" (
            id_reparacion_orden,
            id_producto,
            cantidad,
            precio_unitario,
            precio_compra_unitario,
            cobra_al_cliente,
            subtotal_cobrado,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        `,
        [
          orden.id_reparacion_orden,
          item.idProducto,
          item.cantidad,
          item.precioUnitario,
          item.precioCompraUnitario,
          item.cobraAlCliente,
          item.subtotalCobrado,
          idUsuario,
        ]
      );

      await client.query(
        `
          UPDATE "Stock_producto"
          SET existencia = $1
          WHERE id_producto = $2
            AND id_bodega = $3
        `,
        [item.existenciaDespues, item.idProducto, idBodega]
      );

      await client.query(
        `
          INSERT INTO "Movimiento_stock"
            (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
          VALUES ('SALIDA', $1, $2, $3, $4, $5, $6, $7)
        `,
        [
          `Reparacion #${orden.id_reparacion_orden}`,
          item.cantidad,
          item.existenciaAntes,
          item.existenciaDespues,
          item.idProducto,
          idBodega,
          idUsuario,
        ]
      );
    }

    await client.query("COMMIT");

    return {
      orden,
      servicio,
      caja: sesionCaja,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const crearOrdenReparacion = async ({
  idTipoVehiculo,
  idServicioCatalogo,
  idUsuario,
  idSucursal = 1,
  nombreCliente = null,
  placa = null,
  color = null,
  kilometraje = null,
  diagnosticoInicial = null,
  observaciones = null,
}) => {
  const servicioResult = await pool.query(
    `
      SELECT
        sc.id_servicio_catalogo,
        sc.id_tipo_vehiculo,
        sc.nombre,
        sc.precio_base,
        stv.nombre AS tipo_vehiculo_nombre
      FROM "Servicio_catalogo" sc
      INNER JOIN "Servicio_tipo_vehiculo" stv
        ON stv.id_tipo_vehiculo = sc.id_tipo_vehiculo
      WHERE sc.id_servicio_catalogo = $1
        AND sc.id_tipo_vehiculo = $2
        AND sc.modulo = $3
        AND sc.activo = true
        AND stv.activo = true
      LIMIT 1
    `,
    [idServicioCatalogo, idTipoVehiculo, MODULO_REPARACION]
  );

  const servicio = servicioResult.rows[0];
  if (!servicio) {
    throw new Error("Servicio de reparacion no encontrado");
  }

  const result = await pool.query(
    `
      INSERT INTO "Reparacion_orden" (
        id_tipo_vehiculo,
        id_servicio_catalogo,
        id_usuario,
        id_caja_sesion,
        id_sucursal,
        nombre_cliente,
        placa,
        color,
        kilometraje,
        diagnostico_inicial,
        observaciones,
        metodo_pago,
        precio_servicio,
        monto_cobrado,
        monto_recibido,
        vuelto,
        estado,
        estado_trabajo,
        created_by,
        updated_by
      )
      VALUES (
        $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9,
        $10, NULL, $11, $11, NULL, 0, 'PENDIENTE', 'RECIBIDO', $3, $3
      )
      RETURNING
        id_reparacion_orden,
        id_tipo_vehiculo,
        id_servicio_catalogo,
        id_usuario,
        id_caja_sesion,
        id_sucursal,
        nombre_cliente,
        placa,
        color,
        kilometraje,
        diagnostico_inicial,
        observaciones,
        metodo_pago,
        precio_servicio,
        monto_cobrado,
        monto_recibido,
        vuelto,
        estado,
        estado_trabajo,
        fecha
    `,
    [
      idTipoVehiculo,
      idServicioCatalogo,
      idUsuario,
      Number(idSucursal || 1),
      nombreCliente || null,
      placa || null,
      color || null,
      kilometraje == null || kilometraje === "" ? null : Number(kilometraje),
      diagnosticoInicial || null,
      observaciones || null,
      Number(servicio.precio_base || 0),
    ]
  );

  return {
    orden: result.rows[0],
    servicio,
  };
};

export const cobrarOrdenReparacion = async ({
  idReparacionOrden,
  idUsuario,
  metodoPago,
  montoRecibido = null,
  noCobrar = false,
  noCobradoMotivo = null,
  noCobradoAutorizadoPor = null,
}) => {
  const ventaSinCobro = Boolean(noCobrar);
  const metodoPagoNormalizado = String(metodoPago || "").trim().toUpperCase();
  const metodoPagoPersistido = ventaSinCobro ? "NO_COBRADO" : metodoPagoNormalizado;
  if (!["EFECTIVO", "TARJETA", "TRANSFERENCIA"].includes(metodoPagoNormalizado)) {
    if (!ventaSinCobro) {
      throw new Error("metodo_pago invalido");
    }
  }

  const sesionCaja = await getCajaSesionActiva(idUsuario);
  if (!sesionCaja) {
    throw new Error("Debes abrir una caja antes de cobrar un servicio");
  }

  const montoRecibidoNormalizado =
    montoRecibido == null || montoRecibido === "" ? null : Number(montoRecibido);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ordenResult = await client.query(
      `
        SELECT
          id_reparacion_orden,
          id_sucursal,
          monto_cobrado,
          estado
        FROM "Reparacion_orden"
        WHERE id_reparacion_orden = $1
        FOR UPDATE
      `,
      [Number(idReparacionOrden)]
    );

    const orden = ordenResult.rows[0];
    if (!orden) {
      const error = new Error("Orden de reparacion no encontrada");
      error.statusCode = 404;
      throw error;
    }

    if (String(orden.estado || "").toUpperCase() === "PAGADO") {
      throw new Error("La orden ya fue cobrada");
    }

    const montoTotal = Number(orden.monto_cobrado || 0);
    if (!Number.isFinite(montoTotal) || montoTotal <= 0) {
      throw new Error("La orden no tiene un total valido para cobrar");
    }

    if (
      !ventaSinCobro &&
      metodoPagoNormalizado === "EFECTIVO" &&
      (!Number.isFinite(montoRecibidoNormalizado) || montoRecibidoNormalizado < montoTotal)
    ) {
      throw new Error("El monto recibido no cubre el total del servicio");
    }

    const vuelto =
      !ventaSinCobro && metodoPagoNormalizado === "EFECTIVO"
        ? Math.max(0, Number((montoRecibidoNormalizado - montoTotal).toFixed(2)))
        : 0;

    const result = await client.query(
      `
        UPDATE "Reparacion_orden"
        SET id_caja_sesion = $1,
            metodo_pago = $2,
            monto_recibido = $3,
            vuelto = $4,
            estado = $5,
            no_cobrado_motivo = $6,
            no_cobrado_autorizado_por = $7,
            no_cobrado_autorizado_en = CASE WHEN $8 THEN now() ELSE no_cobrado_autorizado_en END,
            updated_by = $9
        WHERE id_reparacion_orden = $10
        RETURNING
          id_reparacion_orden,
          id_caja_sesion,
          metodo_pago,
          monto_cobrado,
          monto_recibido,
          vuelto,
          estado,
          no_cobrado_motivo,
          no_cobrado_autorizado_por,
          no_cobrado_autorizado_en
      `,
      [
        sesionCaja.id_caja_sesion,
        metodoPagoPersistido,
        ventaSinCobro ? null : montoRecibidoNormalizado,
        vuelto,
        ventaSinCobro ? "NO_COBRADO" : "PAGADO",
        ventaSinCobro ? noCobradoMotivo : null,
        ventaSinCobro ? noCobradoAutorizadoPor : null,
        ventaSinCobro,
        idUsuario,
        Number(idReparacionOrden),
      ]
    );

    await client.query("COMMIT");

    return {
      orden: result.rows[0],
      caja: sesionCaja,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const agregarProductoOrdenReparacion = async ({
  idReparacionOrden,
  idProducto,
  cantidad,
  cobraAlCliente = true,
  actorId = null,
}) => {
  const cantidadNormalizada = Number(cantidad);
  if (!Number.isInteger(cantidadNormalizada) || cantidadNormalizada <= 0) {
    throw new Error("cantidad invalida");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ordenResult = await client.query(
      `
        SELECT
          id_reparacion_orden,
          id_sucursal,
          monto_cobrado,
          estado
        FROM "Reparacion_orden"
        WHERE id_reparacion_orden = $1
        FOR UPDATE
      `,
      [Number(idReparacionOrden)]
    );

    const orden = ordenResult.rows[0];
    if (!orden) {
      const error = new Error("Orden de reparacion no encontrada");
      error.statusCode = 404;
      throw error;
    }

    if (Boolean(cobraAlCliente) && String(orden.estado || "").toUpperCase() === "PAGADO") {
      throw new Error(
        "La orden ya fue cobrada. Solo puedes agregar productos de uso interno o crear una nueva orden de cobro."
      );
    }

    const idBodega = Number(orden.id_sucursal || 1);

    const productoResult = await client.query(
      `
        SELECT
          p.id_producto,
          p.nombre,
          p.codigo_barras,
          p.precio_venta,
          p.precio_compra,
          s.id_bodega,
          s.existencia
        FROM "Producto" p
        INNER JOIN "Stock_producto" s
          ON s.id_producto = p.id_producto
         AND s.id_bodega = $2
        WHERE p.id_producto = $1
          AND COALESCE(p.activo, true) = true
        FOR UPDATE OF s
      `,
      [Number(idProducto), idBodega]
    );

    const producto = productoResult.rows[0];
    if (!producto) {
      const error = new Error("Producto no encontrado en stock para esta sucursal");
      error.statusCode = 404;
      throw error;
    }

    const existenciaAntes = Number(producto.existencia || 0);
    if (existenciaAntes < cantidadNormalizada) {
      throw new Error(
        `Stock insuficiente para "${producto.nombre}". Disponible: ${existenciaAntes}`
      );
    }

    const existenciaDespues = existenciaAntes - cantidadNormalizada;
    const precioUnitario = Number(producto.precio_venta || 0);
    const precioCompraUnitario = Number(producto.precio_compra || 0);
    const subtotalBase = Number((precioUnitario * cantidadNormalizada).toFixed(2));
    const subtotalCobrado = cobraAlCliente ? subtotalBase : 0;

    const detalleResult = await client.query(
      `
        INSERT INTO "Reparacion_orden_producto" (
          id_reparacion_orden,
          id_producto,
          cantidad,
          precio_unitario,
          precio_compra_unitario,
          cobra_al_cliente,
          subtotal_cobrado,
          created_by,
          updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        RETURNING
          id_reparacion_orden_producto,
          id_reparacion_orden,
          id_producto,
          cantidad,
          precio_unitario,
          precio_compra_unitario,
          cobra_al_cliente,
          subtotal_cobrado,
          fecha
      `,
      [
        Number(idReparacionOrden),
        Number(idProducto),
        cantidadNormalizada,
        precioUnitario,
        precioCompraUnitario,
        Boolean(cobraAlCliente),
        subtotalCobrado,
        actorId,
      ]
    );

    await client.query(
      `
        UPDATE "Stock_producto"
        SET existencia = $1
        WHERE id_producto = $2
          AND id_bodega = $3
      `,
      [existenciaDespues, Number(idProducto), idBodega]
    );

    await client.query(
      `
        INSERT INTO "Movimiento_stock"
          (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
        VALUES ('SALIDA', $1, $2, $3, $4, $5, $6, $7)
      `,
      [
        `Reparacion #${Number(idReparacionOrden)}`,
        cantidadNormalizada,
        existenciaAntes,
        existenciaDespues,
        Number(idProducto),
        idBodega,
        actorId,
      ]
    );

    const ordenActualizadaResult = await client.query(
      `
        UPDATE "Reparacion_orden"
        SET monto_cobrado = monto_cobrado + $1,
            updated_by = $2
        WHERE id_reparacion_orden = $3
        RETURNING
          id_reparacion_orden,
          monto_cobrado
      `,
      [subtotalCobrado, actorId, Number(idReparacionOrden)]
    );

    await client.query("COMMIT");

    return {
      detalle: {
        ...detalleResult.rows[0],
        producto_nombre: producto.nombre,
        codigo_barras: producto.codigo_barras,
      },
      orden: ordenActualizadaResult.rows[0],
      stock: {
        existencia_antes: existenciaAntes,
        existencia_despues: existenciaDespues,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getOrdenesAutolavado = async ({ estadoTrabajo = "TODOS", limit = 30 } = {}) => {
  const limitNormalizado = Math.min(100, Math.max(1, Number(limit) || 30));
  const estadoNormalizado = String(estadoTrabajo || "TODOS").trim().toUpperCase();
  const params = [];
  const where = [];
  let index = 1;

  if (estadoNormalizado !== "TODOS") {
    where.push(`ao.estado_trabajo = $${index++}`);
    params.push(estadoNormalizado);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const result = await pool.query(
    `
      SELECT
        ao.id_autolavado_orden,
        ao.id_tipo_vehiculo,
        ao.id_servicio_catalogo,
        ao.id_usuario,
        ao.id_caja_sesion,
        ao.id_sucursal,
        ao.nombre_cliente,
        ao.placa,
        ao.color,
        ao.observaciones,
        ao.metodo_pago,
        ao.precio_servicio,
        ao.monto_cobrado,
        ao.monto_recibido,
        ao.vuelto,
        ao.estado,
        ao.estado_trabajo,
        ao.fecha,
        ao.fecha_inicio_proceso,
        ao.fecha_lavado,
        ao.fecha_finalizado,
        ao.fecha_entregado,
        ao.id_tecnico_asignado,
        ao.tecnico_asignado_en,
        ao.tecnico_asignado_por,
        stv.nombre AS tipo_vehiculo_nombre,
        stv.icono AS tipo_vehiculo_icono,
        sc.nombre AS servicio_nombre,
        sc.duracion_minutos,
        u.nombre AS usuario_nombre,
        u.username,
        tu.nombre AS tecnico_nombre,
        tu.username AS tecnico_username
      FROM "Autolavado_orden" ao
      INNER JOIN "Servicio_tipo_vehiculo" stv
        ON stv.id_tipo_vehiculo = ao.id_tipo_vehiculo
      INNER JOIN "Servicio_catalogo" sc
        ON sc.id_servicio_catalogo = ao.id_servicio_catalogo
      INNER JOIN "Usuario" u
        ON u.id_usuario = ao.id_usuario
      LEFT JOIN "Usuario" tu
        ON tu.id_usuario = ao.id_tecnico_asignado
      ${whereSql}
      ORDER BY
        CASE ao.estado_trabajo
          WHEN 'RECIBIDO' THEN 1
          WHEN 'EN_PROCESO' THEN 2
          WHEN 'LAVADO' THEN 3
          WHEN 'FINALIZADO' THEN 4
          WHEN 'ENTREGADO' THEN 5
          ELSE 99
        END ASC,
        ao.fecha DESC
      LIMIT $${index}
    `,
    [...params, limitNormalizado]
  );

  return result.rows;
};

export const asignarTecnicoOrdenAutolavado = async (
  idAutolavadoOrden,
  idTecnicoAsignado = null,
  actorId = null
) => {
  const idOrden = Number(idAutolavadoOrden);
  const tecnicoId =
    idTecnicoAsignado == null || idTecnicoAsignado === ""
      ? null
      : Number(idTecnicoAsignado);

  if (tecnicoId !== null) {
    const tecnico = await getTecnicoAsignableById(tecnicoId);
    if (!tecnico) {
      const error = new Error("Tecnico no disponible para asignacion");
      error.statusCode = 404;
      throw error;
    }
  }

  const result = await pool.query(
    `
      UPDATE "Autolavado_orden"
      SET id_tecnico_asignado = $1,
          tecnico_asignado_en = CASE WHEN $1 IS NULL THEN NULL ELSE now() END,
          tecnico_asignado_por = CASE WHEN $1 IS NULL THEN NULL ELSE $2 END,
          updated_by = $2
      WHERE id_autolavado_orden = $3
      RETURNING
        id_autolavado_orden,
        id_tecnico_asignado,
        tecnico_asignado_en,
        tecnico_asignado_por
    `,
    [tecnicoId, actorId, idOrden]
  );

  return result.rows[0] || null;
};

export const updateEstadoOrdenAutolavado = async (
  idAutolavadoOrden,
  estadoTrabajo,
  actorId = null
) => {
  const estadoNormalizado = String(estadoTrabajo || "").trim().toUpperCase();
  if (!ESTADOS_ORDEN_AUTOLAVADO.includes(estadoNormalizado)) {
    throw new Error("estado_trabajo invalido");
  }

  const actualResult = await pool.query(
    `
      SELECT id_autolavado_orden, estado_trabajo
      FROM "Autolavado_orden"
      WHERE id_autolavado_orden = $1
      LIMIT 1
    `,
    [Number(idAutolavadoOrden)]
  );

  const ordenActual = actualResult.rows[0];
  if (!ordenActual) {
    return null;
  }

  if (
    !canMoveToNextEstado(
      ordenActual.estado_trabajo,
      estadoNormalizado,
      ESTADOS_ORDEN_AUTOLAVADO
    )
  ) {
    throw new Error("Solo puedes avanzar al siguiente estado del flujo");
  }

  const result = await pool.query(
    `
      UPDATE "Autolavado_orden"
      SET estado_trabajo = $1::character varying(20),
          fecha_inicio_proceso = CASE
            WHEN $1::character varying(20) = 'EN_PROCESO' THEN COALESCE(fecha_inicio_proceso, now())
            ELSE fecha_inicio_proceso
          END,
          fecha_lavado = CASE
            WHEN $1::character varying(20) = 'LAVADO' THEN COALESCE(fecha_lavado, now())
            ELSE fecha_lavado
          END,
          fecha_finalizado = CASE
            WHEN $1::character varying(20) = 'FINALIZADO' THEN COALESCE(fecha_finalizado, now())
            ELSE fecha_finalizado
          END,
          fecha_entregado = CASE
            WHEN $1::character varying(20) = 'ENTREGADO' THEN COALESCE(fecha_entregado, now())
            ELSE fecha_entregado
          END,
          updated_by = $2::int
      WHERE id_autolavado_orden = $3::int
      RETURNING
        id_autolavado_orden,
        estado_trabajo,
        fecha_inicio_proceso,
        fecha_lavado,
        fecha_finalizado,
        fecha_entregado
    `,
    [estadoNormalizado, actorId, Number(idAutolavadoOrden)]
  );

  return result.rows[0];
};

export const getOrdenesReparacion = async ({ estadoTrabajo = "TODOS", limit = 30 } = {}) => {
  const limitNormalizado = Math.min(100, Math.max(1, Number(limit) || 30));
  const estadoNormalizado = String(estadoTrabajo || "TODOS").trim().toUpperCase();
  const params = [];
  const where = [];
  let index = 1;

  if (estadoNormalizado !== "TODOS") {
    where.push(`ro.estado_trabajo = $${index++}`);
    params.push(estadoNormalizado);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const result = await pool.query(
    `
      SELECT
        ro.id_reparacion_orden,
        ro.id_tipo_vehiculo,
        ro.id_servicio_catalogo,
        ro.id_usuario,
        ro.id_caja_sesion,
        ro.id_sucursal,
        ro.nombre_cliente,
        ro.placa,
        ro.color,
        ro.kilometraje,
        ro.diagnostico_inicial,
        ro.observaciones,
        ro.metodo_pago,
        ro.precio_servicio,
        ro.monto_cobrado,
        ro.monto_recibido,
        ro.vuelto,
        ro.estado,
        ro.estado_trabajo,
        ro.fecha,
        ro.fecha_diagnostico,
        ro.fecha_en_reparacion,
        ro.fecha_pruebas,
        ro.fecha_listo,
        ro.fecha_entregado,
        ro.id_tecnico_asignado,
        ro.tecnico_asignado_en,
        ro.tecnico_asignado_por,
        stv.nombre AS tipo_vehiculo_nombre,
        stv.icono AS tipo_vehiculo_icono,
        sc.nombre AS servicio_nombre,
        sc.duracion_minutos,
        u.nombre AS usuario_nombre,
        u.username,
        tu.nombre AS tecnico_nombre,
        tu.username AS tecnico_username,
        COALESCE(repuestos.productos_usados, '[]'::json) AS productos_usados,
        COALESCE(repuestos.productos_cantidad_total, 0) AS productos_cantidad_total,
        COALESCE(repuestos.productos_total_cobrado, 0) AS productos_total_cobrado
      FROM "Reparacion_orden" ro
      INNER JOIN "Servicio_tipo_vehiculo" stv
        ON stv.id_tipo_vehiculo = ro.id_tipo_vehiculo
      INNER JOIN "Servicio_catalogo" sc
        ON sc.id_servicio_catalogo = ro.id_servicio_catalogo
      INNER JOIN "Usuario" u
        ON u.id_usuario = ro.id_usuario
      LEFT JOIN "Usuario" tu
        ON tu.id_usuario = ro.id_tecnico_asignado
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            json_agg(
              json_build_object(
                'id_reparacion_orden_producto', rop.id_reparacion_orden_producto,
                'id_producto', rop.id_producto,
                'producto_nombre', p.nombre,
                'codigo_barras', p.codigo_barras,
                'cantidad', rop.cantidad,
                'precio_unitario', rop.precio_unitario,
                'precio_compra_unitario', rop.precio_compra_unitario,
                'cobra_al_cliente', rop.cobra_al_cliente,
                'subtotal_cobrado', rop.subtotal_cobrado,
                'fecha', rop.fecha
              )
              ORDER BY rop.fecha DESC, rop.id_reparacion_orden_producto DESC
            ) FILTER (WHERE rop.id_reparacion_orden_producto IS NOT NULL),
            '[]'::json
          ) AS productos_usados,
          COALESCE(SUM(rop.cantidad), 0) AS productos_cantidad_total,
          COALESCE(SUM(rop.subtotal_cobrado), 0) AS productos_total_cobrado
        FROM "Reparacion_orden_producto" rop
        INNER JOIN "Producto" p
          ON p.id_producto = rop.id_producto
        WHERE rop.id_reparacion_orden = ro.id_reparacion_orden
      ) repuestos ON true
      ${whereSql}
      ORDER BY
        CASE ro.estado_trabajo
          WHEN 'RECIBIDO' THEN 1
          WHEN 'DIAGNOSTICO' THEN 2
          WHEN 'EN_REPARACION' THEN 3
          WHEN 'PRUEBAS' THEN 4
          WHEN 'LISTO' THEN 5
          WHEN 'ENTREGADO' THEN 6
          ELSE 99
        END ASC,
        ro.fecha DESC
      LIMIT $${index}
    `,
    [...params, limitNormalizado]
  );

  return result.rows;
};

export const asignarTecnicoOrdenReparacion = async (
  idReparacionOrden,
  idTecnicoAsignado = null,
  actorId = null
) => {
  const idOrden = Number(idReparacionOrden);
  const tecnicoId =
    idTecnicoAsignado == null || idTecnicoAsignado === ""
      ? null
      : Number(idTecnicoAsignado);

  if (tecnicoId !== null) {
    const tecnico = await getTecnicoAsignableById(tecnicoId);
    if (!tecnico) {
      const error = new Error("Tecnico no disponible para asignacion");
      error.statusCode = 404;
      throw error;
    }
  }

  const result = await pool.query(
    `
      UPDATE "Reparacion_orden"
      SET id_tecnico_asignado = $1,
          tecnico_asignado_en = CASE WHEN $1 IS NULL THEN NULL ELSE now() END,
          tecnico_asignado_por = CASE WHEN $1 IS NULL THEN NULL ELSE $2 END,
          updated_by = $2
      WHERE id_reparacion_orden = $3
      RETURNING
        id_reparacion_orden,
        id_tecnico_asignado,
        tecnico_asignado_en,
        tecnico_asignado_por
    `,
    [tecnicoId, actorId, idOrden]
  );

  return result.rows[0] || null;
};

export const updateEstadoOrdenReparacion = async (
  idReparacionOrden,
  estadoTrabajo,
  actorId = null
) => {
  const estadoNormalizado = String(estadoTrabajo || "").trim().toUpperCase();
  if (!ESTADOS_ORDEN_REPARACION.includes(estadoNormalizado)) {
    throw new Error("estado_trabajo invalido");
  }

  const actualResult = await pool.query(
    `
      SELECT id_reparacion_orden, estado_trabajo
      FROM "Reparacion_orden"
      WHERE id_reparacion_orden = $1
      LIMIT 1
    `,
    [Number(idReparacionOrden)]
  );

  const ordenActual = actualResult.rows[0];
  if (!ordenActual) {
    return null;
  }

  if (
    !canMoveToNextEstado(
      ordenActual.estado_trabajo,
      estadoNormalizado,
      ESTADOS_ORDEN_REPARACION
    )
  ) {
    throw new Error("Solo puedes avanzar al siguiente estado del flujo");
  }

  const result = await pool.query(
    `
      UPDATE "Reparacion_orden"
      SET estado_trabajo = $1::character varying(20),
          fecha_diagnostico = CASE
            WHEN $1::character varying(20) = 'DIAGNOSTICO' THEN COALESCE(fecha_diagnostico, now())
            ELSE fecha_diagnostico
          END,
          fecha_en_reparacion = CASE
            WHEN $1::character varying(20) = 'EN_REPARACION' THEN COALESCE(fecha_en_reparacion, now())
            ELSE fecha_en_reparacion
          END,
          fecha_pruebas = CASE
            WHEN $1::character varying(20) = 'PRUEBAS' THEN COALESCE(fecha_pruebas, now())
            ELSE fecha_pruebas
          END,
          fecha_listo = CASE
            WHEN $1::character varying(20) = 'LISTO' THEN COALESCE(fecha_listo, now())
            ELSE fecha_listo
          END,
          fecha_entregado = CASE
            WHEN $1::character varying(20) = 'ENTREGADO' THEN COALESCE(fecha_entregado, now())
            ELSE fecha_entregado
          END,
          updated_by = $2::int
      WHERE id_reparacion_orden = $3::int
      RETURNING
        id_reparacion_orden,
        estado_trabajo,
        fecha_diagnostico,
        fecha_en_reparacion,
        fecha_pruebas,
        fecha_listo,
        fecha_entregado
    `,
    [estadoNormalizado, actorId, Number(idReparacionOrden)]
  );

  return result.rows[0];
};
