# Migración a RLS forzado (`req.db` pattern)

## Por qué

Hoy las queries corren contra Postgres con el rol `postgres` (superuser), que
**bypassa RLS**. Las policies están definidas pero no protegen en runtime — el
aislamiento entre tenants depende de que el desarrollador no se olvide de
filtrar por `id_empresa` en cada query.

Cuando se aplica este patrón:

1. Las requests autenticadas usan `req.db` (un client transaccional con
   `app.current_empresa_id` ya seteado vía `set_config(..., true)`).
2. En producción, el `PGUSER` se cambia a `saas_app` (creado en migration 034,
   sin `BYPASSRLS`). RLS empieza a proteger físicamente.

## Cómo migrar un módulo

### Antes (módulo legacy)

```js
// routes
router.use(authenticate);
router.get("/cosas", controller.list);

// controller
export const list = asyncHandler(async (req, res) => {
  const data = await service.list({ auth: req.auth });
  res.json({ data });
});

// service
import { pool } from "../../config/db.js";
export const list = async ({ auth }) => {
  const r = await pool.query(
    "select * from cosas where id_empresa = $1",
    [auth.id_empresa]
  );
  return r.rows;
};
```

### Después (módulo migrado)

```js
// routes
import { withTenantDb } from "../../middlewares/with-tenant-db.js";

router.use(authenticate);
router.use(withTenantDb);          // <-- nuevo
router.get("/cosas", controller.list);

// controller
export const list = asyncHandler(async (req, res) => {
  const data = await service.list({ db: req.db, auth: req.auth }); // <-- db
  res.json({ data });
});

// service
import { pool } from "../../config/db.js";

const resolveDb = (db) => db || pool;  // <-- fallback para compat

export const list = async ({ db, auth }) => {
  const conn = resolveDb(db);
  // El WHERE id_empresa ya NO es la única defensa: RLS lo refuerza.
  // Igual lo dejamos para query plans buenos.
  const r = await conn.query(
    "select * from cosas where id_empresa = $1",
    [auth.id_empresa]
  );
  return r.rows;
};
```

## Reglas

1. **`req.db` solo existe si la ruta pasó por `withTenantDb`**. Si no, está
   `undefined` y `resolveDb` cae al pool global.
2. **Todo lo que se haga con `req.db` está en UNA SOLA transacción** (la del
   middleware). Si necesitás operaciones independientes (jobs async,
   fire-and-forget), usá `pool` directo o `runInTransaction` aparte.
3. **`writeAuditEvent(req.db, ...)`** funciona porque la función acepta
   cualquier objeto con `.query()`. Así el audit log queda en la MISMA tx que
   la mutación.
4. **No mover endpoints de login, bootstrap o refresh-tokens** a `req.db`.
   Esos corren PRE-AUTH y deben usar `pool` directo. Las policies de las
   tablas `empresas`, `usuarios`, `refresh_tokens` ya tienen excepciones
   permisivas cuando `current_empresa_id` es null.
5. **`SUPER_ADMIN` sigue funcionando**: las policies tienen
   `or app.is_super_admin()` que lee `current_rol` del session.

## Orden sugerido de migración

| Prioridad | Módulo | Razón |
|---|---|---|
| 1 | `roles` (ya migrado, pilot) | Recién creado, low traffic |
| 1 | `bodegas` | Recién creado |
| 2 | `ventas` | Crítico de negocio, alta carga |
| 2 | `caja` | Crítico de negocio |
| 2 | `inventario`, `stock` | Crítico de negocio |
| 3 | `clientes`, `proveedores`, `productos` | Catálogos |
| 3 | `compras`, `comprobantes` | Operación |
| 4 | El resto | Auxiliares |

`auth`, `billing/webhook`, `publico`, `webhooks` (entrada), `tenant-dominios/branding-publico`
**NO migran** — corren pre-auth o son cross-tenant por diseño.

## Verificación

Después de migrar un módulo:

```bash
# Test de aislamiento (tests/security/tenant-isolation.test.js)
npm test -- tenant-isolation

# Manualmente con psql:
psql -U saas_app -d pos_saas
> set role saas_app;  -- por las dudas
> select * from app.rls_diagnostico;
> select * from <tabla_del_modulo>;  -- debe ser 0 filas sin contexto
> select set_config('app.current_empresa_id', '1', false);
> select * from <tabla_del_modulo>;  -- ahora ve filas de empresa 1
```

## Cuándo cambiar el PGUSER en producción

Solo después de que TODOS los módulos críticos estén migrados y los tests de
aislamiento pasen. Mientras tanto, dejar `PGUSER=postgres` en prod no empeora
el estado (es lo que ya teníamos). La diferencia es que **una vez migrado y
con `PGUSER=saas_app`, una omisión accidental de `where id_empresa` deja de
ser una fuga catastrófica**.
