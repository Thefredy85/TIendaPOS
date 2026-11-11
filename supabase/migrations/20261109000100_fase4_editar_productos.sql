-- =====================================================================
-- Fase 4, paso 1: editar datos de un producto desde el panel.
-- Solo agrega funciones; no crea ni altera tablas y no toca productos ni
-- existencias. La web deja una orden en pos_commands y la caja decide si la
-- aplica (ver apply_product_edit en src-tauri/src/main.rs).
-- Editan el superadmin y el dueño. La existencia no se puede pedir.
-- =====================================================================

create or replace function public.panel_edit_product(
  p_business_id uuid, p_internal_id text, p_before jsonb, p_after jsonb, p_undo_of uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_key text; v_val jsonb; v_id uuid;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if jsonb_typeof(p_after) is distinct from 'object' or p_after = '{}'::jsonb then
    raise exception 'No hay cambios que enviar' using errcode = '22023';
  end if;
  for v_key, v_val in select key, value from jsonb_each(p_after) loop
    if v_key not in ('cost', 'price', 'name', 'category', 'min_stock') then
      raise exception 'Campo no permitido: %', v_key using errcode = '22023';
    end if;
    if v_key in ('name', 'category') then
      if jsonb_typeof(v_val) <> 'string' or btrim(v_val #>> '{}') = '' then
        raise exception 'El nombre y la categoría no pueden quedar vacíos' using errcode = '22023';
      end if;
    elsif jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 0 then
      raise exception 'Costo, precio y mínimo deben ser números de 0 en adelante' using errcode = '22023';
    end if;
  end loop;
  if not exists (select 1 from public.pos_products
                  where business_id = p_business_id and internal_id = p_internal_id and deleted_at is null) then
    raise exception 'Ese producto ya no existe' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.pos_commands
              where business_id = p_business_id and status = 'pendiente' and type = 'product_edit'
                and payload ->> 'internal_id' = p_internal_id) then
    raise exception 'Este producto ya tiene un cambio esperando a la caja' using errcode = '23505';
  end if;
  if p_undo_of is not null and not exists (
       select 1 from public.pos_commands
        where id = p_undo_of and business_id = p_business_id and status = 'aplicado' and type = 'product_edit') then
    raise exception 'Solo se puede deshacer un cambio ya aplicado' using errcode = '22023';
  end if;
  insert into public.pos_commands (business_id, type, payload, created_by)
  values (p_business_id, 'product_edit',
          jsonb_strip_nulls(jsonb_build_object('internal_id', p_internal_id, 'before', coalesce(p_before, '{}'::jsonb),
                                               'after', p_after, 'undo_of', p_undo_of)),
          auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Retirar un cambio que todavía no llega a la caja
create or replace function public.panel_cancel_command(p_command_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_bid uuid; n int;
begin
  select business_id into v_bid from public.pos_commands where id = p_command_id;
  if v_bid is null or not private.is_owner(v_bid) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  update public.pos_commands set status = 'cancelado', result = 'Cancelado desde el panel'
   where id = p_command_id and status = 'pendiente';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Modificados recientes, con el correo de quien hizo el cambio (por eso es definer)
create or replace function public.panel_recent_changes(p_business_id uuid, p_days int default 30)
returns table (id uuid, type text, payload jsonb, status text, created_at timestamptz,
               applied_at timestamptz, result text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_member(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select c.id, c.type, c.payload, c.status, c.created_at, c.applied_at, c.result, u.email::text
      from public.pos_commands c left join auth.users u on u.id = c.created_by
     where c.business_id = p_business_id
       and c.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
     order by c.seq desc
     limit 300;
end $$;

revoke all on function public.panel_edit_product(uuid, text, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.panel_cancel_command(uuid)                         from public, anon, authenticated;
revoke all on function public.panel_recent_changes(uuid, int)                    from public, anon, authenticated;
grant execute on function public.panel_edit_product(uuid, text, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.panel_cancel_command(uuid)                         to authenticated;
grant execute on function public.panel_recent_changes(uuid, int)                    to authenticated;
