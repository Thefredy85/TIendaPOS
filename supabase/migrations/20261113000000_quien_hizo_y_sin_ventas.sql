-- v0.2.19: quién hizo cada cambio y "llegó mercancía y no se ha vendido".
-- Solo funciones: no cambia tablas ni datos.

-- 1) Cada orden que baja a la caja lleva el correo de quien la pidió ("by"). Las órdenes de
--    editar, activar y dar de alta productos no lo traían en sus datos; ahora la caja lo
--    anota en el movimiento ("Panel: correo") para saber quién cambió qué.
create or replace function public.pos_pull_commands(p_token text, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.pos_devices;
begin
  d := private.approved_device(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'seq', c.seq, 'type', c.type,
                                        'payload', c.payload
                                          || case when coalesce(c.payload->>'by', '') <> '' or u.email is null then '{}'::jsonb
                                                  else jsonb_build_object('by', u.email) end
                                          || case when s.secret is null then '{}'::jsonb
                                                  else jsonb_build_object('pin', s.secret) end,
                                        'created_at', c.created_at) order by c.seq)
    from (select * from public.pos_commands
           where business_id = d.business_id and status = 'pendiente'
             and (target_device_id is null or target_device_id = d.id)
           order by seq
           limit greatest(1, least(coalesce(p_limit, 50), 200))) c
    left join public.pos_command_secrets s on s.command_id = c.id
    left join auth.users u on u.id = c.created_by
  ), '[]'::jsonb);
end $$;

-- 2) Revisión: productos a los que les llegó mercancía en el periodo y desde esa entrada no
--    se ha vendido ninguno. Si en el estante ya no están, salieron sin pasar por la caja.
create or replace function public.panel_stock_without_sales(p_business_id uuid, p_from timestamptz, p_to timestamptz)
returns table (internal_id text, barcode text, name text, category text, stock numeric,
               last_in_ts timestamptz, last_in_qty numeric, last_in_user text, last_sale_ts timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_member(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with ent as (
      select distinct on (m.internal_id) m.internal_id, m.ts, m.quantity, m.user_name
        from public.pos_inventory_movements m
       where m.business_id = p_business_id and m.voided_at is null
         and m.type in ('entrada_compra', 'alta_producto') and m.quantity > 0
         and m.ts >= p_from and m.ts < p_to
       order by m.internal_id, m.ts desc
    )
    select p.internal_id, p.barcode, p.name, p.category, p.stock,
           e.ts, e.quantity, e.user_name,
           (select max(v.ts) from public.pos_inventory_movements v
             where v.business_id = p_business_id and v.internal_id = p.internal_id and v.type = 'venta')
      from public.pos_products p
      join ent e on e.internal_id = p.internal_id
     where p.business_id = p_business_id and p.deleted_at is null and p.active and p.stock > 0
       and not exists (select 1 from public.pos_inventory_movements v
                        where v.business_id = p_business_id and v.internal_id = p.internal_id
                          and v.type = 'venta' and v.ts > e.ts)
     order by e.ts asc
     limit 500;
end $$;

revoke all on function public.panel_stock_without_sales(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.panel_stock_without_sales(uuid, timestamptz, timestamptz) to authenticated;
