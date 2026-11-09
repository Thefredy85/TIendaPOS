-- =====================================================================
-- Cuentas registradas en el panel que aún no tienen tienda asignada.
-- Solo agrega una función de lectura; no crea ni altera tablas y no toca
-- datos. Solo el superadmin puede usarla. Para asignar la tienda se usa
-- panel_add_member, que ya existe.
-- =====================================================================

-- Los correos están en auth.users, por eso es definer.
create or replace function public.panel_unassigned_accounts()
returns table (user_id uuid, email text, created_at timestamptz, confirmed boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.created_at, u.email_confirmed_at is not null
    from auth.users u
    where not exists (select 1 from public.business_members m where m.user_id = u.id)
      and not exists (select 1 from public.superadmins s where s.user_id = u.id)
    order by u.created_at desc;
end $$;

revoke all on function public.panel_unassigned_accounts() from public, anon, authenticated;
grant execute on function public.panel_unassigned_accounts() to authenticated;
