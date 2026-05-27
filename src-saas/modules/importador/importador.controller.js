import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import { HttpError } from "../../shared/http/http-error.js";
import * as service from "./importador.service.js";

const getCsvText = (req) => {
  // Aceptar texto plano (Content-Type: text/csv) o JSON con { csv: "..." }
  if (typeof req.body === "string") return req.body;
  if (req.body?.csv && typeof req.body.csv === "string") return req.body.csv;
  throw HttpError.badRequest(
    "Envia el CSV como texto plano (text/csv) o como { csv: \"...\" }"
  );
};

const isDryRun = (req) =>
  String(req.query?.dry_run ?? "true").toLowerCase() !== "false";

export const importProductos = asyncHandler(async (req, res) => {
  const data = await service.importProductos({
    auth: req.auth,
    scope: req.scope,
    csvText: getCsvText(req),
    dryRun: isDryRun(req),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const importClientes = asyncHandler(async (req, res) => {
  const data = await service.importClientes({
    auth: req.auth,
    scope: req.scope,
    csvText: getCsvText(req),
    dryRun: isDryRun(req),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});
