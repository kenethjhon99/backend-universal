-- 027_tickets_soporte.sql
-- Sistema de tickets de soporte interno. Casos de uso:
--   - Cajero reporta problema técnico al admin de empresa
--   - Admin reporta bug al SUPER_ADMIN del SaaS
--   - Cliente final reporta queja (futuro: vía pantalla pública con codigo)
--
-- Modelo simple: ticket + mensajes (threaded). Estado lineal: ABIERTO ->
-- EN_PROGRESO -> RESUELTO -> CERRADO. Reaperturable.

create table if not exists tickets (
  id_ticket bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  numero varchar(20) not null,                    -- ej. "TKT-00001234"
  titulo varchar(200) not null,
  descripcion text,
  categoria varchar(40),                          -- ej. POS, CAJA, IMPRESORA, FACTURACION
  prioridad varchar(20) not null default 'MEDIA'
    check (prioridad in ('BAJA', 'MEDIA', 'ALTA', 'CRITICA')),
  estado varchar(20) not null default 'ABIERTO'
    check (estado in ('ABIERTO', 'EN_PROGRESO', 'RESUELTO', 'CERRADO')),
  id_creador bigint not null,
  id_asignado bigint,
  id_resuelto_por bigint,
  resuelto_en timestamptz,
  cerrado_en timestamptz,
  -- Contexto opcional: si el ticket se origina desde una venta/orden/etc.
  referencia_tipo varchar(40),
  referencia_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, numero),
  foreign key (id_empresa, id_creador) references usuarios(id_empresa, id_usuario),
  foreign key (id_empresa, id_asignado) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_tickets_empresa_estado
  on tickets (id_empresa, estado, prioridad, created_at desc);

create index if not exists idx_tickets_asignado
  on tickets (id_empresa, id_asignado, estado)
  where estado in ('ABIERTO', 'EN_PROGRESO');

create unique index if not exists uq_tickets_empresa_id
  on tickets (id_empresa, id_ticket);

create table if not exists tickets_mensajes (
  id_mensaje bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_ticket bigint not null,
  id_usuario bigint not null,
  contenido text not null,
  -- Si el mensaje incluye un cambio de estado del ticket
  cambio_estado varchar(20),
  created_at timestamptz not null default now(),
  foreign key (id_empresa, id_ticket) references tickets(id_empresa, id_ticket),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_tickets_mensajes_ticket
  on tickets_mensajes (id_empresa, id_ticket, created_at asc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tickets_updated_at') then
    create trigger trg_tickets_updated_at
    before update on tickets
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
alter table tickets enable row level security;
drop policy if exists tickets_tenant_policy on tickets;
create policy tickets_tenant_policy on tickets
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table tickets_mensajes enable row level security;
drop policy if exists tickets_mensajes_tenant_policy on tickets_mensajes;
create policy tickets_mensajes_tenant_policy on tickets_mensajes
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
