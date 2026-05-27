# Migración Legacy → SaaS

Script para mover los datos del backend legacy (`src/`, schema PascalCase) al SaaS multi-tenant (`src-saas/`, schema snake_case con `id_empresa`).

## TL;DR

```bash
# 1) Aplica las migraciones SaaS hasta la 012 en la BD de SaaS
psql -d pos_saas -f database/migrations/001_multi_tenant_pos_init.sql
# ... 002 .. 012

# 2) Configura .env.migration con credenciales a ambas BDs
cp .env.migration.example .env.migration
# editar credenciales

# 3) Dry-run para inspeccionar
node scripts/migrate-legacy-to-saas.mjs --dry-run

# 4) Aplicar
node scripts/migrate-legacy-to-saas.mjs --apply
```

## Variables de entorno

`.env.migration` debe tener dos sets de variables. Si las dos BDs viven
en la misma instancia de Postgres, los hosts pueden ser iguales pero las
bases tienen que ser distintas.

```env
# BD legacy (POS viejo)
LEGACY_PGHOST=localhost
LEGACY_PGPORT=5432
LEGACY_PGDATABASE=pos_legacy
LEGACY_PGUSER=postgres
LEGACY_PGPASSWORD=postgres
LEGACY_PGSSLMODE=disable

# BD SaaS (destino)
SAAS_PGHOST=localhost
SAAS_PGPORT=5432
SAAS_PGDATABASE=pos_saas
SAAS_PGUSER=postgres
SAAS_PGPASSWORD=postgres
SAAS_PGSSLMODE=disable
```

## Banderas

| Bandera | Default | Descripción |
|--------|--------|-------------|
| `--dry-run` | ✅ | Solo lee del legacy, reporta conteos. **Default si no pasas `--apply`.** |
| `--apply` | — | Inserta en el SaaS. |
| `--empresa-slug=...` | `legacy-pos` | Slug de la empresa destino. |
| `--empresa-nombre=...` | `Empresa Legacy` | Nombre legal. |
| `--reset-mapping` | — | Borra `migration_mapping` antes (cuidado: pierde idempotencia). |
| `--skip=ventas,caja_movimientos,...` | — | Omite secciones específicas. |

## Idempotencia

El script usa una tabla `migration_mapping` en la BD SaaS:

```
entidad | legacy_id | saas_id | id_empresa | migrated_at
```

Cualquier registro ya migrado se saltea. Puedes correr `--apply` muchas
veces y solo se procesarán los nuevos / pendientes.

## Orden de migración

1. **Roles** (asegura que existan los 4 SaaS).
2. **Usuarios** (con `Persona`, mapeo de roles legacy → SaaS, alta en `usuarios_sucursales`).
3. **Clientes**.
4. **Proveedores**.
5. **Productos** + `stock_sucursal` por producto en sucursal default.
6. **Caja sesiones** (estado y montos).
7. **Caja movimientos** (con autorización admin si existía).
8. **Compras** + detalles.
9. **Ventas** + detalles + reversiones (parciales calculadas desde `cantidad_anulada`).
10. **Ordenes de servicio** (Autolavado y Reparación se unifican en `ordenes_servicio` con `modulo`).

## Mapeo de roles

| Legacy | SaaS |
|--------|------|
| `SUPER_ADMIN` / `SUPERADMIN` | `SUPER_ADMIN` |
| `ADMIN` | `ADMIN_EMPRESA` |
| `ENCARGADO_SERVICIOS` | `ENCARGADO_SUCURSAL` |
| `CAJERO`, `MECANICO`, `LECTURA` | `CAJERO` |

`MECANICO` y `LECTURA` no existen en el SaaS; se mapean a `CAJERO`.
Si necesitas distinguirlos en el futuro, tendrás que crear roles
custom y reasignar.

## Mapeo de estados

### Ventas
- Legacy `ANULADA` → SaaS `ANULADA` (estado_reversion='SIN_REVERSION', no toca CXC).
- Legacy `NO_COBRADO` → SaaS `NO_COBRADO` (con motivo y autorización si existían).
- Cualquier otro → `CONFIRMADA`.
- `cantidad_anulada` por línea → se suma al `monto_revertido` y `estado_reversion` se calcula
  (`SIN_REVERSION` / `PARCIAL` / `TOTAL`). **Nota:** las reversiones detalladas
  (cabecera `venta_reversiones` con sus líneas `venta_reversion_detalles`) NO se sintetizan
  desde el legacy en esta versión — solo se preserva el monto agregado en `monto_revertido`.
  Si necesitas la reconstrucción línea por línea, puedes agregarlo después leyendo
  `Detalle_venta_anulacion`.

### Compras
- Legacy `ANULADA` → SaaS `ANULADA`.
- Cualquier otro → `CONFIRMADA`.

### Órdenes de servicio
| Legacy `estado_trabajo` | SaaS `estado` |
|---|---|
| `RECIBIDO`, `EN_DIAGNOSTICO` | `RECIBIDO` |
| `EN_PROCESO`, `EN_REPARACION`, `LAVANDO`, `PRUEBAS` | `EN_PROCESO` |
| `LAVADO`, `FINALIZADO`, `LISTO` | `LISTO` |
| `ENTREGADO` | `ENTREGADO` |
| `ANULADA` | `ANULADA` |

## Lo que NO migra

- `Comprobante_serie` legacy → SaaS arranca correlativo en 0 con la migración 009
  (se autocrean al primer uso por sucursal).
- `Detalle_venta_anulacion` (reversiones detalladas) → se condensa en `monto_revertido`.
- Catálogo de servicios en `Servicio_catalogo` → se migran solo los servicios
  efectivamente usados por órdenes (se crea uno por slug visto).
- Auditoría legacy → SaaS arranca con `auditoria_eventos` vacío.
- Cuentas por cobrar / por pagar → si tenías ventas a crédito, se marcan como CREDITO
  pero **no se generan los registros en `cuentas_por_cobrar`**. Después del cutover,
  ejecuta el job de upsert manualmente (ver `shared/finance/accounts.js`).

## Verificación post-migración

El script al final imprime:

```
usuarios_legacy: 12
usuarios_saas:    12
productos_legacy: 340
productos_saas:   340
ventas_legacy:    8421
ventas_saas:      8421
compras_legacy:   223
compras_saas:     223
```

Si los contadores no coinciden, revisa el log para encontrar `skipped` con razones
(ej. usuarios sin password_hash, productos sin nombre, ventas con id_usuario huérfano).

## Plan de cutover sugerido

1. **Backup** de la BD legacy.
2. Aplicar todas las migraciones SaaS (001..012) sobre `pos_saas`.
3. Correr `--dry-run`. Validar conteos esperados.
4. Activar **modo lectura** en la app legacy (sin nuevas ventas/compras).
5. Correr `--apply`.
6. Verificar conteos.
7. Apuntar el frontend SaaS a la BD migrada y abrir paralelo.
8. **Smoke test**: login con cada rol, abrir caja, hacer una venta de prueba, anular, cerrar caja.
9. Cuando todo OK: deprecar `src/` legacy en `package.json`, renombrar `saas.html` → `index.html`.

## Resolución de problemas

**Error: "El cliente no pertenece a la empresa activa"**
Algún usuario migrado intentó usar un cliente de otra empresa. Verifica que los
mapeos cliente legacy → cliente SaaS estén completos. Si necesitas re-migrar, usa
`--reset-mapping`.

**Conteo de ventas SaaS < legacy**
- Causa común: ventas legacy con `id_usuario` que apunta a un usuario que no se
  migró (porque tenía `username` vacío). El script las saltea.
- Solución: ejecuta el script con `--skip=ventas` y migra primero esos usuarios
  manualmente, luego corre solo `--apply` (la idempotencia hace el resto).

**Passwords no funcionan después de migrar**
Los hashes bcrypt se preservan tal cual. Si el legacy usaba un algoritmo distinto
o hashes corruptos, los usuarios no podrán iniciar sesión. En ese caso:
1. Activa la política de "olvidé mi password" del SaaS.
2. O resetea masivamente con un UPDATE manual + un SUPER_ADMIN les comparte la
   nueva password temporal.
