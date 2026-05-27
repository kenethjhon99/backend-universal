alter table ordenes_servicio
  add column if not exists prioridad varchar(20) not null default 'NORMAL',
  add column if not exists agenda_estado varchar(20) not null default 'NO_PROGRAMADA',
  add column if not exists fecha_programada_inicio timestamptz,
  add column if not exists fecha_programada_fin timestamptz,
  add column if not exists fecha_promesa timestamptz,
  add column if not exists cancelada_por bigint,
  add column if not exists cancelada_en timestamptz,
  add column if not exists cancelacion_motivo text,
  add column if not exists reembolso_monto numeric(14,2) not null default 0,
  add column if not exists reembolso_metodo varchar(20),
  add column if not exists reembolso_id_caja_sesion bigint,
  add column if not exists reembolsado_por bigint,
  add column if not exists fecha_reembolso timestamptz,
  add column if not exists reembolso_motivo text,
  add column if not exists stock_reintegrado boolean not null default false,
  add column if not exists stock_reintegrado_en timestamptz,
  add column if not exists stock_reintegrado_por bigint;

update ordenes_servicio
set agenda_estado = case
  when upper(coalesce(estado, '')) = 'ANULADA' then 'CANCELADA'
  when fecha_programada_inicio is not null then 'PROGRAMADA'
  when upper(coalesce(estado, '')) = 'EN_PROCESO' then 'EN_EJECUCION'
  when upper(coalesce(estado, '')) in ('LISTO', 'ENTREGADO') then 'FINALIZADA'
  else 'NO_PROGRAMADA'
end
where agenda_estado is null
   or agenda_estado = '';

create table if not exists servicios_tecnicos (
  id_servicio_tecnico bigserial primary key,
  id_empresa bigint not null,
  id_usuario bigint not null,
  alias varchar(80),
  especialidades text[] not null default '{}'::text[],
  color_agenda varchar(20),
  notas text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_usuario),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists ordenes_servicio_tecnicos (
  id_orden_servicio_tecnico bigserial primary key,
  id_empresa bigint not null,
  id_orden_servicio bigint not null,
  id_usuario bigint not null,
  es_principal boolean not null default false,
  estado_asignacion varchar(20) not null default 'ASIGNADO',
  horas_estimadas numeric(8,2),
  horas_reales numeric(8,2),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_orden_servicio, id_usuario),
  foreign key (id_empresa, id_orden_servicio) references ordenes_servicio(id_empresa, id_orden_servicio),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists servicios_checklist_templates (
  id_servicio_checklist_template bigserial primary key,
  id_empresa bigint not null,
  id_servicio_catalogo bigint not null,
  titulo varchar(120) not null,
  instrucciones text,
  orden smallint not null default 1,
  obligatorio boolean not null default true,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_servicio_checklist_template),
  foreign key (id_empresa, id_servicio_catalogo) references servicios_catalogo(id_empresa, id_servicio_catalogo)
);

create table if not exists ordenes_servicio_checklist (
  id_orden_servicio_checklist bigserial primary key,
  id_empresa bigint not null,
  id_orden_servicio bigint not null,
  id_servicio_checklist_template bigint,
  titulo varchar(120) not null,
  instrucciones text,
  orden smallint not null default 1,
  obligatorio boolean not null default true,
  estado varchar(20) not null default 'PENDIENTE',
  observacion text,
  completado_por bigint,
  completado_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_orden_servicio) references ordenes_servicio(id_empresa, id_orden_servicio),
  foreign key (id_empresa, id_servicio_checklist_template) references servicios_checklist_templates(id_empresa, id_servicio_checklist_template),
  foreign key (id_empresa, completado_por) references usuarios(id_empresa, id_usuario)
);

create table if not exists ordenes_servicio_reversiones (
  id_orden_servicio_reversion bigserial primary key,
  id_empresa bigint not null,
  id_orden_servicio bigint not null,
  tipo varchar(20) not null,
  monto numeric(14,2) not null default 0,
  metodo_pago varchar(20),
  motivo text not null,
  reintegrar_stock boolean not null default false,
  id_caja_sesion bigint,
  id_usuario bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_orden_servicio) references ordenes_servicio(id_empresa, id_orden_servicio),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  foreign key (id_caja_sesion) references caja_sesiones(id_caja_sesion)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ordenes_servicio_cancelada_por_fkey'
  ) then
    alter table ordenes_servicio
      add constraint ordenes_servicio_cancelada_por_fkey
      foreign key (id_empresa, cancelada_por)
      references usuarios(id_empresa, id_usuario);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ordenes_servicio_reembolsado_por_fkey'
  ) then
    alter table ordenes_servicio
      add constraint ordenes_servicio_reembolsado_por_fkey
      foreign key (id_empresa, reembolsado_por)
      references usuarios(id_empresa, id_usuario);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ordenes_servicio_stock_reintegrado_por_fkey'
  ) then
    alter table ordenes_servicio
      add constraint ordenes_servicio_stock_reintegrado_por_fkey
      foreign key (id_empresa, stock_reintegrado_por)
      references usuarios(id_empresa, id_usuario);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ordenes_servicio_reembolso_id_caja_sesion_fkey'
  ) then
    alter table ordenes_servicio
      add constraint ordenes_servicio_reembolso_id_caja_sesion_fkey
      foreign key (reembolso_id_caja_sesion)
      references caja_sesiones(id_caja_sesion);
  end if;
end;
$$;

create unique index if not exists uq_ordenes_servicio_tecnicos_principal
  on ordenes_servicio_tecnicos (id_empresa, id_orden_servicio)
  where es_principal = true;

create index if not exists idx_servicios_tecnicos_empresa_activo
  on servicios_tecnicos (id_empresa, activo, id_usuario);

create index if not exists idx_ordenes_servicio_agenda
  on ordenes_servicio (id_empresa, id_sucursal, agenda_estado, fecha_programada_inicio asc);

create index if not exists idx_ordenes_servicio_prioridad
  on ordenes_servicio (id_empresa, prioridad, fecha_programada_inicio asc);

create index if not exists idx_ordenes_servicio_cancelacion
  on ordenes_servicio (id_empresa, cancelada_en desc);

create index if not exists idx_ordenes_servicio_reembolso
  on ordenes_servicio (id_empresa, fecha_reembolso desc);

create index if not exists idx_ordenes_servicio_tecnicos_empresa_usuario
  on ordenes_servicio_tecnicos (id_empresa, id_usuario, created_at desc);

create index if not exists idx_servicios_checklist_templates_empresa_servicio
  on servicios_checklist_templates (id_empresa, id_servicio_catalogo, activo, orden asc);

create index if not exists idx_ordenes_servicio_checklist_empresa_orden
  on ordenes_servicio_checklist (id_empresa, id_orden_servicio, orden asc);

create index if not exists idx_ordenes_servicio_reversiones_empresa_orden
  on ordenes_servicio_reversiones (id_empresa, id_orden_servicio, created_at desc);

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'servicios_tecnicos',
    'ordenes_servicio_tecnicos',
    'servicios_checklist_templates',
    'ordenes_servicio_checklist',
    'ordenes_servicio_reversiones'
  ]
  loop
    execute format('alter table %I enable row level security', tenant_table);
    execute format(
      'drop policy if exists %I on %I',
      tenant_table || '_tenant_policy',
      tenant_table
    );
    execute format(
      'create policy %I on %I using (app.is_super_admin() or id_empresa = app.current_empresa_id()) with check (app.is_super_admin() or id_empresa = app.current_empresa_id())',
      tenant_table || '_tenant_policy',
      tenant_table
    );
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_servicios_tecnicos_updated_at') then
    create trigger trg_servicios_tecnicos_updated_at
    before update on servicios_tecnicos
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_ordenes_servicio_tecnicos_updated_at') then
    create trigger trg_ordenes_servicio_tecnicos_updated_at
    before update on ordenes_servicio_tecnicos
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_servicios_checklist_templates_updated_at') then
    create trigger trg_servicios_checklist_templates_updated_at
    before update on servicios_checklist_templates
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_ordenes_servicio_checklist_updated_at') then
    create trigger trg_ordenes_servicio_checklist_updated_at
    before update on ordenes_servicio_checklist
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_ordenes_servicio_reversiones_updated_at') then
    create trigger trg_ordenes_servicio_reversiones_updated_at
    before update on ordenes_servicio_reversiones
    for each row execute function app.set_updated_at();
  end if;
end;
$$;
