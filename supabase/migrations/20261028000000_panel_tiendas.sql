-- =====================================================================
-- Panel de cada tienda (segunda entrega del panel). Solo agrega funciones;
-- no crea ni altera tablas y no toca datos.
--
-- - Reportes (por día, por producto y por cajero) calculados en la nube para
--   que la tablet no descargue miles de líneas. Son "security invoker": usan
--   los mismos permisos de lectura (RLS) que el resto del panel.
-- - Accesos al panel: el superadmin liga a dueños y gestores; el dueño solo
--   liga o quita gestores de su negocio. La persona debe haberse registrado
--   antes en la página (no se crean cuentas desde aquí).
-- - El dueño y el gestor ven su propia licencia (solo lectura, sin el secreto
--   del código de desbloqueo).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Reportes. Días en hora local de la tienda (p_tz, p. ej. America/Mexico_City).
--    Las ventas canceladas no suman a los totales; se cuentan aparte.
-- ---------------------------------------------------------------------

create or replace function public.panel_report_daily(
  p_business_id uuid, p_from timestamptz, p_to timestamptz, p_tz text default 'America/Mexico_City')
returns table (day date, total numeric, tickets int, cancelled int, profit numeric)
language sql stable security invoker set search_path = '' as $$
  select (s.ts at time zone p_tz)::date,
         coalesce(sum(s.total) filter (where not s.cancelled), 0),
         (count(*) filter (where not s.cancelled))::int,
         (count(*) filter (where s.cancelled))::int,
         coalesce(sum(s.profit) filter (where not s.cancelled), 0)
  from public.pos_sales s
  where s.business_id = p_business_id and s.ts >= p_from and s.ts < p_to
  group by 1
  order by 1
$$;

create or replace function public.panel_report_products(
  p_business_id uuid, p_from timestamptz, p_to timestamptz)
returns table (internal_id text, barcode text, name text, qty numeric, amount numeric, cost numeric, tickets int)
language sql stable security invoker set search_path = '' as $$
  select coalesce(i.internal_id, i.barcode, i.name),
         max(i.barcode), max(i.name),
         coalesce(sum(i.qty), 0),
         coalesce(sum(i.qty * i.price), 0),
         coalesce(sum(i.qty * i.cost), 0),
         count(distinct i.sale_id)::int
  from public.pos_sale_items i
  join public.pos_sales s on s.business_id = i.business_id and s.id = i.sale_id
  where i.business_id = p_business_id and s.ts >= p_from and s.ts < p_to and not s.cancelled
  group by 1
  order by 5 desc
$$;

create or replace function public.panel_report_cashiers(
  p_business_id uuid, p_from timestamptz, p_to timestamptz)
returns table (cashier text, total numeric, tickets int, cancelled int, cancelled_amount numeric)
language sql stable security invoker set search_path = '' as $$
  select coalesce(s.cashier, '—'),
         coalesce(sum(s.total) filter (where not s.cancelled), 0),
         (count(*) filter (where not s.cancelled))::int,
         (count(*) filter (where s.cancelled))::int,
         coalesce(sum(s.total) filter (where s.cancelled), 0)
  from public.pos_sales s
  where s.business_id = p_business_id and s.ts >= p_from and s.ts < p_to
  group by 1
  order by 2 desc
$$;

-- ---------------------------------------------------------------------
-- 2. Accesos al panel
-- ---------------------------------------------------------------------

-- Lista de accesos con su correo (los correos están en auth.users, por eso es definer).
-- Solo el superadmin o el dueño del negocio.
create or replace function public.panel_list_members(p_business_id uuid)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.created_at
    from public.business_members m join auth.users u on u.id = m.user_id
    where m.business_id = p_business_id
    order by m.role desc, u.email;
end $$;

-- Liga a una persona ya registrada. El superadmin puede dar 'owner' o 'gestor';
-- el dueño solo 'gestor'. Si ya tenía acceso, solo cambia el rol (con las mismas reglas).
create or replace function public.panel_add_member(p_business_id uuid, p_email text, p_role text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid; v_old text;
begin
  if p_role not in ('owner', 'gestor') then
    raise exception 'Rol inválido: %', p_role using errcode = '22023';
  end if;
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_role = 'owner' and not private.is_superadmin() then
    raise exception 'Solo el administrador del sistema puede dar acceso de dueño' using errcode = '42501';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'Ese correo aún no tiene cuenta. Pide a la persona que se registre primero en la página.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.superadmins where user_id = v_uid) then
    raise exception 'Esa cuenta es la del administrador del sistema' using errcode = '22023';
  end if;
  select role into v_old from public.business_members where business_id = p_business_id and user_id = v_uid;
  if v_old = 'owner' and not private.is_superadmin() then
    raise exception 'Solo el administrador del sistema puede cambiar a un dueño' using errcode = '42501';
  end if;
  insert into public.business_members (business_id, user_id, role)
  values (p_business_id, v_uid, p_role)
  on conflict (business_id, user_id) do update set role = excluded.role;
  return jsonb_build_object('user_id', v_uid, 'role', p_role, 'before', v_old);
end $$;

-- Quita un acceso. El superadmin quita a cualquiera; el dueño solo a gestores.
create or replace function public.panel_remove_member(p_business_id uuid, p_user_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_role text;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select role into v_role from public.business_members where business_id = p_business_id and user_id = p_user_id;
  if v_role is null then
    return false;
  end if;
  if v_role = 'owner' and not private.is_superadmin() then
    raise exception 'Solo el administrador del sistema puede quitar a un dueño' using errcode = '42501';
  end if;
  delete from public.business_members where business_id = p_business_id and user_id = p_user_id;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- 3. Licencia propia (dueño y gestor: solo lectura, sin unlock_secret)
-- ---------------------------------------------------------------------
create or replace function public.panel_my_license(p_business_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l public.licenses; v_contact text;
begin
  if not private.is_member(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into l from public.licenses where business_id = p_business_id;
  select contact_text into v_contact from public.app_policy limit 1;
  if l.business_id is null then
    return jsonb_build_object('defined', false, 'contact_text', v_contact);
  end if;
  return jsonb_build_object(
    'defined', true, 'cut_day', l.cut_day, 'monthly_amount', l.monthly_amount,
    'paid_until', l.paid_until, 'enforce', l.enforce, 'contact_text', v_contact);
end $$;

-- ---------------------------------------------------------------------
-- 4. Permisos
-- ---------------------------------------------------------------------
revoke all on function public.panel_report_daily(uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.panel_report_products(uuid, timestamptz, timestamptz)    from public, anon, authenticated;
revoke all on function public.panel_report_cashiers(uuid, timestamptz, timestamptz)    from public, anon, authenticated;
revoke all on function public.panel_list_members(uuid)                                 from public, anon, authenticated;
revoke all on function public.panel_add_member(uuid, text, text)                       from public, anon, authenticated;
revoke all on function public.panel_remove_member(uuid, uuid)                          from public, anon, authenticated;
revoke all on function public.panel_my_license(uuid)                                   from public, anon, authenticated;
grant execute on function public.panel_report_daily(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.panel_report_products(uuid, timestamptz, timestamptz)    to authenticated;
grant execute on function public.panel_report_cashiers(uuid, timestamptz, timestamptz)    to authenticated;
grant execute on function public.panel_list_members(uuid)                                 to authenticated;
grant execute on function public.panel_add_member(uuid, text, text)                       to authenticated;
grant execute on function public.panel_remove_member(uuid, uuid)                          to authenticated;
grant execute on function public.panel_my_license(uuid)                                   to authenticated;
