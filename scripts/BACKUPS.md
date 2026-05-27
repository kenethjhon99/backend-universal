# Backups y restauración

## Scripts

| Script | Para |
|---|---|
| `scripts/backup-saas.sh` | Hace `pg_dump` comprimido + retención + opcional S3 |
| `scripts/restore-saas.sh` | Restaura un dump en una BD destino (la recrea desde cero) |

## Backup diario en cron

```cron
# Backup diario a las 3 AM
0 3 * * * /opt/saas/scripts/backup-saas.sh >> /var/log/saas-backup.log 2>&1
```

Variables (en `/etc/environment` o exportadas):

```bash
export PGHOST=localhost
export PGPORT=5432
export PGDATABASE=pos_saas
export PGUSER=postgres
export PGPASSWORD=...
export BACKUP_DIR=/var/backups/saas
export RETENTION_DAYS=30
export S3_BUCKET=mi-bucket-saas-backups   # opcional
```

## Restaurar

```bash
# Listar backups disponibles
ls -lh ./backups/

# Restaurar uno
./scripts/restore-saas.sh ./backups/pos_saas_20260506_030000.sql.gz
# Te pide escribir el nombre exacto de la BD para confirmar.
# Para automatizar (peligroso): FORCE=1 ./scripts/restore-saas.sh ...
```

**Importante:** `restore-saas.sh` ejecuta `DROP DATABASE WITH (FORCE)` antes de
recrear, así que cualquier conexión activa se cierra. **NO ejecutes contra
producción salvo durante un disaster recovery real.**

## Drill trimestral

El workflow `.github/workflows/backup-restore-test.yml` corre el primer lunes
de cada trimestre (Ene/Abr/Jul/Oct) y valida:
1. Aplicar todas las migraciones a una BD limpia
2. Hacer backup
3. Restaurar el backup en otra BD
4. Comparar la cantidad de tablas en ambas

Si esto falla en el cron, sabes que el script de restore tiene un problema
**antes** de que lo necesites de verdad.

También se puede correr manualmente con `workflow_dispatch` desde la pestaña
Actions de GitHub.

## Política de retención sugerida

| Capa | Retención | Donde |
|---|---|---|
| Dumps diarios | 30 días | servidor de aplicación o NAS |
| Dumps semanales | 6 meses | bucket S3 cifrado, lifecycle a Glacier |
| Dumps mensuales | 5 años | S3 Glacier (cumplimiento fiscal) |

Para los semanales/mensuales, usa AWS S3 Lifecycle Rules sobre el `S3_BUCKET`
configurado:
- Mueve a Glacier después de 30 días
- Borra después de 5 años

## Verificación rápida de un dump

Antes de borrar un backup viejo, verifica que es válido:

```bash
gunzip -t pos_saas_20260506_030000.sql.gz && echo "gzip OK"

# Para verificación más profunda: restaurar a BD de prueba
PGDATABASE=pos_saas_verify FORCE=1 ./scripts/restore-saas.sh pos_saas_20260506_030000.sql.gz
```

## Disaster recovery checklist

1. Identificar el último dump válido en S3 o servidor.
2. `gunzip -t` para confirmar integridad.
3. Crear BD nueva temporal: `pos_saas_recovery`.
4. `PGDATABASE=pos_saas_recovery FORCE=1 ./scripts/restore-saas.sh dump.sql.gz`
5. Conectar el SaaS a `pos_saas_recovery` para validar (cambiar `PGDATABASE` y reiniciar).
6. Smoke test: login + venta de prueba.
7. Si OK, renombrar BDs:
   ```sql
   ALTER DATABASE pos_saas RENAME TO pos_saas_corrupted;
   ALTER DATABASE pos_saas_recovery RENAME TO pos_saas;
   ```
8. Reiniciar la app.
