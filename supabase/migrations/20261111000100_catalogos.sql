-- =====================================================================
-- v0.2.16: catálogos en la nube y edición desde el panel.
-- Solo agrega: una tabla nueva (pos_catalogs), la parte de catálogos en
-- pos_push (lo demás de pos_push queda igual) y la función panel_save_catalog.
-- No toca productos ni existencias. Renombrar un catálogo deja una orden; la
-- caja la valida y cambia ESE campo en sus productos (apply_catalog_save en
-- src-tauri/src/main.rs), y luego la caja sube los productos como siempre.
-- =====================================================================

create table if not exists public.pos_catalogs (
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind        text not null check (kind in ('category', 'unit', 'supplier', 'presentation')),
  id          text not null,
  device_id   uuid references public.pos_devices (id) on delete set null,
  name        text not null,
  active      boolean not null default true,
  sort_order  numeric,
  data        jsonb not null default '{}'::jsonb,
  deleted_at  timestamptz,
  source_at   timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (business_id, kind, id)
);

alter table public.pos_catalogs enable row level security;
revoke all on public.pos_catalogs from public, anon, authenticated;
grant select on public.pos_catalogs to authenticated;
create policy "miembros leen" on public.pos_catalogs
  for select to authenticated using (private.is_member(business_id));

-- Envío de la caja: igual que antes, más los catálogos
create or replace function public.pos_push(p_token text, p_batch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  d      public.pos_devices;
  b      jsonb := private.obj(p_batch);
  v_at   timestamptz;
  v_bid  uuid;
  n      int;
  result jsonb := '{}'::jsonb;
  k      text;
begin
  d := private.approved_device(p_token);
  v_bid := d.business_id;
  v_at := coalesce(private.ts(b ->> 'at'), now());

  foreach k in array array['products', 'sales', 'movements', 'cash_cuts', 'users', 'events', 'catalogs'] loop
    if jsonb_array_length(private.arr(b -> k)) > 5000 then
      raise exception 'Demasiados registros en "%" (máximo 5000 por envío)', k using errcode = '54000';
    end if;
  end loop;

  -- Productos: solo se aplica si la foto es igual o más nueva que la guardada
  insert into public.pos_products as t (business_id, internal_id, device_id, barcode, name, category,
    presentation, supplier, unit, cost, price, stock, min_stock, description, active, deleted_at, source_at)
  select distinct on (e ->> 'internal_id')
    v_bid, left(e ->> 'internal_id', 100), d.id,
    private.txt(e -> 'barcode', 100), private.txt(e -> 'name', 200), private.txt(e -> 'category', 100),
    private.txt(e -> 'presentation', 100), private.txt(e -> 'supplier', 150), private.txt(e -> 'unit', 40),
    private.num(e -> 'cost'), private.num(e -> 'price'), private.num(e -> 'stock'), private.num(e -> 'min_stock'),
    private.txt(e -> 'description', 1000), private.bool(e -> 'active', true),
    case when private.bool(e -> 'deleted', false) then v_at end, v_at
  from jsonb_array_elements(private.arr(b -> 'products')) e
  where coalesce(btrim(e ->> 'internal_id'), '') <> ''
  order by e ->> 'internal_id'
  on conflict (business_id, internal_id) do update set
    device_id = excluded.device_id, barcode = excluded.barcode, name = excluded.name,
    category = excluded.category, presentation = excluded.presentation, supplier = excluded.supplier,
    unit = excluded.unit, cost = excluded.cost, price = excluded.price, stock = excluded.stock,
    min_stock = excluded.min_stock, description = excluded.description, active = excluded.active,
    deleted_at = excluded.deleted_at, source_at = excluded.source_at, received_at = now()
  where t.source_at <= excluded.source_at;
  get diagnostics n = row_count;
  result := result || jsonb_build_object('products', n);

  -- Ventas: una cancelación nunca se "des-cancela"
  insert into public.pos_sales as t (business_id, id, device_id, ts, subtotal, discount, total,
    payment_method, payment_breakdown, cashier, profit, notes,
    cancelled, cancelled_at, cancelled_by, cancelled_authorized_by)
  select distinct on (e ->> 'id')
    v_bid, left(e ->> 'id', 100), d.id, private.ts(e ->> 'ts'),
    private.num(e -> 'subtotal'), private.num(e -> 'discount'), private.num(e -> 'total'),
    private.txt(e -> 'payment_method', 40), private.obj(e -> 'payment_breakdown'),
    private.txt(e -> 'cashier', 80), private.num(e -> 'profit'), private.txt(e -> 'notes', 1000),
    private.bool(e -> 'cancelled', false), private.ts(e ->> 'cancelled_at'),
    private.txt(e -> 'cancelled_by', 80), private.txt(e -> 'cancelled_authorized_by', 80)
  from jsonb_array_elements(private.arr(b -> 'sales')) e
  where coalesce(btrim(e ->> 'id'), '') <> ''
  order by e ->> 'id'
  on conflict (business_id, id) do update set
    ts = excluded.ts, subtotal = excluded.subtotal, discount = excluded.discount, total = excluded.total,
    payment_method = excluded.payment_method, payment_breakdown = excluded.payment_breakdown,
    cashier = excluded.cashier, profit = excluded.profit, notes = excluded.notes,
    cancelled = t.cancelled or excluded.cancelled,
    cancelled_at = coalesce(excluded.cancelled_at, t.cancelled_at),
    cancelled_by = coalesce(excluded.cancelled_by, t.cancelled_by),
    cancelled_authorized_by = coalesce(excluded.cancelled_authorized_by, t.cancelled_authorized_by),
    received_at = now();
  get diagnostics n = row_count;
  result := result || jsonb_build_object('sales', n);

  -- Detalle de las ventas enviadas: se reemplaza completo (idempotente)
  delete from public.pos_sale_items
   where business_id = v_bid
     and sale_id in (select left(e ->> 'id', 100) from jsonb_array_elements(private.arr(b -> 'sales')) e
                      where jsonb_typeof(e -> 'items') = 'array');
  insert into public.pos_sale_items (business_id, sale_id, line_no, internal_id, barcode, name, qty, price, cost)
  select v_bid, s.sale_id, it.ord::int, private.txt(it.e -> 'internal_id', 100), private.txt(it.e -> 'barcode', 100),
         private.txt(it.e -> 'name', 200), private.num(it.e -> 'qty'), private.num(it.e -> 'price'), private.num(it.e -> 'cost')
  from (select distinct on (e ->> 'id') left(e ->> 'id', 100) sale_id, e -> 'items' items
          from jsonb_array_elements(private.arr(b -> 'sales')) e
         where coalesce(btrim(e ->> 'id'), '') <> '' and jsonb_typeof(e -> 'items') = 'array'
         order by e ->> 'id') s
  cross join lateral jsonb_array_elements(s.items) with ordinality as it(e, ord);

  -- Movimientos de inventario
  insert into public.pos_inventory_movements as t (business_id, id, device_id, ts, type, internal_id,
    product_name, quantity, stock_before, stock_after, unit_cost, total_cost, reason, reference,
    user_name, authorized_by, notes, voided_at)
  select distinct on (e ->> 'id')
    v_bid, left(e ->> 'id', 120), d.id, private.ts(e ->> 'ts'), private.txt(e -> 'type', 40),
    private.txt(e -> 'internal_id', 100), private.txt(e -> 'product_name', 200),
    private.num(e -> 'quantity'), private.num(e -> 'stock_before'), private.num(e -> 'stock_after'),
    private.num(e -> 'unit_cost'), private.num(e -> 'total_cost'), private.txt(e -> 'reason', 300),
    private.txt(e -> 'reference', 120), private.txt(e -> 'user_name', 80), private.txt(e -> 'authorized_by', 80),
    private.txt(e -> 'notes', 1000), case when private.bool(e -> 'deleted', false) then v_at end
  from jsonb_array_elements(private.arr(b -> 'movements')) e
  where coalesce(btrim(e ->> 'id'), '') <> ''
  order by e ->> 'id'
  on conflict (business_id, id) do update set
    ts = excluded.ts, type = excluded.type, internal_id = excluded.internal_id,
    product_name = excluded.product_name, quantity = excluded.quantity,
    stock_before = excluded.stock_before, stock_after = excluded.stock_after,
    unit_cost = excluded.unit_cost, total_cost = excluded.total_cost, reason = excluded.reason,
    reference = excluded.reference, user_name = excluded.user_name,
    authorized_by = excluded.authorized_by, notes = excluded.notes,
    voided_at = coalesce(t.voided_at, excluded.voided_at), received_at = now();
  get diagnostics n = row_count;
  result := result || jsonb_build_object('movements', n);

  -- Cortes (apertura, X y Z)
  insert into public.pos_cash_cuts as t (business_id, id, device_id, cut_type, ts, period_start, period_end,
    opening_amount, total, sales_count, payments, cashier, notes, detail)
  select distinct on (e ->> 'id')
    v_bid, left(e ->> 'id', 100), d.id,
    case when lower(e ->> 'type') in ('apertura', 'x', 'z') then lower(e ->> 'type') end,
    private.ts(e ->> 'ts'), private.ts(e ->> 'period_start'), private.ts(e ->> 'period_end'),
    private.num(e -> 'opening_amount'), private.num(e -> 'total'), private.int(e -> 'sales_count'),
    private.obj(e -> 'payments'), private.txt(e -> 'cashier', 80), private.txt(e -> 'notes', 1000),
    private.obj(e -> 'detail')
  from jsonb_array_elements(private.arr(b -> 'cash_cuts')) e
  where coalesce(btrim(e ->> 'id'), '') <> ''
  order by e ->> 'id'
  on conflict (business_id, id) do update set
    cut_type = excluded.cut_type, ts = excluded.ts, period_start = excluded.period_start,
    period_end = excluded.period_end, opening_amount = excluded.opening_amount, total = excluded.total,
    sales_count = excluded.sales_count, payments = excluded.payments, cashier = excluded.cashier,
    notes = excluded.notes, detail = excluded.detail, received_at = now();
  get diagnostics n = row_count;
  result := result || jsonb_build_object('cash_cuts', n);

  -- Usuarios del POS (solo estos campos; contraseñas y hashes se ignoran)
  insert into public.pos_users as t (business_id, username, device_id, display_name, role, active, deleted_at, source_at)
  select distinct on (e ->> 'username')
    v_bid, left(e ->> 'username', 60), d.id, private.txt(e -> 'display_name', 120),
    private.txt(e -> 'role', 20), private.bool(e -> 'active', true),
    case when private.bool(e -> 'deleted', false) then v_at end, v_at
  from jsonb_array_elements(private.arr(b -> 'users')) e
  where coalesce(btrim(e ->> 'username'), '') <> ''
  order by e ->> 'username'
  on conflict (business_id, username) do update set
    device_id = excluded.device_id, display_name = excluded.display_name, role = excluded.role,
    active = excluded.active, deleted_at = excluded.deleted_at,
    source_at = excluded.source_at, received_at = now()
  where t.source_at <= excluded.source_at;
  get diagnostics n = row_count;
  result := result || jsonb_build_object('users', n);

  -- Permisos por rol
  if jsonb_typeof(b -> 'role_permissions') = 'object' then
    insert into public.pos_role_permissions as t (business_id, device_id, permissions, source_at)
    values (v_bid, d.id, b -> 'role_permissions', v_at)
    on conflict (business_id) do update set
      device_id = excluded.device_id, permissions = excluded.permissions,
      source_at = excluded.source_at, received_at = now()
    where t.source_at <= excluded.source_at;
    get diagnostics n = row_count;
    result := result || jsonb_build_object('role_permissions', n);
  end if;

  -- Catálogos (v0.2.16): categorías, unidades, proveedores y presentaciones
  insert into public.pos_catalogs as t (business_id, kind, id, device_id, name, active, sort_order, data, deleted_at, source_at)
  select distinct on (e ->> 'kind', e ->> 'id')
    v_bid, e ->> 'kind', left(e ->> 'id', 120), d.id, coalesce(private.txt(e -> 'name', 100), ''),
    private.bool(e -> 'active', true), private.num(e -> 'sort_order'), private.obj(e -> 'data'),
    case when private.bool(e -> 'deleted', false) then v_at end, v_at
  from jsonb_array_elements(private.arr(b -> 'catalogs')) e
  where coalesce(btrim(e ->> 'id'), '') <> ''
    and e ->> 'kind' in ('category', 'unit', 'supplier', 'presentation')
  order by e ->> 'kind', e ->> 'id'
  on conflict (business_id, kind, id) do update set
    device_id = excluded.device_id, name = excluded.name, active = excluded.active,
    sort_order = excluded.sort_order, data = excluded.data, deleted_at = excluded.deleted_at,
    source_at = excluded.source_at, received_at = now()
  where t.source_at <= excluded.source_at;
  get diagnostics n = row_count;
  result := result || jsonb_build_object('catalogs', n);

  -- Eventos (alertas)
  insert into public.pos_events (business_id, id, device_id, ts, type, severity, data)
  select distinct on (e ->> 'id')
    v_bid, left(e ->> 'id', 100), d.id, coalesce(private.ts(e ->> 'ts'), now()),
    coalesce(private.txt(e -> 'type', 60), 'otro'),
    case when e ->> 'severity' in ('info', 'aviso', 'critico') then e ->> 'severity' else 'info' end,
    private.obj(e -> 'data')
  from jsonb_array_elements(private.arr(b -> 'events')) e
  where coalesce(btrim(e ->> 'id'), '') <> ''
  order by e ->> 'id'
  on conflict (business_id, id) do nothing;
  get diagnostics n = row_count;
  result := result || jsonb_build_object('events', n);

  update public.pos_devices set last_seen_at = now() where id = d.id;
  return jsonb_build_object('ok', true, 'applied', result, 'server_time', now());
end $$;

-- Alta o edición de un catálogo desde el panel (no borra). p_id vacío = alta.
-- p_old_name es el nombre que vio el panel: si en la caja ya cambió, la caja rechaza.
create or replace function public.panel_save_catalog(
  p_business_id uuid, p_kind text, p_id text, p_old_name text, p_name text,
  p_active boolean, p_data jsonb)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_dup text; v_payload jsonb; k text;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_kind not in ('category', 'unit', 'supplier', 'presentation') then
    raise exception 'Catálogo no reconocido' using errcode = '22023';
  end if;
  if v_name = '' or length(v_name) > 100 then
    raise exception 'El nombre no puede quedar vacío' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_catalogs where business_id = p_business_id) then
    raise exception 'La caja todavía no envía sus catálogos (necesita la versión 0.2.16)' using errcode = '55000';
  end if;
  if coalesce(p_id, '') <> '' and not exists (
       select 1 from public.pos_catalogs
        where business_id = p_business_id and kind = p_kind and id = p_id and deleted_at is null) then
    raise exception 'Ese registro ya no existe' using errcode = 'P0002';
  end if;
  select name into v_dup from public.pos_catalogs
   where business_id = p_business_id and kind = p_kind and deleted_at is null
     and lower(btrim(name)) = lower(v_name) and id <> coalesce(p_id, '') limit 1;
  if v_dup is not null then
    raise exception 'Ya existe "%" en este catálogo', v_dup using errcode = '23505';
  end if;
  if exists (select 1 from public.pos_commands
              where business_id = p_business_id and status = 'pendiente' and type = 'catalog_save'
                and payload ->> 'kind' = p_kind
                and ((coalesce(p_id, '') <> '' and payload ->> 'id' = p_id)
                     or lower(payload ->> 'name') = lower(v_name))) then
    raise exception 'Ya hay un cambio de este registro esperando a la caja' using errcode = '23505';
  end if;
  v_payload := jsonb_build_object('kind', p_kind, 'name', v_name, 'by', private.current_email());
  if coalesce(p_id, '') <> '' then
    v_payload := v_payload || jsonb_build_object('id', p_id, 'old_name', btrim(coalesce(p_old_name, '')));
  end if;
  if p_active is not null then
    v_payload := v_payload || jsonb_build_object('active', p_active);
  end if;
  -- solo los datos propios de cada catálogo, como texto corto
  foreach k in array case p_kind when 'unit' then array['abbreviation']
                                 when 'supplier' then array['phone', 'notes']
                                 else array['description'] end loop
    if p_data ? k then
      if length(coalesce(p_data ->> k, '')) > 300 then
        raise exception 'Un dato es demasiado largo' using errcode = '22023';
      end if;
      v_payload := v_payload || jsonb_build_object(k, btrim(coalesce(p_data ->> k, '')));
    end if;
  end loop;
  insert into public.pos_commands (business_id, type, payload, created_by)
  values (p_business_id, 'catalog_save', v_payload, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.panel_save_catalog(uuid, text, text, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.panel_save_catalog(uuid, text, text, text, text, boolean, jsonb) to authenticated;
