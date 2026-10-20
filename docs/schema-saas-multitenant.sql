-- =====================================================================
-- Oil Static Measure · Esquema SaaS multi-organización (PostgreSQL 15+ / Supabase)
-- Módulos licenciables: 'static' (medición estática) y 'pipeline' (compensación
-- volumétrica en oleoductos). Aislamiento por organización con Row Level Security.
-- Volúmenes en NUMERIC(14,2) bbl, factores NUMERIC(12,6): nunca float.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Plataforma: organizaciones, usuarios, licencias ----------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  nit         text,
  org_type    text not null check (org_type in ('Operadora','Inspección','Oleoducto','Otro')),
  created_at  timestamptz not null default now()
);

create table memberships (
  org_id   uuid not null references organizations(id) on delete cascade,
  user_id  uuid not null,                       -- auth.users.id en Supabase
  role     text not null check (role in ('owner','admin','analyst','viewer')),
  primary key (org_id, user_id)
);

create table modules (
  code  text primary key,                       -- 'static', 'pipeline', futuros módulos
  name  text not null
);
insert into modules values
  ('static',   'Medición estática y prorrateo a carrotanques'),
  ('pipeline', 'Compensación volumétrica en oleoductos');

create table licenses (
  org_id     uuid not null references organizations(id) on delete cascade,
  module     text not null references modules(code),
  seats      int  not null default 1 check (seats > 0),
  valid_from date not null default current_date,
  valid_to   date,                               -- null = indefinida
  primary key (org_id, module)
);

-- ¿El usuario actual pertenece a la organización? ¿Tiene el módulo vigente?
create or replace function is_member(o uuid, min_role text default 'viewer') returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.org_id = o and m.user_id = auth.uid()
    and array_position(array['viewer','analyst','admin','owner'], m.role)
        >= array_position(array['viewer','analyst','admin','owner'], min_role));
$$;
create or replace function has_module(o uuid, mod text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from licenses l where l.org_id = o and l.module = mod
    and current_date >= l.valid_from and (l.valid_to is null or current_date <= l.valid_to));
$$;

-- ---------- Módulo pipeline: maestros por organización ----------
create table pl_nodes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  code text not null, name text not null,
  node_type text not null check (node_type in ('entrada','salida','ambos')),
  unique (org_id, code)
);
create table pl_shippers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  code text not null, name text not null, nit text,
  unique (org_id, code)
);
create table pl_crudes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  code text not null, name text not null,
  api60 numeric(5,1) not null check (api60 between 0 and 100),       -- API MPMS 11.1
  sulfur_pct numeric(6,4) not null default 0 check (sulfur_pct between 0 and 10),
  value_usd_bbl numeric(10,4),
  unique (org_id, code)
);
create table pl_blends (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  code text not null, name text not null,
  unique (org_id, code)
);

-- ---------- Períodos (balance mensual) y movimientos ----------
create table pl_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  period char(7) not null,                       -- 'AAAA-MM'
  revision int not null default 1,
  status text not null default 'borrador' check (status in ('borrador','cerrado')),
  params jsonb not null,                         -- tolerancia, método CVC, coeficientes
  engine_version text not null,
  input_hash text,                               -- SHA-256 de las entradas al cerrar
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (org_id, period, revision)
);
create table pl_entries (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references pl_periods(id) on delete cascade,
  node_id uuid not null references pl_nodes(id),
  shipper_id uuid not null references pl_shippers(id),
  crude_id uuid not null references pl_crudes(id),
  nsv_bbl numeric(14,2) not null check (nsv_bbl >= 0),
  api60 numeric(5,1), sulfur_pct numeric(6,4)    -- calidad del lote (opcional)
);
create table pl_entry_routes (                   -- reparto del recibo entre corrientes
  entry_id uuid not null references pl_entries(id) on delete cascade,
  blend_id uuid not null references pl_blends(id),
  pct numeric(9,6) not null check (pct > 0 and pct <= 100),
  primary key (entry_id, blend_id)
);
create table pl_exits (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references pl_periods(id) on delete cascade,
  node_id uuid not null references pl_nodes(id),
  shipper_id uuid not null references pl_shippers(id),
  blend_id uuid not null references pl_blends(id),
  nsv_bbl numeric(14,2) not null check (nsv_bbl >= 0),
  api60 numeric(5,1), sulfur_pct numeric(6,4)
);
create table pl_inventories (
  period_id uuid not null references pl_periods(id) on delete cascade,
  blend_id uuid not null references pl_blends(id),
  initial_bbl numeric(14,2) not null default 0, final_bbl numeric(14,2) not null default 0,
  primary key (period_id, blend_id)
);
create table pl_losses (                         -- pérdidas identificables y consumos
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references pl_periods(id) on delete cascade,
  kind text not null check (kind in ('identificable','consumo')),
  blend_id uuid not null references pl_blends(id),
  node_id uuid references pl_nodes(id),
  shipper_id uuid references pl_shippers(id),    -- null = prorrateo a todos
  volume_bbl numeric(14,2) not null check (volume_bbl >= 0),
  note text
);
create table pl_opening_balances (
  period_id uuid not null references pl_periods(id) on delete cascade,
  blend_id uuid not null references pl_blends(id),
  shipper_id uuid not null references pl_shippers(id),
  balance_bbl numeric(14,2) not null,
  primary key (period_id, blend_id, shipper_id)
);

-- Resultados congelados al cerrar el período (lo que se factura y certifica)
create table pl_results (
  period_id uuid not null references pl_periods(id) on delete cascade,
  blend_id uuid not null references pl_blends(id),
  entry_id uuid not null references pl_entries(id),
  received_bbl numeric(14,2) not null, pni_bbl numeric(14,2) not null,
  pi_bbl numeric(14,2) not null, consumption_bbl numeric(14,2) not null,
  net_bbl numeric(14,2) not null, value_usd_bbl numeric(10,4),
  quality_factor numeric(12,6) not null, delta_quality_bbl numeric(14,2) not null,
  entitlement_bbl numeric(14,2) not null, fcv numeric(12,6) not null,
  primary key (period_id, blend_id, entry_id)
);

-- Un período cerrado no se modifica: se crea una nueva revisión.
create or replace function pl_block_closed() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from pl_periods where id = coalesce(new.period_id, old.period_id);
  if st = 'cerrado' and tg_table_name <> 'pl_results' then
    raise exception 'El período está cerrado: cree una nueva revisión';
  end if;
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['pl_entries','pl_exits','pl_inventories','pl_losses','pl_opening_balances'] loop
    execute format('create trigger %I_closed before insert or update or delete on %I for each row execute function pl_block_closed()', t, t);
  end loop; end $$;

-- ---------- Auditoría con cadena de hash (común a todos los módulos) ----------
create table audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id),
  module text references modules(code),
  ts timestamptz not null default now(),
  user_id uuid not null default auth.uid(),
  action text not null, entity text, detail text,
  prev_hash text not null, hash text not null
);
create or replace function audit_chain() returns trigger language plpgsql as $$
begin
  select coalesce((select hash from audit_log where org_id = new.org_id order by id desc limit 1), 'GENESIS') into new.prev_hash;
  new.hash := encode(digest(new.prev_hash || '|' || new.ts || '|' || new.user_id || '|' || new.action || '|' || coalesce(new.entity,'') || '|' || coalesce(new.detail,''), 'sha256'), 'hex');
  return new;
end $$;
create trigger audit_chain_bi before insert on audit_log for each row execute function audit_chain();

-- ---------- Row Level Security ----------
alter table organizations enable row level security;
alter table memberships   enable row level security;
alter table licenses      enable row level security;
create policy org_read  on organizations for select using (is_member(id));
create policy mem_read  on memberships   for select using (is_member(org_id));
create policy mem_admin on memberships   for all    using (is_member(org_id,'owner')) with check (is_member(org_id,'owner'));
create policy lic_read  on licenses      for select using (is_member(org_id));
-- licenses: solo el proveedor del SaaS (service_role) las crea o cambia.

-- Maestros y períodos del módulo pipeline: miembro + licencia vigente
do $$ declare t text; begin
  foreach t in array array['pl_nodes','pl_shippers','pl_crudes','pl_blends','pl_periods'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_r on %I for select using (is_member(org_id) and has_module(org_id,''pipeline''))', t, t);
    execute format('create policy %I_w on %I for all using (is_member(org_id,''analyst'') and has_module(org_id,''pipeline'')) with check (is_member(org_id,''analyst'') and has_module(org_id,''pipeline''))', t, t);
  end loop;
end $$;
-- Tablas hijas: heredan el acceso del período
do $$ declare t text; begin
  foreach t in array array['pl_entries','pl_exits','pl_inventories','pl_losses','pl_opening_balances','pl_results'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_r on %I for select using (exists (select 1 from pl_periods p where p.id = period_id and is_member(p.org_id) and has_module(p.org_id,''pipeline'')))', t, t);
    execute format('create policy %I_w on %I for all using (exists (select 1 from pl_periods p where p.id = period_id and is_member(p.org_id,''analyst'') and has_module(p.org_id,''pipeline''))) with check (exists (select 1 from pl_periods p where p.id = period_id and is_member(p.org_id,''analyst'') and has_module(p.org_id,''pipeline'')))', t, t);
  end loop;
end $$;
alter table pl_entry_routes enable row level security;
create policy routes_rw on pl_entry_routes for all
  using (exists (select 1 from pl_entries e join pl_periods p on p.id = e.period_id where e.id = entry_id and is_member(p.org_id,'analyst') and has_module(p.org_id,'pipeline')));

alter table audit_log enable row level security;
create policy audit_read on audit_log for select using (is_member(org_id,'admin'));
create policy audit_ins  on audit_log for insert with check (is_member(org_id));
-- Sin políticas de update/delete: la auditoría es de solo inserción.

-- El módulo 'static' sigue el mismo patrón: tablas st_* con org_id y has_module(org_id,'static').

-- Índices de consulta habituales
create index on pl_periods (org_id, period desc, revision desc);
create index on pl_entries (period_id);
create index on pl_exits (period_id);
create index on audit_log (org_id, id desc);
