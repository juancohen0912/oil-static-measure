-- Solo el administrador de la plataforma puede retirar licencias
grant delete on public.licenses to authenticated;
create policy lic_admin_del on public.licenses for delete to authenticated using ((select private.is_platform_admin()));
-- La interfaz pregunta si el usuario actual administra la plataforma (solo responde sobre sí mismo)
create or replace function public.am_platform_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select (select private.aal2()) and (select private.is_platform_admin());
$$;
revoke all on function public.am_platform_admin() from public, anon;
grant execute on function public.am_platform_admin() to authenticated;
