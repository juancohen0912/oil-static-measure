-- =====================================================================
-- Oil Static Measure · Backend seguro multi-organización (Supabase)
-- Principios:
--  1. Nada es público: el rol anon no tiene ningún permiso sobre tablas.
--  2. Solo usuarios invitados pueden crear cuenta (bloqueo en auth.users).
--  3. Toda lectura/escritura exige sesión con segundo factor (aal2, TOTP).
--  4. Aislamiento por organización y por licencia de módulo (RLS).
--  5. Roles: viewer < analyst < admin < owner. Identidad y fecha las pone el
--     servidor, nunca el cliente (anti-suplantación).
--  6. Auditoría con cadena de hash, solo inserción; historial de cambios de
--     cada documento con su versión anterior.
--  7. Funciones privilegiadas en el esquema "private", no expuesto por la API.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;   -- solo para evaluar políticas

-- ---------- Tablas ----------
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 2 and 120),
  nit        text check (nit is null or length(nit) <= 30),
  org_type   text not null default 'Operadora' check (org_type in ('Operadora','Inspección','Oleoducto','Otro')),
  created_at timestamptz not null default now()
);

create table public.licenses (
  org_id   uuid not null references public.organizations(id) on delete cascade,
  module   text not null check (module in ('static','pipeline')),
  seats    int  not null default 1 check (seats between 1 and 1000),
  valid_to date,
  primary key (org_id, module)
);

create table public.memberships (
  org_id       uuid not null references public.organizations(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('viewer','analyst','admin','owner')),
  display_name text not null,
  email        text not null,
  created_at   timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.memberships (user_id);

create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  email        text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name text not null check (length(display_name) between 2 and 120),
  role         text not null check (role in ('viewer','analyst','admin','owner')),
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  unique (org_id, email)
);

-- Documentos de la aplicación (mismo modelo que usa la interfaz)
create table public.app_docs (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  collection text not null check (collection in ('tanks','tabs','products','vehicles','ops','pl')),
  doc_id     text not null check (length(doc_id) between 1 and 200),
  data       jsonb not null check (octet_length(data::text) < 2000000),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (org_id, collection, doc_id)
);

create table public.app_docs_history (
  id         bigint generated always as identity primary key,
  org_id     uuid not null,
  collection text not null,
  doc_id     text not null,
  op         text not null,
  old_data   jsonb,
  new_data   jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index on public.app_docs_history (org_id, changed_at desc);

create table public.audit_log (
  id        bigint generated always as identity primary key,
  org_id    uuid not null references public.organizations(id) on delete cascade,
  ts        text not null,           -- ISO-8601 UTC con milisegundos (parte del hash)
  user_id   uuid not null,
  user_name text not null,
  action    text not null check (length(action) <= 60),
  entity    text not null default '',
  detail    text not null default '',
  prev_hash text not null,
  hash      text not null
);
create index on public.audit_log (org_id, id);

-- Administradores de la plataforma (el dueño del SaaS). Esquema privado.
create table private.platform_admins (email text primary key check (email = lower(email)));

-- ---------- Funciones auxiliares (privadas, security definer) ----------
create or replace function private.aal2() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt()->>'aal'), '') = 'aal2';
$$;

create or replace function private.role_rank(r text) returns int
language sql immutable set search_path = '' as $$
  select case r when 'viewer' then 1 when 'analyst' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end;
$$;

create or replace function private.my_role(o uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m where m.org_id = o and m.user_id = (select auth.uid());
$$;

create or replace function private.is_member(o uuid, min_role text default 'viewer') returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
     and private.role_rank(private.my_role(o)) >= private.role_rank(min_role);
$$;

create or replace function private.has_module(o uuid, mod text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.licenses l where l.org_id = o and l.module = mod
                 and (l.valid_to is null or l.valid_to >= current_date));
$$;

create or replace function private.module_of(c text) returns text
language sql immutable set search_path = '' as $$
  select case when c = 'pl' then 'pipeline' else 'static' end;
$$;

create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users u join private.platform_admins p on p.email = lower(u.email)
                 where u.id = (select auth.uid()) and u.email_confirmed_at is not null);
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- ---------- Registro solo por invitación ----------
create or replace function private.only_invited() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.invitations i
                 where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now())
     and not exists (select 1 from private.platform_admins p where p.email = lower(new.email)) then
    raise exception 'Registro no autorizado: este correo no tiene una invitación vigente';
  end if;
  return new;
end $$;
create trigger only_invited before insert on auth.users for each row execute function private.only_invited();

-- La membresía se crea solo cuando el correo está confirmado (prueba de que el
-- invitado controla ese buzón) y se toma el nombre de la invitación, no del usuario.
create or replace function private.accept_invitations() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null and (tg_op = 'INSERT' or old.email_confirmed_at is null) then
    insert into public.memberships (org_id, user_id, role, display_name, email)
      select i.org_id, new.id, i.role, i.display_name, i.email from public.invitations i
       where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now()
      on conflict (org_id, user_id) do nothing;
    update public.invitations set accepted_at = now()
     where email = lower(new.email) and accepted_at is null and expires_at > now();
  end if;
  return new;
end $$;
create trigger accept_invitations after insert or update of email_confirmed_at on auth.users
  for each row execute function private.accept_invitations();

-- Cupos: no se invita por encima de las licencias contratadas; nadie invita a un rol mayor que el propio.
create or replace function private.check_invitation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cap int; used int;
begin
  -- (sin sesión = consola del dueño o service_role)
  if (select auth.uid()) is not null and not private.is_platform_admin() then
    if private.role_rank(new.role) > private.role_rank(private.my_role(new.org_id)) then
      raise exception 'No puede invitar con un rol mayor que el suyo';
    end if;
  end if;
  select coalesce(max(seats), 0) into cap from public.licenses
   where org_id = new.org_id and (valid_to is null or valid_to >= current_date);
  select (select count(*) from public.memberships where org_id = new.org_id)
       + (select count(*) from public.invitations where org_id = new.org_id and accepted_at is null and expires_at > now())
    into used;
  if used >= cap then raise exception 'Cupo de usuarios agotado (% de %)', used, cap; end if;
  new.email := lower(new.email);
  new.invited_by := (select auth.uid());
  new.accepted_at := null;
  return new;
end $$;
create trigger check_invitation before insert on public.invitations for each row execute function private.check_invitation();

-- Membresías: no elevar por encima del propio rol ni dejar la organización sin dueño.
create or replace function private.guard_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or private.is_platform_admin() then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.user_id <> old.user_id or new.email <> old.email then
      raise exception 'Solo se puede cambiar el rol o el nombre';
    end if;
    if private.role_rank(new.role) > private.role_rank(private.my_role(new.org_id)) then
      raise exception 'No puede asignar un rol mayor que el suyo';
    end if;
  end if;
  if (tg_op = 'DELETE' or new.role <> 'owner') and old.role = 'owner'
     and (select count(*) from public.memberships where org_id = old.org_id and role = 'owner') <= 1 then
    raise exception 'La organización debe conservar al menos un propietario';
  end if;
  if private.role_rank(old.role) > private.role_rank(private.my_role(old.org_id)) then
    raise exception 'No puede modificar a un usuario con rol mayor que el suyo';
  end if;
  return coalesce(new, old);
end $$;
create trigger guard_membership before update or delete on public.memberships for each row execute function private.guard_membership();

-- ---------- Documentos: sello del servidor, períodos cerrados e historial ----------
create or replace function private.stamp_doc() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.collection <> old.collection or new.doc_id <> old.doc_id then
      raise exception 'No se puede mover un documento entre organizaciones o colecciones';
    end if;
    if old.collection = 'pl' and old.data->>'status' = 'cerrado' and not private.is_member(old.org_id, 'admin') then
      raise exception 'Período cerrado: solo un administrador puede crear una nueva revisión';
    end if;
  end if;
  if tg_op = 'DELETE' then
    if old.collection = 'pl' and old.data->>'status' = 'cerrado' and (select auth.uid()) is not null then
      raise exception 'Un período cerrado no se puede eliminar';
    end if;
    insert into public.app_docs_history (org_id, collection, doc_id, op, old_data, new_data, changed_by)
      values (old.org_id, old.collection, old.doc_id, 'DELETE', old.data, null, (select auth.uid()));
    return old;
  end if;
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  insert into public.app_docs_history (org_id, collection, doc_id, op, old_data, new_data, changed_by)
    values (new.org_id, new.collection, new.doc_id, tg_op,
            case when tg_op = 'UPDATE' then old.data end, new.data, (select auth.uid()));
  return new;
end $$;
create trigger stamp_doc before insert or update or delete on public.app_docs for each row execute function private.stamp_doc();

-- ---------- Auditoría encadenada (el servidor fija usuario, nombre, fecha y hash) ----------
create or replace function private.chain_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare t timestamptz := date_trunc('milliseconds', clock_timestamp());
begin
  perform pg_advisory_xact_lock(hashtext(new.org_id::text));
  new.user_id   := (select auth.uid());
  new.user_name := coalesce((select m.display_name from public.memberships m where m.org_id = new.org_id and m.user_id = new.user_id), 'desconocido');
  new.ts        := to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  new.entity    := left(coalesce(new.entity, ''), 200);
  new.detail    := left(coalesce(new.detail, ''), 600);
  new.prev_hash := coalesce((select a.hash from public.audit_log a where a.org_id = new.org_id order by a.id desc limit 1), 'GENESIS');
  new.hash      := encode(extensions.digest(convert_to(concat_ws('|', new.prev_hash, new.ts, new.user_id::text, new.action, new.entity, new.detail), 'UTF8'), 'sha256'), 'hex');
  return new;
end $$;
create trigger chain_audit before insert on public.audit_log for each row execute function private.chain_audit();

create or replace function private.immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Registro inalterable'; end $$;
create trigger audit_immutable before update or delete on public.audit_log for each row execute function private.immutable();
create trigger history_immutable before update or delete on public.app_docs_history for each row execute function private.immutable();

-- ---------- Permisos: anon no tiene nada; authenticated solo lo necesario ----------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;
grant select on public.organizations, public.licenses, public.memberships, public.invitations,
                public.app_docs, public.app_docs_history, public.audit_log to authenticated;
grant insert, update on public.organizations, public.licenses to authenticated;
grant update (role, display_name), delete on public.memberships to authenticated;
grant insert (org_id, email, display_name, role), delete on public.invitations to authenticated;
grant insert, update, delete on public.app_docs to authenticated;
grant insert (org_id, action, entity, detail) on public.audit_log to authenticated;

-- ---------- RLS ----------
alter table public.organizations    enable row level security;
alter table public.licenses         enable row level security;
alter table public.memberships      enable row level security;
alter table public.invitations      enable row level security;
alter table public.app_docs         enable row level security;
alter table public.app_docs_history enable row level security;
alter table public.audit_log        enable row level security;
alter table private.platform_admins enable row level security;

-- Segundo factor obligatorio en TODAS las tablas (política restrictiva)
do $$ declare t text; begin
  foreach t in array array['organizations','licenses','memberships','invitations','app_docs','app_docs_history','audit_log'] loop
    execute format('create policy mfa_requerido on public.%I as restrictive to authenticated using ((select private.aal2())) with check ((select private.aal2()))', t);
  end loop;
end $$;

create policy org_leer on public.organizations for select to authenticated
  using ((select private.is_member(id)) or (select private.is_platform_admin()));
create policy org_admin on public.organizations for insert to authenticated with check ((select private.is_platform_admin()));
create policy org_admin_upd on public.organizations for update to authenticated
  using ((select private.is_platform_admin())) with check ((select private.is_platform_admin()));

create policy lic_leer on public.licenses for select to authenticated
  using ((select private.is_member(org_id)) or (select private.is_platform_admin()));
create policy lic_admin on public.licenses for insert to authenticated with check ((select private.is_platform_admin()));
create policy lic_admin_upd on public.licenses for update to authenticated
  using ((select private.is_platform_admin())) with check ((select private.is_platform_admin()));

create policy mem_leer on public.memberships for select to authenticated
  using ((select private.is_member(org_id)) or (select private.is_platform_admin()));
create policy mem_editar on public.memberships for update to authenticated
  using ((select private.is_member(org_id, 'admin'))) with check ((select private.is_member(org_id, 'admin')));
create policy mem_quitar on public.memberships for delete to authenticated
  using ((select private.is_member(org_id, 'admin')) or (select private.is_platform_admin()));

create policy inv_leer on public.invitations for select to authenticated
  using ((select private.is_member(org_id, 'admin')) or (select private.is_platform_admin()));
create policy inv_crear on public.invitations for insert to authenticated
  with check ((select private.is_member(org_id, 'admin')) or (select private.is_platform_admin()));
create policy inv_borrar on public.invitations for delete to authenticated
  using (accepted_at is null and ((select private.is_member(org_id, 'admin')) or (select private.is_platform_admin())));

create policy doc_leer on public.app_docs for select to authenticated
  using ((select private.is_member(org_id)) and private.has_module(org_id, private.module_of(collection)));
create policy doc_crear on public.app_docs for insert to authenticated
  with check ((select private.is_member(org_id, 'analyst')) and private.has_module(org_id, private.module_of(collection)));
create policy doc_editar on public.app_docs for update to authenticated
  using ((select private.is_member(org_id, 'analyst')) and private.has_module(org_id, private.module_of(collection)))
  with check ((select private.is_member(org_id, 'analyst')) and private.has_module(org_id, private.module_of(collection)));
create policy doc_borrar on public.app_docs for delete to authenticated
  using ((select private.is_member(org_id, 'analyst')) and private.has_module(org_id, private.module_of(collection)));

create policy hist_leer on public.app_docs_history for select to authenticated
  using ((select private.is_member(org_id, 'admin')));

create policy aud_leer on public.audit_log for select to authenticated
  using ((select private.is_member(org_id)));
create policy aud_crear on public.audit_log for insert to authenticated
  with check ((select private.is_member(org_id)));
