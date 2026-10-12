-- =====================================================================
-- Fase 1: seguridad y esquema nuevo (ver docs/PLAN-WEB.md)
--
-- 1. Las tablas viejas (pos_meta, pos_products, pos_sales, pos_cash_cuts)
--    se mueven al esquema "legacy", que la API no expone, y se les quita
--    todo permiso. No se borra ni se modifica ningún dato: quedan como
--    respaldo. Las apps <= v0.2.11 dejan de sincronizar (opción 1); lo local
--    sigue siendo la verdad y la v0.2.12 vuelve a subir todo.
-- 2. Negocios y miembros del panel (Supabase Auth).
-- 3. Tablas nuevas con business_id y device_id. Lectura solo para miembros
--    del negocio con sesión; nadie escribe directo: la app escribe por RPC.
-- 4. Cada caja (instalación) se registra y recibe un token secreto. En la
--    nube solo se guarda su hash (sha256). La license_key NO es secreta
--    (se deriva de la hora de instalación), así que nunca basta por sí sola.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tablas viejas fuera de la API
-- ---------------------------------------------------------------------
create schema if not exists legacy;
revoke all on schema legacy from public, anon, authenticated;

alter table public.pos_meta      set schema legacy;
alter table public.pos_products  set schema legacy;
alter table public.pos_sales     set schema legacy;
alter table public.pos_cash_cuts set schema legacy;

revoke all on all tables in schema legacy from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Funciones internas (esquema "private", no expuesto por la API)
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;  -- las reglas RLS llaman a is_member()

create or replace function private.ts(t text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  return t::timestamptz;
exception when others then
  return null;
end $$;

create or replace function private.num(j jsonb) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if j is null then return null; end if;
  if jsonb_typeof(j) = 'number' then return (j #>> '{}')::numeric; end if;
  if jsonb_typeof(j) = 'string' and btrim(j #>> '{}') <> '' then return (j #>> '{}')::numeric; end if;
  return null;
exception when others then
  return null;
end $$;

create or replace function private.bool(j jsonb, dflt boolean) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when j is null or jsonb_typeof(j) = 'null' then dflt
    when jsonb_typeof(j) = 'boolean' then (j #>> '{}')::boolean
    when lower(j #>> '{}') in ('true', '1', 'si', 'sí') then true
    when lower(j #>> '{}') in ('false', '0', 'no') then false
    else dflt end
$$;

create or replace function private.int(j jsonb) returns int
language sql immutable set search_path = '' as $$
  select case when v between -2000000000 and 2000000000 then round(v)::int end
  from (select private.num(j) v) x
$$;

create or replace function private.txt(j jsonb, maxlen int default 500) returns text
language sql immutable set search_path = '' as $$
  select nullif(left(btrim(j #>> '{}'), maxlen), '')
$$;

create or replace function private.arr(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end
$$;

create or replace function private.obj(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(j) = 'object' then j else '{}'::jsonb end
$$;

-- ---------------------------------------------------------------------
-- 2. Negocios, miembros y superadmin
-- ---------------------------------------------------------------------
create table public.businesses (
  id          uuid primary key default gen_random_uuid(),
  license_key text not null unique,
  name        text,
  status      text not null default 'activo' check (status in ('activo', 'suspendido')),
  origin      text not null default 'app' check (origin in ('app', 'migracion', 'panel')),
  created_at  timestamptz not null default now()
);

create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('owner', 'gestor')),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members (user_id);

create table public.superadmins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function private.is_superadmin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.superadmins where user_id = auth.uid())
$$;

create or replace function private.is_member(p_business_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_superadmin()
      or exists (select 1 from public.business_members
                 where business_id = p_business_id and user_id = auth.uid())
$$;

create or replace function private.is_owner(p_business_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_superadmin()
      or exists (select 1 from public.business_members
                 where business_id = p_business_id and user_id = auth.uid() and role = 'owner')
$$;

-- Los negocios que ya existían (sin tocar sus datos, solo se registran)
insert into public.businesses (license_key, name, origin)
select license_key, business_name, 'migracion' from legacy.pos_meta
on conflict (license_key) do nothing;

-- ---------------------------------------------------------------------
-- 3. Cajas (instalaciones de la app)
-- ---------------------------------------------------------------------
create table public.pos_devices (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  name                text,
  status              text not null default 'pendiente'
                        check (status in ('pendiente', 'aprobado', 'revocado')),
  app_version         text,
  last_seen_at        timestamptz,
  session_user_name   text,
  cash_open           boolean,
  cash_period_start   timestamptz,
  cash_opening_amount numeric,
  registered_at       timestamptz not null default now(),
  approved_at         timestamptz,
  approved_by         uuid references auth.users (id) on delete set null
);
create index pos_devices_business_idx on public.pos_devices (business_id);

-- El hash del token vive aparte, en un esquema que la API no expone
create table private.device_tokens (
  device_id  uuid primary key references public.pos_devices (id) on delete cascade,
  token_hash text not null unique
);

-- ---------------------------------------------------------------------
-- 4. Datos de la tienda (espejo de la base local)
-- ---------------------------------------------------------------------
create table public.pos_products (
  business_id  uuid not null references public.businesses (id) on delete cascade,
  internal_id  text not null,
  device_id    uuid references public.pos_devices (id) on delete set null,
  barcode      text,
  name         text,
  category     text,
  presentation text,
  supplier     text,
  unit         text,
  cost         numeric,
  price        numeric,
  stock        numeric,
  min_stock    numeric,
  description  text,
  active       boolean not null default true,
  deleted_at   timestamptz,
  source_at    timestamptz not null,           -- hora (en la caja) de la foto que se subió
  received_at  timestamptz not null default now(),
  primary key (business_id, internal_id)
);
create index pos_products_barcode_idx on public.pos_products (business_id, barcode);

create table public.pos_sales (
  business_id             uuid not null references public.businesses (id) on delete cascade,
  id                      text not null,
  device_id               uuid references public.pos_devices (id) on delete set null,
  ts                      timestamptz,
  subtotal                numeric,
  discount                numeric,
  total                   numeric,
  payment_method          text,
  payment_breakdown       jsonb not null default '{}'::jsonb,
  cashier                 text,
  profit                  numeric,
  notes                   text,
  cancelled               boolean not null default false,
  cancelled_at            timestamptz,
  cancelled_by            text,
  cancelled_authorized_by text,
  received_at             timestamptz not null default now(),
  primary key (business_id, id)
);
create index pos_sales_ts_idx on public.pos_sales (business_id, ts desc);

create table public.pos_sale_items (
  business_id uuid not null,
  sale_id     text not null,
  line_no     int  not null,
  internal_id text,
  barcode     text,
  name        text,
  qty         numeric,
  price       numeric,
  cost        numeric,
  primary key (business_id, sale_id, line_no),
  foreign key (business_id, sale_id) references public.pos_sales (business_id, id) on delete cascade
);
create index pos_sale_items_product_idx on public.pos_sale_items (business_id, internal_id);

create table public.pos_inventory_movements (
  business_id   uuid not null references public.businesses (id) on delete cascade,
  id            text not null,
  device_id     uuid references public.pos_devices (id) on delete set null,
  ts            timestamptz,
  type          text,          -- entrada_compra, salida_manual, merma, venta, devolucion_venta, ajuste_conteo, alta, baja...
  internal_id   text,
  product_name  text,
  quantity      numeric,
  stock_before  numeric,
  stock_after   numeric,
  unit_cost     numeric,
  total_cost    numeric,
  reason        text,
  reference     text,
  user_name     text,
  authorized_by text,
  notes         text,
  voided_at     timestamptz,   -- el movimiento se eliminó en la caja (queda su contraparte)
  received_at   timestamptz not null default now(),
  primary key (business_id, id)
);
create index pos_movements_ts_idx on public.pos_inventory_movements (business_id, ts desc);
create index pos_movements_product_idx on public.pos_inventory_movements (business_id, internal_id);

create table public.pos_cash_cuts (
  business_id    uuid not null references public.businesses (id) on delete cascade,
  id             text not null,
  device_id      uuid references public.pos_devices (id) on delete set null,
  cut_type       text check (cut_type in ('apertura', 'x', 'z')),
  ts             timestamptz,
  period_start   timestamptz,
  period_end     timestamptz,
  opening_amount numeric,
  total          numeric,
  sales_count    int,
  payments       jsonb not null default '{}'::jsonb,   -- total por forma de pago
  cashier        text,
  notes          text,
  detail         jsonb not null default '{}'::jsonb,   -- detalle completo del corte (lo que imprime el ticket)
  received_at    timestamptz not null default now(),
  primary key (business_id, id)
);
create index pos_cash_cuts_ts_idx on public.pos_cash_cuts (business_id, ts desc);

-- Usuarios del POS: NUNCA contraseñas ni hashes. pos_push solo toma los campos de abajo.
create table public.pos_users (
  business_id  uuid not null references public.businesses (id) on delete cascade,
  username     text not null,
  device_id    uuid references public.pos_devices (id) on delete set null,
  display_name text,
  role         text,
  active       boolean not null default true,
  deleted_at   timestamptz,
  source_at    timestamptz not null,
  received_at  timestamptz not null default now(),
  primary key (business_id, username)
);

create table public.pos_role_permissions (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  device_id   uuid references public.pos_devices (id) on delete set null,
  permissions jsonb not null default '{}'::jsonb,   -- { "cajero": { "movements": false, ... }, ... }
  source_at   timestamptz not null,
  received_at timestamptz not null default now()
);

-- Base para alertas (fase 6)
create table public.pos_events (
  business_id uuid not null references public.businesses (id) on delete cascade,
  id          text not null,
  device_id   uuid references public.pos_devices (id) on delete set null,
  ts          timestamptz not null default now(),
  type        text not null,
  severity    text not null default 'info' check (severity in ('info', 'aviso', 'critico')),
  data        jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  received_at timestamptz not null default now(),
  primary key (business_id, id)
);
create index pos_events_ts_idx on public.pos_events (business_id, ts desc);

-- Órdenes desde la web hacia la caja (fase 4). La web podrá insertar a partir de la fase 4.
create table public.pos_commands (
  id                uuid primary key default gen_random_uuid(),
  seq               bigint generated always as identity,
  business_id       uuid not null references public.businesses (id) on delete cascade,
  target_device_id  uuid references public.pos_devices (id) on delete cascade,  -- null = cualquier caja del negocio
  type              text not null,
  payload           jsonb not null default '{}'::jsonb,
  status            text not null default 'pendiente'
                      check (status in ('pendiente', 'aplicado', 'rechazado', 'cancelado')),
  created_by        uuid references auth.users (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  applied_at        timestamptz,
  applied_device_id uuid references public.pos_devices (id) on delete set null,
  result            text
);
create index pos_commands_pending_idx on public.pos_commands (business_id, seq) where status = 'pendiente';

-- ---------------------------------------------------------------------
-- 5. Permisos y RLS: solo lectura para miembros; escritura solo por RPC
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'businesses', 'business_members', 'superadmins', 'pos_devices', 'pos_products',
    'pos_sales', 'pos_sale_items', 'pos_inventory_movements', 'pos_cash_cuts',
    'pos_users', 'pos_role_permissions', 'pos_events', 'pos_commands'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;

  foreach t in array array[
    'pos_devices', 'pos_products', 'pos_sales', 'pos_sale_items', 'pos_inventory_movements',
    'pos_cash_cuts', 'pos_users', 'pos_role_permissions', 'pos_events', 'pos_commands'
  ] loop
    execute format(
      'create policy "miembros leen" on public.%I for select to authenticated using (private.is_member(business_id))', t);
  end loop;
end $$;

revoke all on private.device_tokens from public, anon, authenticated;

create policy "miembros leen" on public.businesses
  for select to authenticated using (private.is_member(id));
create policy "cada quien ve sus membresias" on public.business_members
  for select to authenticated using (user_id = auth.uid() or private.is_superadmin());
create policy "superadmin se ve" on public.superadmins
  for select to authenticated using (user_id = auth.uid());

grant execute on function private.is_member(uuid), private.is_superadmin(), private.is_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. RPC de la app (rol anon, llave publishable)
-- ---------------------------------------------------------------------

-- Busca la caja por su token. No exige estado: cada RPC decide.
create or replace function private.device_by_token(p_token text) returns public.pos_devices
language plpgsql stable security definer set search_path = '' as $$
declare d public.pos_devices;
begin
  if p_token is null or length(p_token) < 32 or length(p_token) > 200 then
    raise exception 'Token de caja inválido' using errcode = '42501';
  end if;
  select pd.* into d from private.device_tokens dt
    join public.pos_devices pd on pd.id = dt.device_id
   where dt.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found or d.status = 'revocado' then
    raise exception 'Caja no registrada o revocada' using errcode = '42501';
  end if;
  return d;
end $$;

create or replace function private.approved_device(p_token text) returns public.pos_devices
language plpgsql stable security definer set search_path = '' as $$
declare d public.pos_devices;
begin
  d := private.device_by_token(p_token);
  if d.status <> 'aprobado' then
    raise exception 'Caja pendiente de aprobación' using errcode = '42501';
  end if;
  return d;
end $$;

-- Registro de una caja. Devuelve su id y su token UNA sola vez.
-- La caja se aprueba sola solo si este registro crea el negocio. En un negocio
-- que ya existe (incluye los migrados) queda "pendiente" hasta que un owner o
-- el superadmin la apruebe con pos_approve_device.
create or replace function public.pos_register_device(
  p_license_key text, p_device_name text default null,
  p_app_version text default null, p_business_name text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key   text := btrim(coalesce(p_license_key, ''));
  v_biz   public.businesses;
  v_new   boolean := false;
  v_token text;
  v_dev   public.pos_devices;
begin
  if length(v_key) < 4 or length(v_key) > 64 then
    raise exception 'Licencia inválida' using errcode = '22023';
  end if;

  select * into v_biz from public.businesses where license_key = v_key;
  if not found then
    -- freno contra registros masivos de negocios falsos
    if (select count(*) from public.businesses
         where origin = 'app' and created_at > now() - interval '1 hour') >= 30 then
      raise exception 'Demasiados registros nuevos, intenta más tarde' using errcode = '53400';
    end if;
    insert into public.businesses (license_key, name, origin)
    values (v_key, private.txt(to_jsonb(p_business_name), 120), 'app')
    on conflict (license_key) do nothing
    returning * into v_biz;
    if found then
      v_new := true;
    else
      select * into v_biz from public.businesses where license_key = v_key;
    end if;
  end if;

  if not v_new and (select count(*) from public.pos_devices
                     where business_id = v_biz.id and status = 'pendiente') >= 10 then
    raise exception 'Hay demasiadas cajas pendientes de aprobación en este negocio' using errcode = '53400';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.pos_devices (business_id, name, status, app_version, approved_at, last_seen_at)
  values (v_biz.id,
          private.txt(to_jsonb(p_device_name), 80),
          case when v_new then 'aprobado' else 'pendiente' end,
          private.txt(to_jsonb(p_app_version), 30),
          case when v_new then now() end,
          now())
  returning * into v_dev;
  insert into private.device_tokens (device_id, token_hash)
  values (v_dev.id, encode(extensions.digest(v_token, 'sha256'), 'hex'));

  return jsonb_build_object('device_id', v_dev.id, 'token', v_token, 'status', v_dev.status);
end $$;

-- Latido: estado de la caja. Funciona aunque esté pendiente (así sabe si ya la aprobaron).
create or replace function public.pos_heartbeat(p_token text, p_info jsonb default '{}'::jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  d    public.pos_devices;
  i    jsonb := private.obj(p_info);
  v_bs text;
begin
  d := private.device_by_token(p_token);
  update public.pos_devices set
    last_seen_at        = now(),
    app_version         = coalesce(private.txt(i -> 'app_version', 30), app_version),
    session_user_name   = private.txt(i -> 'session_user', 80),
    cash_open           = private.bool(i -> 'cash_open', null),
    cash_period_start   = private.ts(i ->> 'cash_period_start'),
    cash_opening_amount = private.num(i -> 'cash_opening_amount')
  where id = d.id;

  if d.status = 'aprobado' and private.txt(i -> 'business_name', 120) is not null then
    update public.businesses set name = private.txt(i -> 'business_name', 120) where id = d.business_id;
  end if;

  select status into v_bs from public.businesses where id = d.business_id;
  return jsonb_build_object('device_id', d.id, 'status', d.status,
                            'business_status', v_bs, 'server_time', now());
end $$;

-- Envío de datos. Idempotente: se puede reenviar lo mismo sin duplicar.
-- p_batch = { "at": "<hora de la foto en la caja>",
--   "products": [...], "sales": [... con "items": [...]], "movements": [...],
--   "cash_cuts": [...], "users": [...], "role_permissions": {...}, "events": [...] }
create or replace function public.pos_push(p_token text, p_batch jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
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

  foreach k in array array['products', 'sales', 'movements', 'cash_cuts', 'users', 'events'] loop
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

-- Órdenes pendientes para esta caja, en orden
create or replace function public.pos_pull_commands(p_token text, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.pos_devices;
begin
  d := private.approved_device(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'seq', c.seq, 'type', c.type,
                                        'payload', c.payload, 'created_at', c.created_at) order by c.seq)
    from (select * from public.pos_commands
           where business_id = d.business_id and status = 'pendiente'
             and (target_device_id is null or target_device_id = d.id)
           order by seq
           limit greatest(1, least(coalesce(p_limit, 50), 200))) c
  ), '[]'::jsonb);
end $$;

-- Confirmación de una orden: aplicado o rechazado (con motivo). La primera confirmación gana.
create or replace function public.pos_ack_command(p_token text, p_command_id uuid, p_status text, p_result text default null)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare d public.pos_devices; n int;
begin
  d := private.approved_device(p_token);
  if p_status not in ('aplicado', 'rechazado') then
    raise exception 'Estado inválido: %', p_status using errcode = '22023';
  end if;
  update public.pos_commands set
    status = p_status, applied_at = now(), applied_device_id = d.id, result = left(p_result, 1000)
  where id = p_command_id and business_id = d.business_id and status = 'pendiente'
    and (target_device_id is null or target_device_id = d.id);
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---------------------------------------------------------------------
-- 7. RPC del panel (usuarios con sesión)
-- ---------------------------------------------------------------------
-- Aprobar o revocar una caja. Solo el owner del negocio o el superadmin.
create or replace function public.pos_set_device_status(p_device_id uuid, p_status text)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_bid uuid;
begin
  if p_status not in ('aprobado', 'revocado') then
    raise exception 'Estado inválido: %', p_status using errcode = '22023';
  end if;
  select business_id into v_bid from public.pos_devices where id = p_device_id;
  if v_bid is null or not private.is_owner(v_bid) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  update public.pos_devices set
    status = p_status,
    approved_at = case when p_status = 'aprobado' then now() else approved_at end,
    approved_by = case when p_status = 'aprobado' then auth.uid() else approved_by end
  where id = p_device_id;
  return true;
end $$;

-- Permisos de ejecución: nada por defecto, luego solo lo necesario
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_member(uuid), private.is_superadmin(), private.is_owner(uuid) to authenticated;

revoke all on function public.pos_register_device(text, text, text, text) from public, anon, authenticated;
revoke all on function public.pos_heartbeat(text, jsonb)                 from public, anon, authenticated;
revoke all on function public.pos_push(text, jsonb)                      from public, anon, authenticated;
revoke all on function public.pos_pull_commands(text, int)               from public, anon, authenticated;
revoke all on function public.pos_ack_command(text, uuid, text, text)    from public, anon, authenticated;
revoke all on function public.pos_set_device_status(uuid, text)          from public, anon, authenticated;

grant execute on function public.pos_register_device(text, text, text, text) to anon;
grant execute on function public.pos_heartbeat(text, jsonb)                 to anon;
grant execute on function public.pos_push(text, jsonb)                      to anon;
grant execute on function public.pos_pull_commands(text, int)               to anon;
grant execute on function public.pos_ack_command(text, uuid, text, text)    to anon;
grant execute on function public.pos_set_device_status(uuid, text)          to authenticated;

-- ---------------------------------------------------------------------
-- 8. Tiempo real para el panel (respeta RLS)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table
  public.pos_sales, public.pos_inventory_movements, public.pos_cash_cuts,
  public.pos_devices, public.pos_events, public.pos_commands;
