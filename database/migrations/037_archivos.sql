-- 037_archivos.sql
-- =========================================================================
-- Storage: tabla de metadatos de archivos subidos a S3-compatible.
-- Los binarios viven en S3; aca solo el indice + permisos + auditoria.
--
-- Bucket layout (configurable):
--   s3://<bucket>/<id_empresa>/<categoria>/<id_archivo>-<filename_sanitized>
--
-- categoria: 'LOGO', 'COMPROBANTE_PDF', 'PRODUCTO_IMG', 'TICKET_EXPORT',
--            'INVOICE_PDF', 'ATTACHMENT' (libre para futuros usos)
-- =========================================================================

create table if not exists archivos (
  id_archivo bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  categoria varchar(40) not null,
  nombre_original varchar(255) not null,
  -- s3_key incluye el path completo dentro del bucket
  s3_bucket varchar(80) not null,
  s3_key varchar(500) not null,
  mime_type varchar(120),
  size_bytes bigint,
  checksum_sha256 varchar(64),
  -- Vinculacion opcional con una entidad (id_producto, id_venta, etc.)
  entidad varchar(40),
  entidad_id bigint,
  publico boolean not null default false, -- si true: GET via presigned URL larga
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (s3_bucket, s3_key)
);

create index if not exists idx_archivos_empresa_categoria
  on archivos (id_empresa, categoria, created_at desc);

create index if not exists idx_archivos_entidad
  on archivos (id_empresa, entidad, entidad_id)
  where entidad is not null;

-- Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_archivos_updated_at') then
    create trigger trg_archivos_updated_at
      before update on archivos
      for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
alter table archivos enable row level security;
drop policy if exists archivos_tenant_policy on archivos;
create policy archivos_tenant_policy on archivos
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
