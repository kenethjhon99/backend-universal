-- 021_notificaciones.sql
-- Sistema de notificaciones unificado.
-- Modelo:
--   * notificaciones_canales: canales habilitados por empresa
--       (email/sendgrid, whatsapp/twilio, telegram, webhook)
--   * notificaciones_eventos: log de notificaciones enviadas
--   * Triggers de negocio (stock bajo, caja sin cerrar, etc.) se enganchan
--     desde el codigo, no por DB triggers (mas flexible).

create table if not exists notificaciones_canales (
  id_canal bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  tipo varchar(20) not null check (tipo in ('EMAIL', 'WHATSAPP', 'TELEGRAM', 'WEBHOOK', 'SMS')),
  nombre varchar(80) not null,
  config jsonb not null default '{}'::jsonb,  -- credenciales / endpoints / templates
  activo boolean not null default true,
  -- A que tipos de eventos se suscribe este canal:
  --   ['STOCK_BAJO', 'CAJA_SIN_CERRAR', 'VENTA_GRANDE', 'NO_COBRADO', ...]
  eventos jsonb not null default '[]'::jsonb,
  destinatarios jsonb not null default '[]'::jsonb,  -- emails/numeros segun tipo
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint
);

create index if not exists idx_notificaciones_canales_empresa_activo
  on notificaciones_canales (id_empresa, activo);

create table if not exists notificaciones_eventos (
  id_evento bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_canal bigint references notificaciones_canales(id_canal),
  tipo_evento varchar(40) not null,
  asunto varchar(200),
  cuerpo text,
  destinatarios jsonb,
  payload jsonb default '{}'::jsonb,
  estado varchar(20) not null default 'PENDIENTE'
    check (estado in ('PENDIENTE', 'ENVIADO', 'FALLIDO', 'IGNORADO')),
  intentos integer not null default 0,
  ultimo_error text,
  enviado_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notificaciones_eventos_empresa_tipo
  on notificaciones_eventos (id_empresa, tipo_evento, created_at desc);

create index if not exists idx_notificaciones_eventos_pendientes
  on notificaciones_eventos (estado, created_at)
  where estado = 'PENDIENTE';

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_notificaciones_canales_updated_at') then
    create trigger trg_notificaciones_canales_updated_at
    before update on notificaciones_canales
    for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_notificaciones_eventos_updated_at') then
    create trigger trg_notificaciones_eventos_updated_at
    before update on notificaciones_eventos
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
alter table notificaciones_canales enable row level security;
drop policy if exists notificaciones_canales_tenant_policy on notificaciones_canales;
create policy notificaciones_canales_tenant_policy on notificaciones_canales
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table notificaciones_eventos enable row level security;
drop policy if exists notificaciones_eventos_tenant_policy on notificaciones_eventos;
create policy notificaciones_eventos_tenant_policy on notificaciones_eventos
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
