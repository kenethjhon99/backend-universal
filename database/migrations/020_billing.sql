-- 020_billing.sql
-- Billing del SaaS. Soporta multiples proveedores (Stripe inicialmente, Wompi
-- y otros se pueden agregar mas adelante con un campo `provider`).

-- Customer y subscription IDs externos del proveedor de pago
alter table empresas
  add column if not exists billing_provider varchar(20),  -- 'stripe', 'wompi', ...
  add column if not exists billing_customer_id varchar(120),
  add column if not exists billing_subscription_id varchar(120);

-- Eventos / facturas registradas (espejo local de webhooks)
create table if not exists billing_events (
  id_event bigserial primary key,
  id_empresa bigint references empresas(id_empresa),
  provider varchar(20) not null,
  event_id varchar(120) not null,         -- el id que da el provider (idempotencia)
  event_type varchar(80) not null,        -- 'invoice.paid', 'subscription.deleted', ...
  payload jsonb not null,
  procesado_en timestamptz,
  procesamiento_resultado text,
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);

create index if not exists idx_billing_events_empresa
  on billing_events (id_empresa, created_at desc);
