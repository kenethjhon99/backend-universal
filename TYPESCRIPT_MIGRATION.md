# Migración progresiva a TypeScript

Convivencia JS+TS sin romper nada. El runtime sigue siendo Node ESM puro
gracias a `tsx` (que transpila TS al vuelo). Los archivos `.js` siguen
funcionando como antes. Los nuevos `.ts` usan tipos.

## Cómo arrancar el server con soporte TS

```bash
npm install            # baja typescript, tsx, @types/*
npm run dev:saas:ts    # nodemon-like sobre src-saas/server.js con tsx
```

El comando `dev:saas:ts` resuelve imports `.js` a `.ts` automáticamente
gracias a `tsx`. Cuando importes un archivo migrado, **mantén la extensión
`.js`** en el `import` (no `.ts`):

```js
// FUNCIONA igual antes que después de migrar el archivo
import { HttpError } from "../shared/http/http-error.js";
```

Esto te permite migrar archivo por archivo sin tener que tocar todos los
imports a la vez.

## Type-checking sin emitir

```bash
npm run typecheck
```

Va a chequear todos los `.ts` y reportar errores. Los `.js` quedan fuera
(para no inundar de errores legacy). Cuando un archivo se siente cómodo,
se renombra a `.ts` y entra al chequeo.

## Orden recomendado de migración

1. **Tipos compartidos** (`types/index.ts`) — ✅ ya creado.
2. **Helpers stateless** (no tocan DB):
   - `shared/http/http-error.ts` — ✅
   - `shared/http/async-handler.ts` — ✅
   - `shared/http/request-meta.ts`
   - `shared/validation/validate.ts`
   - `shared/security/jwt.ts`
   - `shared/security/permissions.ts`
3. **Middlewares** (firma estable, alto valor de tipado):
   - `middlewares/authenticate.ts`
   - `middlewares/authorize.ts`
   - `middlewares/error-handler.ts`
4. **Services pequeños** (ej. `monedas`, `comisiones`, `membresias`).
5. **Services grandes** (`ventas`, `caja`, `servicios`) — al final, cuando ya
   tengas los tipos auxiliares listos.
6. **Controllers** + `routes` — son finos, pero dependen de los services.

## Convención de migración por archivo

1. Renombra `foo.js` → `foo.ts`.
2. Agrega tipos a parámetros y returns. Empieza por las funciones públicas.
3. Importa tipos de `../types/index.js` (sin la extensión `.ts`).
4. Si encuentras mucho `any`, deja `// eslint-disable-next-line @typescript-eslint/no-explicit-any` y un TODO. No bloquee.
5. Corre `npm run typecheck`. Si pasa, commitea.

## strictNullChecks

Está activo. Esto significa que `null` y `undefined` son explícitos. Si
una función puede devolver `null`, el caller debe manejarlo. Si un campo
de DB puede ser `null`, declararlo como `string | null`. Esto va a atrapar
muchos bugs sutiles en el legacy.

## strict: pero `noImplicitAny: false`

Decisión consciente: durante la migración, dejamos `noImplicitAny: false`
para no obligar a tipar TODO de golpe. Los archivos sin tipos siguen
funcionando como `any` implícito. Cuando todo el codebase esté migrado,
se sube a `noImplicitAny: true` y el último PR va a forzar a tipar lo que
quede.

## Tests

Los tests siguen en `.js` con vitest. Vitest soporta TS nativo, así que
puedes mezclar tests `.ts` cuando quieras. No es prioritario.

## CI

El job `lint-syntax` del workflow de CI hace `node --check` en `.js` y
`.mjs`. Para incluir TS, agrega:

```yaml
- name: TypeScript typecheck
  run: npm run typecheck
```

Esto va a fallar el build si introducís un error de tipos en un `.ts`.

## ¿Cuándo darlo por terminado?

Cuando todos los archivos de `src-saas/**` sean `.ts` y `npm run typecheck`
pase sin errores. Estimado: 2 sprints de trabajo continuo (hay ~80 archivos
en src-saas, ~10/día razonable con migración cuidadosa).
