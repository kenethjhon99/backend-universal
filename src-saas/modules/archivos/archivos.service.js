/**
 * Servicio archivos: registra metadatos de uploads + delega binarios a S3.
 *
 * Flujo upload directo (server-side, archivo pasa por el API):
 *   POST /archivos  multipart/form-data { file, categoria, entidad?, entidad_id? }
 *   → service.uploadDirect → S3.uploadBuffer → insert archivos
 *
 * Flujo upload via presigned (cliente sube directo a S3):
 *   POST /archivos/presigned-put { filename, mime_type, categoria, ... }
 *   → service.preparePresignedPut → devuelve {url, key, archivo_id}
 *   (cliente hace PUT a url, luego):
 *   POST /archivos/:id/confirmar { size_bytes, checksum }
 *   → service.confirmUpload → actualiza metadatos
 */
import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import {
  buildS3Key,
  deleteObject,
  getPresignedGetUrl,
  getPresignedPutUrl,
  publicUrl,
  storageAvailable,
  uploadBuffer,
} from "../../shared/storage/s3.js";

const resolveDb = (db) => db || pool;

const VALID_CATEGORIAS = new Set([
  "LOGO",
  "COMPROBANTE_PDF",
  "PRODUCTO_IMG",
  "TICKET_EXPORT",
  "INVOICE_PDF",
  "ATTACHMENT",
]);

const sanitizeCategoria = (raw) => {
  const code = String(raw || "").trim().toUpperCase();
  if (!VALID_CATEGORIAS.has(code)) {
    throw HttpError.badRequest(
      `categoria invalida. Validas: ${[...VALID_CATEGORIAS].join(", ")}`
    );
  }
  return code;
};

/**
 * Upload directo: file pasa por el API (multer pone req.file).
 * Util para archivos <5MB. Para PDFs grandes, usar presigned-put.
 */
export const uploadDirect = async ({
  auth,
  file,
  categoria,
  entidad,
  entidadId,
  publico = false,
  requestMeta,
}) => {
  if (!storageAvailable()) {
    throw HttpError.serviceUnavailable("Storage no disponible (S3 no configurado)");
  }
  if (!file?.buffer) {
    throw HttpError.badRequest("file requerido en el formulario");
  }
  const cat = sanitizeCategoria(categoria);

  const key = buildS3Key({
    idEmpresa: auth.id_empresa,
    categoria: cat,
    filename: file.originalname,
  });

  const upload = await uploadBuffer({
    buffer: file.buffer,
    key,
    mimeType: file.mimetype,
    publico,
  });

  const r = await pool.query(
    `insert into archivos (
       id_empresa, categoria, nombre_original,
       s3_bucket, s3_key, mime_type, size_bytes, checksum_sha256,
       entidad, entidad_id, publico,
       created_by, updated_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
     returning *`,
    [
      auth.id_empresa,
      cat,
      file.originalname || "file",
      upload.bucket,
      upload.key,
      upload.mime_type,
      upload.size_bytes,
      upload.checksum_sha256,
      entidad || null,
      entidadId || null,
      Boolean(publico),
      auth.id_usuario,
    ]
  );

  await writeAuditEvent(pool, {
    auth,
    requestMeta,
    modulo: "ARCHIVOS",
    entidad: "ARCHIVO",
    entidadId: r.rows[0].id_archivo,
    accion: "UPLOAD",
    despues: {
      categoria: cat,
      size_bytes: upload.size_bytes,
      mime_type: upload.mime_type,
    },
  });

  return r.rows[0];
};

/**
 * Genera una URL presigned PUT para que el cliente suba directo a S3 sin
 * pasar por el API. Crea registro `archivos` en estado "pendiente" (size=null).
 */
export const preparePresignedPut = async ({ auth, body }) => {
  if (!storageAvailable()) {
    throw HttpError.serviceUnavailable("Storage no disponible (S3 no configurado)");
  }
  const cat = sanitizeCategoria(body?.categoria);
  const filename = String(body?.filename || "").trim();
  const mimeType = String(body?.mime_type || "application/octet-stream").trim();
  if (!filename) throw HttpError.badRequest("filename requerido");

  const key = buildS3Key({
    idEmpresa: auth.id_empresa,
    categoria: cat,
    filename,
  });

  const url = await getPresignedPutUrl({
    key,
    mimeType,
    expiresInSec: 600,
  });

  const inserted = await pool.query(
    `insert into archivos (
       id_empresa, categoria, nombre_original,
       s3_bucket, s3_key, mime_type,
       entidad, entidad_id, publico,
       metadata, created_by, updated_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{"pending":true}'::jsonb,$10,$10)
     returning id_archivo, s3_bucket, s3_key`,
    [
      auth.id_empresa,
      cat,
      filename,
      process.env.S3_BUCKET || "",
      key,
      mimeType,
      body?.entidad || null,
      body?.entidad_id || null,
      Boolean(body?.publico),
      auth.id_usuario,
    ]
  );

  return {
    upload_url: url,
    method: "PUT",
    headers: { "Content-Type": mimeType },
    expires_in: 600,
    id_archivo: inserted.rows[0].id_archivo,
    s3_key: inserted.rows[0].s3_key,
  };
};

/**
 * Confirma que el cliente subio el archivo: actualiza size + checksum.
 * Lo que llega del cliente NO es 100% confiable; idealmente verificamos
 * con HEAD a S3, pero por simplicidad lo confiamos (proximamente: HEAD).
 */
export const confirmUpload = async ({ auth, idArchivo, body }) => {
  const cur = await pool.query(
    `select * from archivos where id_empresa = $1 and id_archivo = $2`,
    [auth.id_empresa, idArchivo]
  );
  if (cur.rowCount === 0) throw HttpError.notFound("Archivo no encontrado");

  const r = await pool.query(
    `update archivos
       set size_bytes = $1,
           checksum_sha256 = $2,
           metadata = (coalesce(metadata, '{}'::jsonb) - 'pending'),
           updated_by = $3
     where id_empresa = $4 and id_archivo = $5
     returning *`,
    [
      Number(body?.size_bytes || 0) || null,
      String(body?.checksum_sha256 || "").trim() || null,
      auth.id_usuario,
      auth.id_empresa,
      idArchivo,
    ]
  );

  return r.rows[0];
};

/**
 * Listado por empresa con filtros opcionales (categoria, entidad).
 */
export const listArchivos = async ({ db, auth, query }) => {
  const conn = resolveDb(db);
  const filters = ["id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.categoria) {
    filters.push(`categoria = $${i}`);
    params.push(String(query.categoria).toUpperCase());
    i += 1;
  }
  if (query?.entidad) {
    filters.push(`entidad = $${i}`);
    params.push(String(query.entidad).toUpperCase());
    i += 1;
  }
  if (query?.entidad_id) {
    filters.push(`entidad_id = $${i}`);
    params.push(Number(query.entidad_id));
    i += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 100, 500));
  params.push(limit);

  const r = await conn.query(
    `select id_archivo, id_empresa, categoria, nombre_original,
            s3_bucket, s3_key, mime_type, size_bytes, checksum_sha256,
            entidad, entidad_id, publico, created_at
     from archivos
     where ${filters.join(" and ")}
     order by created_at desc, id_archivo desc
     limit $${i}`,
    params
  );

  // Agregar URL pública si configurada, sino el cliente debe pedir presigned-get
  return r.rows.map((row) => ({
    ...row,
    public_url: row.publico ? publicUrl(row.s3_key) : null,
  }));
};

/**
 * Devuelve URL presigned de descarga (1h).
 */
export const getDownloadUrl = async ({ db, auth, idArchivo }) => {
  const conn = resolveDb(db);
  const r = await conn.query(
    `select s3_bucket, s3_key, nombre_original, mime_type
     from archivos where id_empresa = $1 and id_archivo = $2`,
    [auth.id_empresa, idArchivo]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Archivo no encontrado");

  const row = r.rows[0];
  const url = await getPresignedGetUrl({
    bucket: row.s3_bucket,
    key: row.s3_key,
    expiresInSec: 3600,
  });
  return {
    url,
    expires_in: 3600,
    filename: row.nombre_original,
    mime_type: row.mime_type,
  };
};

/**
 * Borra binario en S3 + fila en BD.
 */
export const deleteArchivo = async ({ auth, idArchivo, requestMeta }) => {
  const cur = await pool.query(
    `select * from archivos where id_empresa = $1 and id_archivo = $2`,
    [auth.id_empresa, idArchivo]
  );
  if (cur.rowCount === 0) throw HttpError.notFound("Archivo no encontrado");
  const row = cur.rows[0];

  try {
    await deleteObject({ bucket: row.s3_bucket, key: row.s3_key });
  } catch (err) {
    // Continuar igual con el DELETE en BD: el binario huerfano lo limpia un GC
    // (proximo milestone). Logear para visibilidad.
    // eslint-disable-next-line no-console
    console.warn("S3 delete fallo:", err.message);
  }

  await pool.query(
    `delete from archivos where id_empresa = $1 and id_archivo = $2`,
    [auth.id_empresa, idArchivo]
  );

  await writeAuditEvent(pool, {
    auth,
    requestMeta,
    modulo: "ARCHIVOS",
    entidad: "ARCHIVO",
    entidadId: idArchivo,
    accion: "DELETE",
    antes: { categoria: row.categoria, s3_key: row.s3_key },
  });

  return { ok: true };
};
