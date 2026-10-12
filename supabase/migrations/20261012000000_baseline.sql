-- Línea base: esquema que ya existía en Supabase antes de la Fase 1
-- (leído del proyecto qizccncdyhzxeltwzjni el 2026-10-12).
-- Ya está aplicado en producción; se guarda para que el repo refleje la historia.
-- Lo usan las versiones de la app hasta la v0.2.11 (upsert directo con la llave publishable).

create table if not exists public.pos_meta (
  license_key   text primary key,
  business_name text,
  app_version   text,
  last_sync     timestamptz
);

create table if not exists public.pos_products (
  license_key  text not null,
  sku          text not null,          -- en realidad es el identificador interno de la app
  name         text,
  category     text,
  presentation text,
  supplier     text,
  unit         text,
  cost         numeric,
  price        numeric,
  stock        numeric,
  min_stock    numeric,
  active       boolean,
  updated_at   timestamptz default now(),
  primary key (license_key, sku)
);

create table if not exists public.pos_sales (
  license_key       text not null,
  id                text not null,
  ts                timestamptz,
  total             numeric,
  subtotal          numeric,
  payment_method    text,
  payment_breakdown jsonb,
  cashier           text,
  profit            numeric,
  primary key (license_key, id)
);

create table if not exists public.pos_cash_cuts (
  license_key    text not null,
  id             text not null,
  cut_type       text,
  ts             timestamptz,
  period_start   timestamptz,
  period_end     timestamptz,
  total          numeric,
  opening_amount numeric,
  cashier        text,
  primary key (license_key, id)
);

alter table public.pos_meta      enable row level security;
alter table public.pos_products  enable row level security;
alter table public.pos_sales     enable row level security;
alter table public.pos_cash_cuts enable row level security;

-- Reglas abiertas (el problema de seguridad que corrige la Fase 1)
create policy "pos puede leer meta"        on public.pos_meta for select using (true);
create policy "pos puede insertar meta"    on public.pos_meta for insert with check (true);
create policy "pos puede actualizar meta"  on public.pos_meta for update using (true);
create policy "pos puede leer productos"       on public.pos_products for select using (true);
create policy "pos puede insertar productos"   on public.pos_products for insert with check (true);
create policy "pos puede actualizar productos" on public.pos_products for update using (true);
create policy "pos puede leer ventas"       on public.pos_sales for select using (true);
create policy "pos puede insertar ventas"   on public.pos_sales for insert with check (true);
create policy "pos puede actualizar ventas" on public.pos_sales for update using (true);
create policy "pos puede leer cortes"       on public.pos_cash_cuts for select using (true);
create policy "pos puede insertar cortes"   on public.pos_cash_cuts for insert with check (true);
create policy "pos puede actualizar cortes" on public.pos_cash_cuts for update using (true);
