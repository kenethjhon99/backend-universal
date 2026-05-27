-- Tabla de mapeo legacy_id -> saas_id por entidad. Vive en la BD SaaS.
-- Permite que el script de migracion sea idempotente y reanudable.

create table if not exists migration_mapping (
  entidad varchar(60) not null,
  legacy_id varchar(80) not null,
  saas_id bigint not null,
  id_empresa bigint not null,
  migrated_at timestamptz not null default now(),
  primary key (entidad, legacy_id, id_empresa)
);

create index if not exists idx_migration_mapping_saas
  on migration_mapping (entidad, saas_id, id_empresa);
