-- =====================================================================
-- Fase 4, paso 2: entradas y salidas, activar/desactivar y alta de productos
-- desde el panel, más dos consultas de solo lectura (productos sospechosos y
-- ventas que no descontaron inventario).
-- Solo agrega funciones; no crea ni altera tablas y no toca productos ni
-- existencias. La web deja órdenes en pos_commands y la caja decide si las
-- aplica (apply_stock_move, apply_product_active y apply_product_create en
-- src-tauri/src/main.rs). Editan el superadmin y el dueño.
-- =====================================================================

-- Código de barras comparable: sin espacios ni signos, en mayúsculas y sin ceros
-- a la izquierda (igual que norm_code en la caja).
create or replace function private.norm_code(p_code text)
returns text language sql immutable set search_path = '' as $$
  select ltrim(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), '0')
$$;

-- Correo de quien hace el cambio (para el movimiento en la caja)
create or replace function private.current_email()
returns text language sql stable security definer set search_path = '' as $$
  select email::text from auth.users where id = auth.uid()
$$;

-- Entrada o salida: siempre suma o resta, nunca fija la existencia.
create or replace function public.panel_stock_move(
  p_business_id uuid, p_internal_id text, p_type text, p_quantity numeric, p_reason text,
  p_undo_of uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_type not in ('entrada_compra', 'salida_manual', 'merma') then
    raise exception 'Tipo de movimiento no permitido: %', p_type using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 100000 then
    raise exception 'La cantidad debe ser mayor que 0' using errcode = '22023';
  end if;
  if btrim(coalesce(p_reason, '')) = '' or length(p_reason) > 200 then
    raise exception 'Escribe el motivo del movimiento' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_products
                  where business_id = p_business_id and internal_id = p_internal_id and deleted_at is null) then
    raise exception 'Ese producto ya no existe' using errcode = 'P0002';
  end if;
  if p_undo_of is not null and not exists (
       select 1 from public.pos_commands
        where id = p_undo_of and business_id = p_business_id and status = 'aplicado' and type = 'stock_move') then
    raise exception 'Solo se puede deshacer un movimiento ya aplicado' using errcode = '22023';
  end if;
  insert into public.pos_commands (business_id, type, payload, created_by)
  values (p_business_id, 'stock_move',
          jsonb_strip_nulls(jsonb_build_object('internal_id', p_internal_id, 'type', p_type,
            'quantity', p_quantity, 'reason', btrim(p_reason), 'by', private.current_email(), 'undo_of', p_undo_of)),
          auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Ocultar o volver a mostrar un producto en la venta (no borra nada)
create or replace function public.panel_set_product_active(p_business_id uuid, p_internal_id text, p_active boolean)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_active is null then
    raise exception 'Falta indicar si se activa o se desactiva' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_products
                  where business_id = p_business_id and internal_id = p_internal_id and deleted_at is null) then
    raise exception 'Ese producto ya no existe' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.pos_commands
              where business_id = p_business_id and status = 'pendiente' and type = 'product_active'
                and payload ->> 'internal_id' = p_internal_id) then
    raise exception 'Este producto ya tiene un cambio esperando a la caja' using errcode = '23505';
  end if;
  insert into public.pos_commands (business_id, type, payload, created_by)
  values (p_business_id, 'product_active',
          jsonb_build_object('internal_id', p_internal_id, 'active', p_active), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Alta de producto. Nace con existencia 0; la caja vuelve a revisar el código.
create or replace function public.panel_create_product(
  p_business_id uuid, p_barcode text, p_name text, p_category text,
  p_cost numeric, p_price numeric, p_min_stock numeric)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_code text := private.norm_code(p_barcode); v_dup text;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_code = '' then
    raise exception 'El código de barras es obligatorio' using errcode = '22023';
  end if;
  if btrim(coalesce(p_name, '')) = '' or btrim(coalesce(p_category, '')) = '' then
    raise exception 'El nombre y la categoría no pueden quedar vacíos' using errcode = '22023';
  end if;
  if p_cost is null or p_price is null or p_min_stock is null or p_cost < 0 or p_price < 0 or p_min_stock < 0 then
    raise exception 'Costo, precio y mínimo deben ser números de 0 en adelante' using errcode = '22023';
  end if;
  select name into v_dup from public.pos_products
   where business_id = p_business_id and deleted_at is null and private.norm_code(barcode) = v_code limit 1;
  if v_dup is not null then
    raise exception 'Ese código de barras ya es de "%"', v_dup using errcode = '23505';
  end if;
  if exists (select 1 from public.pos_commands
              where business_id = p_business_id and status = 'pendiente' and type = 'product_create'
                and private.norm_code(payload ->> 'barcode') = v_code) then
    raise exception 'Ya hay un alta con ese código esperando a la caja' using errcode = '23505';
  end if;
  insert into public.pos_commands (business_id, type, payload, created_by)
  values (p_business_id, 'product_create',
          jsonb_build_object('barcode', btrim(p_barcode), 'name', btrim(p_name), 'category', btrim(p_category),
                             'cost', p_cost, 'price', p_price, 'min_stock', p_min_stock),
          auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Productos cuyo nombre actual no coincide con el que tenían en sus ventas o
-- movimientos (pudieron renombrarse por la falla de v0.2.9 a v0.2.11). Solo lectura.
create or replace function public.panel_suspicious_products(p_business_id uuid)
returns table (internal_id text, barcode text, name text, stock numeric, old_names text[], lines int, last_seen timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_member(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with seen as (
      select i.internal_id, btrim(i.name) as old_name, s.ts
        from public.pos_sale_items i
        join public.pos_sales s on s.business_id = i.business_id and s.id = i.sale_id
       where i.business_id = p_business_id and coalesce(btrim(i.name), '') <> ''
      union all
      select m.internal_id, btrim(m.product_name), m.ts
        from public.pos_inventory_movements m
       where m.business_id = p_business_id and coalesce(btrim(m.product_name), '') <> ''
    )
    select p.internal_id, p.barcode, p.name, p.stock,
           array_agg(distinct x.old_name order by x.old_name), count(*)::int, max(x.ts)
      from public.pos_products p
      join seen x on x.internal_id = p.internal_id and lower(x.old_name) <> lower(btrim(coalesce(p.name, '')))
     where p.business_id = p_business_id and p.deleted_at is null
     group by p.internal_id, p.barcode, p.name, p.stock
     order by max(x.ts) desc;
end $$;

-- Líneas de venta (no canceladas) que no tienen su movimiento de "venta":
-- la existencia no bajó. Solo lectura.
create or replace function public.panel_sales_without_moves(p_business_id uuid, p_from timestamptz, p_to timestamptz)
returns table (sale_id text, ts timestamptz, internal_id text, name text, qty numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_member(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select s.id, s.ts, i.internal_id, i.name, i.qty
      from public.pos_sales s
      join public.pos_sale_items i on i.business_id = s.business_id and i.sale_id = s.id
     where s.business_id = p_business_id and not s.cancelled
       and s.ts >= p_from and s.ts < p_to
       and coalesce(i.internal_id, '') <> ''
       and not exists (select 1 from public.pos_inventory_movements m
                        where m.business_id = s.business_id and m.type = 'venta'
                          and m.reference = s.id and m.internal_id = i.internal_id)
     order by s.ts desc
     limit 500;
end $$;

revoke all on function private.norm_code(text) from public, anon, authenticated;
revoke all on function private.current_email() from public, anon, authenticated;
revoke all on function public.panel_stock_move(uuid, text, text, numeric, text, uuid)            from public, anon, authenticated;
revoke all on function public.panel_set_product_active(uuid, text, boolean)                    from public, anon, authenticated;
revoke all on function public.panel_create_product(uuid, text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.panel_suspicious_products(uuid)                                  from public, anon, authenticated;
revoke all on function public.panel_sales_without_moves(uuid, timestamptz, timestamptz)        from public, anon, authenticated;
grant execute on function public.panel_stock_move(uuid, text, text, numeric, text, uuid)            to authenticated;
grant execute on function public.panel_set_product_active(uuid, text, boolean)                    to authenticated;
grant execute on function public.panel_create_product(uuid, text, text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.panel_suspicious_products(uuid)                                  to authenticated;
grant execute on function public.panel_sales_without_moves(uuid, timestamptz, timestamptz)        to authenticated;
