#!/usr/bin/env bash
# Restaura un dump generado por backup-saas.sh.
# DESTRUYE la BD destino y la recrea desde cero.
#
# Uso:
#   ./scripts/restore-saas.sh ./backups/pos_saas_20260506_030000.sql.gz
#
# Variables:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE  (BD destino)
#   FORCE=1  para saltarse la confirmacion interactiva (cuidado!)

set -euo pipefail

DUMP_FILE="${1:-}"
if [ -z "${DUMP_FILE}" ] || [ ! -f "${DUMP_FILE}" ]; then
  echo "Uso: $0 <archivo.sql.gz>"
  echo "Archivos disponibles:"
  ls -lh ./backups/*.sql.gz 2>/dev/null || echo "  (no hay backups en ./backups)"
  exit 1
fi

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-pos_saas}"
PGUSER="${PGUSER:-postgres}"

echo "===================================================================="
echo "  RESTAURACION DE ${PGDATABASE}@${PGHOST}:${PGPORT}"
echo "  desde: ${DUMP_FILE}"
echo "  ESTO BORRA TODA LA BD DESTINO"
echo "===================================================================="

if [ "${FORCE:-0}" != "1" ]; then
  read -r -p "Escribe el nombre exacto de la BD para confirmar: " confirm
  if [ "${confirm}" != "${PGDATABASE}" ]; then
    echo "Confirmacion incorrecta. Abortado."
    exit 1
  fi
fi

# Conectar a postgres (BD admin) para hacer DROP/CREATE
echo "[restore] dropping y recreando ${PGDATABASE}"
PGPASSWORD="${PGPASSWORD:-}" psql \
  --host="${PGHOST}" \
  --port="${PGPORT}" \
  --username="${PGUSER}" \
  --dbname="postgres" \
  --quiet \
  -c "drop database if exists \"${PGDATABASE}\" with (force);" \
  -c "create database \"${PGDATABASE}\" owner \"${PGUSER}\";"

echo "[restore] cargando dump (puede tomar varios minutos)"
gunzip -c "${DUMP_FILE}" | PGPASSWORD="${PGPASSWORD:-}" psql \
  --host="${PGHOST}" \
  --port="${PGPORT}" \
  --username="${PGUSER}" \
  --dbname="${PGDATABASE}" \
  --quiet \
  --set ON_ERROR_STOP=on

echo "[restore] OK. Verificando tablas..."
PGPASSWORD="${PGPASSWORD:-}" psql \
  --host="${PGHOST}" \
  --port="${PGPORT}" \
  --username="${PGUSER}" \
  --dbname="${PGDATABASE}" \
  -c "select count(*) as tablas from information_schema.tables where table_schema = 'public';"

echo "[restore] DONE"
