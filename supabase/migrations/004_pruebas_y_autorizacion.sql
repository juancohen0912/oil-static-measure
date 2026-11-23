-- =====================================================================
-- Oil Static Measure · Pruebas gratis y autorización de tratamiento de datos
--  1. Pruebas gratis de 7, 15 o 30 días calendario que asigna el administrador
--     de la plataforma: crean la organización, sus licencias con vencimiento y
--     la invitación (o la membresía, si la persona ya tiene cuenta), en una sola
--     transacción. Se pueden prorrogar, recortar o terminar. Todo queda auditado.
--  2. Autorización de tratamiento de datos personales (Ley 1581 de 2012,
--     Decreto 1377 de 2013): el registro exige aceptar la versión vigente de los
--     Términos y la Política de tratamiento; la aceptación se guarda con fecha
--     del servidor en una tabla privada de solo inserción.
--  3. Las licencias vencen por fecha de Colombia (America/Bogota), no UTC.
-- Seguridad: las funciones del administrador exigen sesión con segundo factor
-- (aal2) y correo de administrador de la plataforma, validados en la base.
-- =====================================================================

-- ---------- Fecha de Colombia para vencimientos ----------
create or replace function private.today_co() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'America/Bogota')::date $$;

create or replace function private.has_module(o uuid, mod text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.licenses l where l.org_id = o and l.module = mod
                 and (l.valid_to is null or l.valid_to >= private.today_co()));
$$;

-- ---------- Autorización de tratamiento de datos ----------
create or replace function private.terms_version() returns text
language sql immutable set search_path = '' as $$ select '2026-11-23' $$;

create table private.consents (
  user_id     uuid not null references auth.users(id) on delete cascade,
  version     text not null check (length(version) between 8 and 20),
  email       text not null,
  source      text not null check (source in ('registro', 'ingreso')),
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);
alter table private.consents enable row level security;
revoke all on private.consents from public, anon, authenticated;
create trigger consents_immutable before update or delete on private.consents
  for each row when (pg_trigger_depth() < 1) execute function private.immutable();

-- Registro: solo con invitación vigente (como antes) y con la autorización aceptada.
-- Se conserva la regla de Custodia IA, que comparte esta base: su registro es abierto y
-- trae su propia autorización (signup_app = 'custodia' y consent_version de Custodia).
create or replace function private.only_invited() returns trigger
language plpgsql security definer set search_path = '' as $$
declare is_admin boolean := exists (select 1 from private.platform_admins p where p.email = lower(new.email));
begin
  if coalesce(new.raw_user_meta_data ->> 'signup_app', '') = 'custodia'
     and coalesce(new.raw_user_meta_data ->> 'consent_version', '') <> '' then
    return new;
  end if;
  if not exists (select 1 from public.invitations i
                 where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now())
     and not is_admin then
    raise exception 'Registro no autorizado: este correo no tiene una invitación vigente';
  end if;
  if not is_admin and coalesce(new.raw_user_meta_data->>'consent_version', '') <> private.terms_version() then
    raise exception 'Para crear el acceso debe aceptar los Términos y la Política de tratamiento de datos personales vigentes';
  end if;
  return new;
end $$;

create or replace function private.record_signup_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.raw_user_meta_data->>'signup_app', '') <> 'custodia'
     and coalesce(new.raw_user_meta_data->>'consent_version', '') = private.terms_version() then
    insert into private.consents (user_id, version, email, source)
    values (new.id, private.terms_version(), lower(new.email), 'registro') on conflict do nothing;
  end if;
  return new;
end $$;
create trigger record_signup_consent after insert on auth.users
  for each row execute function private.record_signup_consent();

-- La interfaz pregunta si el usuario ya aceptó la versión vigente, y la acepta al ingresar.
create or replace function public.consent_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('current', private.terms_version(),
    'accepted', exists (select 1 from private.consents c where c.user_id = (select auth.uid()) and c.version = private.terms_version()));
$$;
create or replace function public.accept_terms(p_version text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'Inicie sesión' using errcode = '42501'; end if;
  if p_version is distinct from private.terms_version() then raise exception 'Versión de términos no vigente: recargue la página' using errcode = 'P0001'; end if;
  insert into private.consents (user_id, version, email, source)
  select uid, p_version, lower(u.email), 'ingreso' from auth.users u where u.id = uid on conflict do nothing;
end $$;
revoke all on function public.consent_status(), public.accept_terms(text) from public, anon;
grant execute on function public.consent_status(), public.accept_terms(text) to authenticated;

-- ---------- Pruebas gratis ----------
create table private.trials (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  email      text not null check (email = lower(email)),
  modules    text[] not null,
  seats      int not null check (seats between 1 and 10),
  starts_on  date not null,
  ends_on    date not null,
  note       text check (note is null or length(note) <= 300),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on - 1 and ends_on <= starts_on + 365)
);
create index on private.trials (email, ends_on desc);
alter table private.trials enable row level security;
revoke all on private.trials from public, anon, authenticated;

create table private.admin_audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  admin_email  text not null,
  action       text not null,
  trial_id     uuid,
  target_email text,
  detail       jsonb
);
alter table private.admin_audit enable row level security;
revoke all on private.admin_audit from public, anon, authenticated;
create trigger admin_audit_immutable before update or delete on private.admin_audit
  for each row execute function private.immutable();

create or replace function private.require_platform_admin() returns text
language plpgsql stable security definer set search_path = '' as $$
declare em text;
begin
  if not (private.aal2() and private.is_platform_admin()) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select lower(u.email) into em from auth.users u where u.id = (select auth.uid());
  return em;
end $$;

-- Asigna una prueba: organización nueva, licencias que vencen el último día de la prueba
-- (incluido) e invitación como propietario; si la persona ya tiene cuenta, la agrega directo.
create or replace function public.admin_grant_trial(p_email text, p_name text, p_org_name text, p_days int,
  p_modules text[] default array['static', 'pipeline', 'facility'], p_seats int default 3,
  p_org_type text default 'Operadora', p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  adm text := private.require_platform_admin();
  em text := lower(btrim(coalesce(p_email, '')));
  nm text := btrim(coalesce(p_name, ''));
  org text := btrim(coalesce(p_org_name, ''));
  mods text[];
  d0 date := private.today_co();
  d1 date;
  oid uuid; tid uuid; uid uuid; m text;
begin
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(em) > 160 then raise exception 'Escriba un correo válido' using errcode = 'P0001'; end if;
  if length(nm) not between 2 and 120 then raise exception 'Escriba el nombre completo de la persona' using errcode = 'P0001'; end if;
  if length(org) not between 2 and 120 then raise exception 'Escriba el nombre de la empresa' using errcode = 'P0001'; end if;
  if p_days is null or p_days not in (7, 15, 30) then raise exception 'La prueba debe ser de 7, 15 o 30 días' using errcode = 'P0001'; end if;
  if p_seats is null or p_seats not between 1 and 10 then raise exception 'Los usuarios de la prueba van de 1 a 10' using errcode = 'P0001'; end if;
  if p_org_type not in ('Operadora', 'Inspección', 'Oleoducto', 'Otro') then raise exception 'Tipo de organización no válido' using errcode = 'P0001'; end if;
  select array_agg(distinct x order by x) into mods from unnest(coalesce(p_modules, array[]::text[])) x where x in ('static', 'pipeline', 'facility');
  if mods is null or cardinality(mods) = 0 then raise exception 'Elija al menos un módulo' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('osm_trial:' || em));
  if exists (select 1 from private.trials t where t.email = em and t.ends_on >= d0) then
    raise exception 'Ese correo ya tiene una prueba vigente. Use «Prorrogar».' using errcode = 'P0001';
  end if;
  d1 := d0 + p_days - 1;   -- 7 días calendario = hoy y los 6 siguientes

  insert into public.organizations (name, org_type) values (org, p_org_type) returning id into oid;
  foreach m in array mods loop
    insert into public.licenses (org_id, module, seats, valid_to) values (oid, m, p_seats, d1);
  end loop;
  select u.id into uid from auth.users u where lower(u.email) = em and u.email_confirmed_at is not null;
  if uid is not null then
    insert into public.memberships (org_id, user_id, role, display_name, email) values (oid, uid, 'owner', nm, em);
  else
    insert into public.invitations (org_id, email, display_name, role, expires_at)
    values (oid, em, nm, 'owner', ((d1 + 1)::timestamp at time zone 'America/Bogota'));
  end if;
  insert into private.trials (org_id, email, modules, seats, starts_on, ends_on, note, created_by)
  values (oid, em, mods, p_seats, d0, d1, nullif(left(btrim(coalesce(p_note, '')), 300), ''), adm) returning id into tid;
  insert into private.admin_audit (admin_email, action, trial_id, target_email, detail)
  values (adm, 'asignar_prueba', tid, em, jsonb_build_object('dias', p_days, 'modulos', mods, 'usuarios', p_seats, 'organizacion', org, 'cuenta_existente', uid is not null));
  return jsonb_build_object('id', tid, 'org_id', oid, 'ends_on', d1, 'existing_account', uid is not null);
end $$;

-- Prorroga (días > 0) o recorta (días < 0). Prorrogar una prueba vencida cuenta desde hoy.
create or replace function public.admin_adjust_trial(p_id uuid, p_days int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare adm text := private.require_platform_admin(); t private.trials; d1 date; today date := private.today_co();
begin
  if p_days is null or p_days = 0 or p_days not between -365 and 365 then raise exception 'Indique un número de días entre -365 y 365' using errcode = 'P0001'; end if;
  select * into t from private.trials where id = p_id for update;
  if t.id is null then raise exception 'No se encontró esa prueba' using errcode = 'P0001'; end if;
  d1 := case when p_days > 0 then greatest(t.ends_on, today - 1) else t.ends_on end + p_days;
  if d1 < today - 1 then d1 := today - 1; end if;
  if d1 > t.starts_on + 365 then raise exception 'Una prueba no puede durar más de un año' using errcode = 'P0001'; end if;
  update private.trials set ends_on = d1, updated_at = now() where id = t.id;
  update public.licenses set valid_to = d1 where org_id = t.org_id and module = any (t.modules);
  update public.invitations set expires_at = greatest(now(), ((d1 + 1)::timestamp at time zone 'America/Bogota'))
   where org_id = t.org_id and email = t.email and accepted_at is null;
  insert into private.admin_audit (admin_email, action, trial_id, target_email, detail)
  values (adm, case when p_days > 0 then 'prorrogar_prueba' else 'recortar_prueba' end, t.id, t.email, jsonb_build_object('dias', p_days, 'nuevo_fin', d1));
  return jsonb_build_object('id', t.id, 'ends_on', d1);
end $$;

-- Termina la prueba hoy: las licencias quedan vencidas desde ayer.
create or replace function public.admin_end_trial(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare adm text := private.require_platform_admin(); t private.trials; d1 date := private.today_co() - 1;
begin
  select * into t from private.trials where id = p_id for update;
  if t.id is null then raise exception 'No se encontró esa prueba' using errcode = 'P0001'; end if;
  if t.ends_on <= d1 then return; end if;
  update private.trials set ends_on = d1, updated_at = now() where id = t.id;
  update public.licenses set valid_to = d1 where org_id = t.org_id and module = any (t.modules);
  update public.invitations set expires_at = now() where org_id = t.org_id and email = t.email and accepted_at is null;
  insert into private.admin_audit (admin_email, action, trial_id, target_email, detail) values (adm, 'terminar_prueba', t.id, t.email, null);
end $$;

create or replace function public.admin_list_trials() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare adm text := private.require_platform_admin(); today date := private.today_co();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'email', t.email, 'org', o.name, 'org_id', t.org_id, 'modules', t.modules, 'seats', t.seats,
      'starts_on', t.starts_on, 'ends_on', t.ends_on, 'active', t.ends_on >= today, 'days_left', greatest(0, t.ends_on - today + 1),
      'note', t.note, 'created_by', t.created_by,
      'joined', exists (select 1 from public.memberships m where m.org_id = t.org_id and m.email = t.email))
    order by t.created_at desc)
    from (select * from private.trials order by created_at desc limit 200) t
    left join public.organizations o on o.id = t.org_id), '[]'::jsonb);
end $$;

revoke all on function public.admin_grant_trial(text, text, text, int, text[], int, text, text), public.admin_adjust_trial(uuid, int),
  public.admin_end_trial(uuid), public.admin_list_trials() from public, anon;
grant execute on function public.admin_grant_trial(text, text, text, int, text[], int, text, text), public.admin_adjust_trial(uuid, int),
  public.admin_end_trial(uuid), public.admin_list_trials() to authenticated;
revoke all on function private.today_co(), private.terms_version(), private.require_platform_admin(), private.record_signup_consent() from public, anon;
grant execute on function private.today_co(), private.terms_version() to authenticated;
