-- 026_webhooks_salientes.sql
-- Webhooks salientes: la empresa registra URLs que reciben POSTs cuando
-- ocurren ciertos eventos en su tenant (venta.creada, orden.completada,
-- caja.cerrada, etc.). Útil para integrar con ERPs, CRMs, Zapier, n8n.
--
-- Cada disparo se persiste con su intento, response, y se reintenta si falla
-- (backoff exponencial limitado).
-- Cada payload se firma con HMAC-SHA256 (header X-Pos-Signature) para que el
-- receptor pueda validar la autenticidad.

create table if not exists webhooks_endpoints (
  id_endpoint bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  url text not null,
  descripcion varchar(200),
  secret varchar(120) not null,                       -- usado para firma HMAC
  eventos jsonb not null default '[]'::jsonb,         -- ej. ["venta.creada","caja.cerrada"]
  headers_extra jsonb,                                -- headers adicionales custom
  activo boolean not null default true,
  reintentos_max integer not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint
);

create index if not exists idx_webhooks_endpoints_empresa_activo
  on webhooks_endpoints (id_empresa, activo);

-- Unique compuesto requerido por el FK de webhooks_eventos.
create unique index if not exists uq_webhooks_endpoints_empresa_id
  on webhooks_endpoints (id_empresa, id_endpoint);

create table if not exists webhooks_eventos (
  id_evento bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_endpoint bigint not null,
  tipo_evento varchar(60) not null,
  payload jsonb not null,
  estado varchar(20) not null default 'PENDIENTE'
    check (estado in ('PENDIENTE', 'ENVIADO', 'FALLIDO', 'DESCARTADO')),
  intentos integer not null default 0,
  ultimo_intento_en timestamptz,
  proximo_intento_en timestamptz,
  ultimo_status integer,
  ultimo_response_body text,
  ultimo_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (id_empresa, id_endpoint) references webhooks_endpoints(id_empresa, id_endpoint)
);

create index if not exists idx_webhooks_eventos_pendientes
  on webhooks_eventos (estado, proximo_intento_en)
  where estado = 'PENDIENTE';

create index if not exists idx_webhooks_eventos_empresa_tipo
  on webhooks_eventos (id_empresa, tipo_evento, created_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_webhooks_endpoints_updated_at') then
    create trigger trg_webhooks_endpoints_updated_at
    before update on webhooks_endpoints
    for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_webhooks_eventos_updated_at') then
    create trigger trg_webhooks_eventos_updated_at
    before update on webhooks_eventos
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
alter table webhooks_endpoints enable row level security;
drop policy if exists webhooks_endpoints_tenant_policy on webhooks_endpoints;
create policy webhooks_endpoints_tenant_policy on webhooks_endpoints
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table webhooks_eventos enable row level security;
drop policy if exists webhooks_eventos_tenant_policy on webhooks_eventos;
create policy webhooks_eventos_tenant_policy on webhooks_eventos
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
