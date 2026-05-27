-- 013_jwt_revocable.sql
-- Habilita revocacion de JWTs comparando el iat (issued at) del token contra
-- la columna usuarios.token_valid_from. Cuando se cambia password, se rotan
-- roles, o se desactiva un usuario, se ejecuta:
--   update usuarios set token_valid_from = now() where id_usuario = X
-- y todos los tokens emitidos antes de ese momento dejan de ser validos.

alter table usuarios
  add column if not exists token_valid_from timestamptz not null default now();

create index if not exists idx_usuarios_token_valid_from
  on usuarios (id_empresa, id_usuario, token_valid_from);
