/**
 * Cliente S3 compartido + helpers de presigned URLs y upload.
 *
 * Compatibilidad: AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, Backblaze
 * B2 — todos hablan S3 API. Configurar via env:
 *   S3_ENDPOINT (omitir para AWS)
 *   S3_REGION
 *   S3_BUCKET
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   S3_PUBLIC_URL_BASE (opcional: si servis publico via CDN, ej. cdn.tu-saas.com)
 *
 * Si S3_BUCKET no esta definido, las funciones lanzan HttpError 503 — el
 * resto del codigo sigue funcionando para uploads que NO usan S3.
 */
import crypto from "node:crypto";
import { HttpError } from "../http/http-error.js";
import { logger } from "../logging/logger.js";

let s3Client = null;
let getSignedUrlFn = null;
let initError = null;

const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_ENDPOINT = process.env.S3_ENDPOINT || undefined;
const S3_REGION = process.env.S3_REGION || "us-east-1";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "";
const S3_PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE || "";

const ensureClient = async () => {
  if (s3Client) return s3Client;
  if (initError) throw initError;
  if (!S3_BUCKET) {
    initError = HttpError.serviceUnavailable(
      "Storage no esta configurado: S3_BUCKET no esta seteada"
    );
    throw initError;
  }
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    initError = HttpError.serviceUnavailable(
      "Storage no esta configurado: S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY faltantes"
    );
    throw initError;
  }
  try {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const presigner = await import("@aws-sdk/s3-request-presigner");
    getSignedUrlFn = presigner.getSignedUrl;
    s3Client = new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT, // si null usa AWS default
      forcePathStyle: Boolean(S3_ENDPOINT), // requerido para R2/MinIO
      credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
      },
    });
    logger.info(
      { bucket: S3_BUCKET, region: S3_REGION, endpoint: S3_ENDPOINT || "aws" },
      "S3 client inicializado"
    );
    return s3Client;
  } catch (err) {
    initError = err;
    throw err;
  }
};

export const storageAvailable = () => Boolean(S3_BUCKET);

const sanitizeFilename = (raw) =>
  String(raw || "file")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);

/**
 * Genera una key S3 deterministica:
 *   <idEmpresa>/<categoria>/<yyyy-mm>/<random-id>-<filename>
 */
export const buildS3Key = ({ idEmpresa, categoria, filename }) => {
  const yyyymm = new Date().toISOString().slice(0, 7); // 2026-05
  const rand = crypto.randomBytes(6).toString("hex");
  const safe = sanitizeFilename(filename);
  return `${idEmpresa}/${String(categoria || "ATTACHMENT").toLowerCase()}/${yyyymm}/${rand}-${safe}`;
};

/**
 * Sube un Buffer directo al bucket. Devuelve { bucket, key, size, checksum }.
 */
export const uploadBuffer = async ({
  buffer,
  key,
  mimeType = "application/octet-stream",
  publico = false,
}) => {
  const client = await ensureClient();
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");

  const checksum = crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ContentLength: buffer.length,
      // ACL: publico ? "public-read" : undefined,  // R2 ignora ACL; usar CDN
    })
  );

  return {
    bucket: S3_BUCKET,
    key,
    size_bytes: buffer.length,
    checksum_sha256: checksum,
    mime_type: mimeType,
  };
};

/**
 * Devuelve una presigned URL temporal de GET (default 1 hora).
 * Para archivos publicos servidos via CDN, usa publicUrl().
 */
export const getPresignedGetUrl = async ({ bucket, key, expiresInSec = 3600 }) => {
  const client = await ensureClient();
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  return getSignedUrlFn(
    client,
    new GetObjectCommand({ Bucket: bucket || S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
};

/**
 * Presigned URL para PUT (cliente sube directo a S3 sin pasar por el API).
 * Util para archivos grandes. Default 10min.
 */
export const getPresignedPutUrl = async ({
  bucket,
  key,
  mimeType = "application/octet-stream",
  expiresInSec = 600,
}) => {
  const client = await ensureClient();
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  return getSignedUrlFn(
    client,
    new PutObjectCommand({
      Bucket: bucket || S3_BUCKET,
      Key: key,
      ContentType: mimeType,
    }),
    { expiresIn: expiresInSec }
  );
};

export const deleteObject = async ({ bucket, key }) => {
  const client = await ensureClient();
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  await client.send(
    new DeleteObjectCommand({ Bucket: bucket || S3_BUCKET, Key: key })
  );
};

/**
 * URL publica via CDN (si configurado), sino devuelve null (usar presigned).
 */
export const publicUrl = (key) => {
  if (!S3_PUBLIC_URL_BASE) return null;
  return `${S3_PUBLIC_URL_BASE.replace(/\/$/, "")}/${key}`;
};
