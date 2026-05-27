import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./archivos.service.js";

export const uploadDirect = asyncHandler(async (req, res) => {
  const data = await service.uploadDirect({
    auth: req.auth,
    file: req.file,
    categoria: req.body?.categoria,
    entidad: req.body?.entidad,
    entidadId: req.body?.entidad_id ? Number(req.body.entidad_id) : null,
    publico:
      req.body?.publico === "true" || req.body?.publico === true,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const preparePresignedPut = asyncHandler(async (req, res) => {
  const data = await service.preparePresignedPut({
    auth: req.auth,
    body: req.body || {},
  });
  res.json({ ok: true, ...data });
});

export const confirmUpload = asyncHandler(async (req, res) => {
  const data = await service.confirmUpload({
    auth: req.auth,
    idArchivo: Number(req.params.id),
    body: req.body || {},
  });
  res.json({ ok: true, data });
});

export const listArchivos = asyncHandler(async (req, res) => {
  const data = await service.listArchivos({
    db: req.db,
    auth: req.auth,
    query: req.query,
  });
  res.json({ ok: true, data });
});

export const getDownloadUrl = asyncHandler(async (req, res) => {
  const data = await service.getDownloadUrl({
    db: req.db,
    auth: req.auth,
    idArchivo: Number(req.params.id),
  });
  res.json({ ok: true, ...data });
});

export const deleteArchivo = asyncHandler(async (req, res) => {
  const data = await service.deleteArchivo({
    auth: req.auth,
    idArchivo: Number(req.params.id),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});
