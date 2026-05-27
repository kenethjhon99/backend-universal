# Runbook de Produccion Empresarial

Este runbook define el minimo operativo para vender el SaaS POS + CarWash con confianza.

## Checklist predeploy

1. Ejecutar pruebas:
   ```bash
   npm run typecheck
   npm test -- --run
   ```
2. Revisar migraciones pendientes:
   ```bash
   npm run db:migrate:dry-run
   ```
3. Si es una base ya existente que nunca uso `app_migrations`, registrar baseline una sola vez:
   ```bash
   npm run db:migrate:baseline
   ```
4. Aplicar migraciones en ventana controlada:
   ```bash
   npm run db:migrate
   ```
5. Verificar readiness:
   ```bash
   SAAS_API_URL=https://api.tu-dominio.com/api/saas npm run ops:check
   ```
6. Confirmar que `/metrics` esta protegido si es publico.
7. Confirmar backup reciente y restore probado.

## Variables obligatorias en produccion

| Variable | Motivo |
|---|---|
| `NODE_ENV=production` | Activa guardas estrictas |
| `JWT_SECRET` | Minimo 32 chars, no placeholder |
| `PGUSER=saas_app` | Rol sin `BYPASSRLS` |
| `PGPASSWORD` | Credencial del rol app |
| `PGDATABASE` | Base principal |
| `PGHOST` | Host Postgres |
| `REDIS_URL` | Rate limit distribuido y workers |
| `CORS_ORIGINS` | Dominios permitidos |
| `METRICS_TOKEN` | Protege Prometheus si esta expuesto |
| `SENTRY_DSN` | Captura de errores |
| `S3_BUCKET` | Archivos/backups externos |

## Health endpoints

| Endpoint | Uso | Publico |
|---|---|---|
| `/api/saas/live` | Liveness del proceso | Si |
| `/api/saas/health` | Compat health simple | Si |
| `/api/saas/ready` | DB, migraciones, runtime y queue | Si, sin secretos |
| `/metrics` | Prometheus | Solo con token/red privada |

## Backups

Backup diario:

```bash
BACKUP_DIR=/var/backups/saas RETENTION_DAYS=30 ./scripts/backup-saas.sh
```

Restore drill trimestral:

```bash
PGDATABASE=pos_saas_restore_test FORCE=1 ./scripts/restore-saas.sh ./backups/ultimo.sql.gz
```

El restore contra produccion solo se ejecuta en incidente real y con aprobacion del responsable tecnico.

## Rollback

1. No revertir migraciones destructivamente.
2. Revertir aplicacion al release anterior.
3. Si el nuevo release aplico migraciones compatibles, mantener BD.
4. Si hay corrupcion funcional, restaurar backup en BD paralela.
5. Validar login, venta, caja, inventario y CarWash antes de promover.

## Incidentes

Severidades:

| Severidad | Definicion | Respuesta objetivo |
|---|---|---|
| SEV1 | Sistema caido o fuga de datos | 15 min |
| SEV2 | POS/caja no opera para multiples clientes | 30 min |
| SEV3 | Modulo parcial fallando | 4 h |
| SEV4 | Bug menor o solicitud operativa | 1-2 dias |

Primeros 10 minutos:

1. Revisar `/api/saas/ready`.
2. Revisar error rate y latencia en Prometheus/Grafana.
3. Revisar Sentry por release.
4. Revisar logs JSON por `requestId`, `empresaId`, `userId`.
5. Decidir: rollback app, deshabilitar modulo/add-on, o activar modo mantenimiento operativo.

## Smoke test comercial

Despues de deploy:

1. Login con admin empresa.
2. Crear venta contado.
3. Ver impacto en caja y stock.
4. Cerrar caja de prueba.
5. Crear orden CarWash y cobrarla.
6. Ver reportes base.
7. Validar branding/login en dominio white label si aplica.
