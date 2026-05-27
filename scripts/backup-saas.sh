#!/usr/bin/env bash
# Backup diario de la BD SaaS.
# Crea un dump comprimido con timestamp y aplica retencion configurable.
#
# Uso:
#   ./scripts/backup-saas.sh
#
# Variables (con default sensible):
#   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD  - credenciales
#   BACKUP_DIR        - directorio destino (default: ./backups)
#   RETENTION_DAYS    - dias a conservar (default: 30)
#   S3_BUCKET         - opcional, sube tambien a S3 (requiere aws cli)
#   GZIP_LEVEL        - compresion (default: 6)
#
# Para programarlo:
#   crontab -e
#   0 3 * * * /ruta/a/scripts/backup-saas.sh >> /var/log/saas-backup.log 2>&1

set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-pos_saas}"
PGUSER="${PGUSER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
GZIP_LEVEL="${GZIP_LEVEL:-6}"
S3_BUCKET="${S3_BUCKET:-}"

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/${PGDATABASE}_${TIMESTAMP}.sql.gz"

echo "[backup] iniciando dump de ${PGDATABASE} en ${DUMP_FILE}"

PGPASSWORD="${PGPASSWORD:-}" pg_dump \
  --host="${PGHOST}" \
  --port="${PGPORT}" \
  --username="${PGUSER}" \
  --dbname="${PGDATABASE}" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --verbose 2> >(tail -5 >&2) | gzip "-${GZIP_LEVEL}" > "${DUMP_FILE}"

DUMP_SIZE=$(du -h "${DUMP_FILE}" | cut -f1)
echo "[backup] dump completado: ${DUMP_FILE} (${DUMP_SIZE})"

# Subir a S3 si esta configurado
if [ -n "${S3_BUCKET}" ]; then
  if command -v aws >/dev/null 2>&1; then
    echo "[backup] subiendo a s3://${S3_BUCKET}/${PGDATABASE}/"
    aws s3 cp "${DUMP_FILE}" "s3://${S3_BUCKET}/${PGDATABASE}/$(basename "${DUMP_FILE}")"
    echo "[backup] subida completada"
  else
    echo "[backup] WARN: S3_BUCKET configurado pero aws cli no encontrado"
  fi
fi

# Retencion: borrar backups locales mas viejos que RETENTION_DAYS
echo "[backup] aplicando retencion (${RETENTION_DAYS} dias)"
find "${BACKUP_DIR}" -type f -name "${PGDATABASE}_*.sql.gz" -mtime +"${RETENTION_DAYS}" -print -delete

echo "[backup] OK"
