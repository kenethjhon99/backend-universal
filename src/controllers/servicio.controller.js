import * as Servicio from "../models/servicio.model.js";

const normalizeTipoVehiculoPayload = (body = {}) => ({
  nombre: String(body.nombre || "").trim(),
  descripcion: String(body.descripcion || "").trim() || null,
  icono: String(body.icono || "directions_car").trim() || "directions_car",
});

const normalizeServicioPayload = (body = {}) => ({
  idTipoVehiculo: Number(body.id_tipo_vehiculo),
  nombre: String(body.nombre || "").trim(),
  descripcion: String(body.descripcion || "").trim() || null,
  precioBase: Number(body.precio_base),
  duracionMinutos: Number(body.duracion_minutos),
  icono: String(body.icono || "cleaning_services").trim() || "cleaning_services",
});

const normalizeCobroPayload = (body = {}) => ({
  idTipoVehiculo: Number(body.id_tipo_vehiculo),
  idServicioCatalogo: Number(body.id_servicio_catalogo),
  nombreCliente: String(body.nombre_cliente || "").trim() || null,
  placa: String(body.placa || "").trim() || null,
  color: String(body.color || "").trim() || null,
  observaciones: String(body.observaciones || "").trim() || null,
  metodoPago: String(body.metodo_pago || "EFECTIVO").trim() || "EFECTIVO",
  precioServicio:
    body.precio_servicio == null || body.precio_servicio === ""
      ? null
      : Number(body.precio_servicio),
  montoCobrado: Number(body.monto_cobrado),
  montoRecibido:
    body.monto_recibido == null || body.monto_recibido === ""
      ? null
      : Number(body.monto_recibido),
});

const normalizeOrdenReparacionPayload = (body = {}) => ({
  idTipoVehiculo: Number(body.id_tipo_vehiculo),
  idServicioCatalogo: Number(body.id_servicio_catalogo),
  nombreCliente: String(body.nombre_cliente || "").trim() || null,
  placa: String(body.placa || "").trim() || null,
  color: String(body.color || "").trim() || null,
  observaciones: String(body.observaciones || "").trim() || null,
});

const normalizeProductoOrdenPayload = (body = {}) => ({
  idProducto: Number(body.id_producto),
  cantidad: Number(body.cantidad),
  cobraAlCliente:
    body.cobra_al_cliente === undefined
      ? true
      : String(body.cobra_al_cliente).trim().toLowerCase() !== "false",
});

const normalizeTecnicoPayload = (body = {}) => ({
  idTecnico:
    body.id_tecnico == null || body.id_tecnico === ""
      ? null
      : Number(body.id_tecnico),
});

const normalizeNoCobroPayload = (body = {}) => ({
  noCobrar:
    body.no_cobrar === true ||
    String(body.no_cobrar || "").trim().toLowerCase() === "true",
  noCobradoMotivo: String(body.no_cobrado_motivo || "").trim() || null,
});

const normalizeProductosPayload = (items = []) =>
  Array.isArray(items)
    ? items.map((item) => normalizeProductoOrdenPayload(item))
    : [];

export const listarCatalogoAutolavado = async (req, res) => {
  try {
    const catalogo = await Servicio.getAutolavadoCatalogo();
    res.json({ ok: true, data: catalogo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const listarCatalogoReparacion = async (req, res) => {
  try {
    const catalogo = await Servicio.getReparacionCatalogo();
    res.json({ ok: true, data: catalogo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const crearTipoVehiculoAutolavado = async (req, res) => {
  try {
    const payload = normalizeTipoVehiculoPayload(req.body);

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    const vehiculo = await Servicio.createTipoVehiculo({
      ...payload,
      actorId: req.user?.id_usuario ?? null,
    });

    res.status(201).json({ ok: true, vehiculo });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const crearTipoVehiculoReparacion = async (req, res) => {
  try {
    const payload = normalizeTipoVehiculoPayload(req.body);

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    const vehiculo = await Servicio.createTipoVehiculo({
      modulo: "REPARACION",
      ...payload,
      actorId: req.user?.id_usuario ?? null,
    });

    res.status(201).json({ ok: true, vehiculo });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const actualizarTipoVehiculoAutolavado = async (req, res) => {
  try {
    const idTipoVehiculo = Number(req.params.id);
    const payload = normalizeTipoVehiculoPayload(req.body);

    if (!Number.isInteger(idTipoVehiculo) || idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    const vehiculo = await Servicio.updateTipoVehiculo(
      idTipoVehiculo,
      payload,
      req.user?.id_usuario ?? null
    );

    if (!vehiculo) {
      return res.status(404).json({ error: "Tipo de vehiculo no encontrado" });
    }

    res.json({ ok: true, vehiculo });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const actualizarTipoVehiculoReparacion = async (req, res) => {
  try {
    const idTipoVehiculo = Number(req.params.id);
    const payload = normalizeTipoVehiculoPayload(req.body);

    if (!Number.isInteger(idTipoVehiculo) || idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    const vehiculo = await Servicio.updateTipoVehiculo(
      idTipoVehiculo,
      { modulo: "REPARACION", ...payload },
      req.user?.id_usuario ?? null
    );

    if (!vehiculo) {
      return res.status(404).json({ error: "Tipo de vehiculo no encontrado" });
    }

    res.json({ ok: true, vehiculo });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const crearServicioAutolavado = async (req, res) => {
  try {
    const payload = normalizeServicioPayload(req.body);

    if (!Number.isInteger(payload.idTipoVehiculo) || payload.idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (!Number.isFinite(payload.precioBase) || payload.precioBase < 0) {
      return res.status(400).json({ error: "precio_base invalido" });
    }

    if (!Number.isInteger(payload.duracionMinutos) || payload.duracionMinutos <= 0) {
      return res.status(400).json({ error: "duracion_minutos invalido" });
    }

    const servicio = await Servicio.createServicioCatalogo({
      ...payload,
      actorId: req.user?.id_usuario ?? null,
    });

    res.status(201).json({ ok: true, servicio });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const crearServicioReparacion = async (req, res) => {
  try {
    const payload = normalizeServicioPayload(req.body);

    if (!Number.isInteger(payload.idTipoVehiculo) || payload.idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (!Number.isFinite(payload.precioBase) || payload.precioBase < 0) {
      return res.status(400).json({ error: "precio_base invalido" });
    }

    if (!Number.isInteger(payload.duracionMinutos) || payload.duracionMinutos <= 0) {
      return res.status(400).json({ error: "duracion_minutos invalido" });
    }

    const servicio = await Servicio.createServicioCatalogo({
      modulo: "REPARACION",
      ...payload,
      actorId: req.user?.id_usuario ?? null,
    });

    res.status(201).json({ ok: true, servicio });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const actualizarServicioAutolavado = async (req, res) => {
  try {
    const idServicioCatalogo = Number(req.params.id);
    const payload = normalizeServicioPayload(req.body);

    if (!Number.isInteger(idServicioCatalogo) || idServicioCatalogo <= 0) {
      return res.status(400).json({ error: "id_servicio_catalogo invalido" });
    }

    if (!Number.isInteger(payload.idTipoVehiculo) || payload.idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (!Number.isFinite(payload.precioBase) || payload.precioBase < 0) {
      return res.status(400).json({ error: "precio_base invalido" });
    }

    if (!Number.isInteger(payload.duracionMinutos) || payload.duracionMinutos <= 0) {
      return res.status(400).json({ error: "duracion_minutos invalido" });
    }

    const servicio = await Servicio.updateServicioCatalogo(
      idServicioCatalogo,
      payload,
      req.user?.id_usuario ?? null
    );

    if (!servicio) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    res.json({ ok: true, servicio });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const actualizarServicioReparacion = async (req, res) => {
  try {
    const idServicioCatalogo = Number(req.params.id);
    const payload = normalizeServicioPayload(req.body);

    if (!Number.isInteger(idServicioCatalogo) || idServicioCatalogo <= 0) {
      return res.status(400).json({ error: "id_servicio_catalogo invalido" });
    }

    if (!Number.isInteger(payload.idTipoVehiculo) || payload.idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (!Number.isFinite(payload.precioBase) || payload.precioBase < 0) {
      return res.status(400).json({ error: "precio_base invalido" });
    }

    if (!Number.isInteger(payload.duracionMinutos) || payload.duracionMinutos <= 0) {
      return res.status(400).json({ error: "duracion_minutos invalido" });
    }

    const servicio = await Servicio.updateServicioCatalogo(
      idServicioCatalogo,
      { modulo: "REPARACION", ...payload },
      req.user?.id_usuario ?? null
    );

    if (!servicio) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    res.json({ ok: true, servicio });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const cobrarServicioAutolavado = async (req, res) => {
  try {
    const payload = normalizeCobroPayload(req.body);
    const noCobro = normalizeNoCobroPayload(req.body);

    if (!Number.isInteger(payload.idTipoVehiculo) || payload.idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!Number.isInteger(payload.idServicioCatalogo) || payload.idServicioCatalogo <= 0) {
      return res.status(400).json({ error: "id_servicio_catalogo invalido" });
    }

    if (!Number.isFinite(payload.montoCobrado) || payload.montoCobrado <= 0) {
      return res.status(400).json({ error: "monto_cobrado invalido" });
    }

    if (noCobro.noCobrar) {
      if (!noCobro.noCobradoMotivo) {
        return res.status(400).json({ error: "Debes indicar el motivo del no cobro" });
      }
    }

    const data = await Servicio.registrarCobroAutolavado({
      ...payload,
      idUsuario: req.user?.id_usuario ?? null,
      idSucursal: Number(req.body?.id_sucursal || 1),
      noCobrar: noCobro.noCobrar,
      noCobradoMotivo: noCobro.noCobradoMotivo,
      noCobradoAutorizadoPor: null,
    });

    res.status(201).json({ ok: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const cobrarServicioReparacion = async (req, res) => {
  try {
    const payload = normalizeCobroPayload(req.body);
    const productos = normalizeProductosPayload(req.body?.productos);
    const noCobro = normalizeNoCobroPayload(req.body);

    if (!Number.isInteger(payload.idTipoVehiculo) || payload.idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!Number.isInteger(payload.idServicioCatalogo) || payload.idServicioCatalogo <= 0) {
      return res.status(400).json({ error: "id_servicio_catalogo invalido" });
    }

    if (!Number.isFinite(payload.montoCobrado) || payload.montoCobrado <= 0) {
      return res.status(400).json({ error: "monto_cobrado invalido" });
    }

    for (const producto of productos) {
      if (!Number.isInteger(producto.idProducto) || producto.idProducto <= 0) {
        return res.status(400).json({ error: "id_producto invalido en repuestos" });
      }

      if (!Number.isInteger(producto.cantidad) || producto.cantidad <= 0) {
        return res.status(400).json({ error: "cantidad invalida en repuestos" });
      }
    }

    if (noCobro.noCobrar) {
      if (!noCobro.noCobradoMotivo) {
        return res.status(400).json({ error: "Debes indicar el motivo del no cobro" });
      }
    }

    const data = await Servicio.registrarCobroReparacion({
      ...payload,
      kilometraje: req.body?.kilometraje,
      diagnosticoInicial: String(req.body?.diagnostico_inicial || "").trim() || null,
      productos,
      idUsuario: req.user?.id_usuario ?? null,
      idSucursal: Number(req.body?.id_sucursal || 1),
      noCobrar: noCobro.noCobrar,
      noCobradoMotivo: noCobro.noCobradoMotivo,
      noCobradoAutorizadoPor: null,
    });

    res.status(201).json({ ok: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const crearOrdenReparacion = async (req, res) => {
  try {
    const payload = normalizeOrdenReparacionPayload(req.body);

    if (!Number.isInteger(payload.idTipoVehiculo) || payload.idTipoVehiculo <= 0) {
      return res.status(400).json({ error: "id_tipo_vehiculo invalido" });
    }

    if (!Number.isInteger(payload.idServicioCatalogo) || payload.idServicioCatalogo <= 0) {
      return res.status(400).json({ error: "id_servicio_catalogo invalido" });
    }

    const data = await Servicio.crearOrdenReparacion({
      ...payload,
      kilometraje: req.body?.kilometraje,
      diagnosticoInicial: String(req.body?.diagnostico_inicial || "").trim() || null,
      idUsuario: req.user?.id_usuario ?? null,
      idSucursal: Number(req.body?.id_sucursal || 1),
    });

    res.status(201).json({ ok: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const cobrarOrdenReparacion = async (req, res) => {
  try {
    const idReparacionOrden = Number(req.params.id);
    const payload = normalizeCobroPayload(req.body);
    const noCobro = normalizeNoCobroPayload(req.body);

    if (!Number.isInteger(idReparacionOrden) || idReparacionOrden <= 0) {
      return res.status(400).json({ error: "id_reparacion_orden invalido" });
    }

    if (noCobro.noCobrar) {
      if (!noCobro.noCobradoMotivo) {
        return res.status(400).json({ error: "Debes indicar el motivo del no cobro" });
      }
    }

    const data = await Servicio.cobrarOrdenReparacion({
      idReparacionOrden,
      idUsuario: req.user?.id_usuario ?? null,
      metodoPago: payload.metodoPago,
      montoRecibido: payload.montoRecibido,
      noCobrar: noCobro.noCobrar,
      noCobradoMotivo: noCobro.noCobradoMotivo,
      noCobradoAutorizadoPor: null,
    });

    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const listarOrdenesAutolavado = async (req, res) => {
  try {
    const ordenes = await Servicio.getOrdenesAutolavado({
      estadoTrabajo: req.query?.estado_trabajo,
      limit: req.query?.limit,
    });

    res.json({ ok: true, data: ordenes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const listarOrdenesReparacion = async (req, res) => {
  try {
    const ordenes = await Servicio.getOrdenesReparacion({
      estadoTrabajo: req.query?.estado_trabajo,
      limit: req.query?.limit,
    });

    res.json({ ok: true, data: ordenes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const listarTecnicosAsignables = async (req, res) => {
  try {
    const tecnicos = await Servicio.getTecnicosAsignables();
    res.json({ ok: true, data: tecnicos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const agregarProductoOrdenReparacion = async (req, res) => {
  try {
    const idReparacionOrden = Number(req.params.id);
    const payload = normalizeProductoOrdenPayload(req.body);

    if (!Number.isInteger(idReparacionOrden) || idReparacionOrden <= 0) {
      return res.status(400).json({ error: "id_reparacion_orden invalido" });
    }

    if (!Number.isInteger(payload.idProducto) || payload.idProducto <= 0) {
      return res.status(400).json({ error: "id_producto invalido" });
    }

    if (!Number.isInteger(payload.cantidad) || payload.cantidad <= 0) {
      return res.status(400).json({ error: "cantidad invalida" });
    }

    const data = await Servicio.agregarProductoOrdenReparacion({
      idReparacionOrden,
      idProducto: payload.idProducto,
      cantidad: payload.cantidad,
      cobraAlCliente: payload.cobraAlCliente,
      actorId: req.user?.id_usuario ?? null,
    });

    res.status(201).json({ ok: true, ...data });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const actualizarEstadoOrdenAutolavado = async (req, res) => {
  try {
    const idAutolavadoOrden = Number(req.params.id);
    const estadoTrabajo = String(req.body?.estado_trabajo || "").trim();

    if (!Number.isInteger(idAutolavadoOrden) || idAutolavadoOrden <= 0) {
      return res.status(400).json({ error: "id_autolavado_orden invalido" });
    }

    if (!estadoTrabajo) {
      return res.status(400).json({ error: "estado_trabajo es requerido" });
    }

    const orden = await Servicio.updateEstadoOrdenAutolavado(
      idAutolavadoOrden,
      estadoTrabajo,
      req.user?.id_usuario ?? null
    );

    if (!orden) {
      return res.status(404).json({ error: "Orden de autolavado no encontrada" });
    }

    res.json({ ok: true, orden });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const asignarTecnicoOrdenAutolavado = async (req, res) => {
  try {
    const idAutolavadoOrden = Number(req.params.id);
    const payload = normalizeTecnicoPayload(req.body);

    if (!Number.isInteger(idAutolavadoOrden) || idAutolavadoOrden <= 0) {
      return res.status(400).json({ error: "id_autolavado_orden invalido" });
    }

    if (
      payload.idTecnico !== null &&
      (!Number.isInteger(payload.idTecnico) || payload.idTecnico <= 0)
    ) {
      return res.status(400).json({ error: "id_tecnico invalido" });
    }

    const orden = await Servicio.asignarTecnicoOrdenAutolavado(
      idAutolavadoOrden,
      payload.idTecnico,
      req.user?.id_usuario ?? null
    );

    if (!orden) {
      return res.status(404).json({ error: "Orden de autolavado no encontrada" });
    }

    res.json({ ok: true, orden });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const actualizarEstadoOrdenReparacion = async (req, res) => {
  try {
    const idReparacionOrden = Number(req.params.id);
    const estadoTrabajo = String(req.body?.estado_trabajo || "").trim();

    if (!Number.isInteger(idReparacionOrden) || idReparacionOrden <= 0) {
      return res.status(400).json({ error: "id_reparacion_orden invalido" });
    }

    if (!estadoTrabajo) {
      return res.status(400).json({ error: "estado_trabajo es requerido" });
    }

    const orden = await Servicio.updateEstadoOrdenReparacion(
      idReparacionOrden,
      estadoTrabajo,
      req.user?.id_usuario ?? null
    );

    if (!orden) {
      return res.status(404).json({ error: "Orden de reparacion no encontrada" });
    }

    res.json({ ok: true, orden });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};

export const asignarTecnicoOrdenReparacion = async (req, res) => {
  try {
    const idReparacionOrden = Number(req.params.id);
    const payload = normalizeTecnicoPayload(req.body);

    if (!Number.isInteger(idReparacionOrden) || idReparacionOrden <= 0) {
      return res.status(400).json({ error: "id_reparacion_orden invalido" });
    }

    if (
      payload.idTecnico !== null &&
      (!Number.isInteger(payload.idTecnico) || payload.idTecnico <= 0)
    ) {
      return res.status(400).json({ error: "id_tecnico invalido" });
    }

    const orden = await Servicio.asignarTecnicoOrdenReparacion(
      idReparacionOrden,
      payload.idTecnico,
      req.user?.id_usuario ?? null
    );

    if (!orden) {
      return res.status(404).json({ error: "Orden de reparacion no encontrada" });
    }

    res.json({ ok: true, orden });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};
