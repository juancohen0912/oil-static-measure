-- =====================================================================
-- Oil Static Measure · Módulo «Balance volumétrico de facilidad»
--  · Licencia nueva por módulo: 'facility'.
--  · Colección nueva de documentos: 'fac' (días de balance y maestros),
--    que exige la licencia 'facility' (RLS existente vía private.module_of).
--  · Un día de balance cerrado ('fac' con status = 'cerrado') queda protegido
--    igual que un período cerrado de oleoducto: solo un administrador crea una
--    nueva revisión y nadie lo elimina.
-- Cambio aditivo: no modifica datos existentes.
-- =====================================================================

alter table public.licenses drop constraint licenses_module_check;
alter table public.licenses add constraint licenses_module_check
  check (module in ('static', 'pipeline', 'facility'));

alter table public.app_docs drop constraint app_docs_collection_check;
alter table public.app_docs add constraint app_docs_collection_check
  check (collection in ('tanks', 'tabs', 'products', 'vehicles', 'ops', 'pl', 'fac'));

create or replace function private.module_of(c text) returns text
language sql immutable set search_path = '' as $$
  select case c when 'pl' then 'pipeline' when 'fac' then 'facility' else 'static' end;
$$;

create or replace function private.stamp_doc() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.collection <> old.collection or new.doc_id <> old.doc_id then
      raise exception 'No se puede mover un documento entre organizaciones o colecciones';
    end if;
    if old.collection in ('pl', 'fac') and old.data->>'status' = 'cerrado' and not private.is_member(old.org_id, 'admin') then
      raise exception 'Período cerrado: solo un administrador puede crear una nueva revisión';
    end if;
  end if;
  if tg_op = 'DELETE' then
    if old.collection in ('pl', 'fac') and old.data->>'status' = 'cerrado' and (select auth.uid()) is not null then
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

-- create or replace conserva los permisos existentes de ambas funciones.
