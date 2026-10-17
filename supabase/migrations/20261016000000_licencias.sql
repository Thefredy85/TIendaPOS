-- =====================================================================
-- Licencias mensuales y versión mínima (v0.2.13). Solo agrega; no toca datos.
--
-- - Cada negocio tiene un día de corte (1-28), monto mensual y "vigente hasta"
--   (la próxima fecha de corte sin pagar).
-- - Aviso 3, 2 y 1 días antes. Desde el día de corte se bloquea SOLO si el
--   superadmin encendió el bloqueo (enforce) de ese negocio.
-- - Registrar un pago mueve "vigente hasta" a la siguiente fecha de corte,
--   contando desde max(vigente hasta, hoy).
-- - Un negocio sin fila en licenses nunca se bloquea ni ve avisos.
-- - Todo es visible y editable solo por el superadmin (owners y gestores no).
-- =====================================================================

create table public.licenses (
  business_id    uuid primary key references public.businesses (id) on delete cascade,
  cut_day        int  not null check (cut_day between 1 and 28),
  monthly_amount numeric not null default 0 check (monthly_amount >= 0),
  paid_until     date not null,
  enforce        boolean not null default false,
  -- secreto para el código de desbloqueo por teléfono (lo recibe la caja aprobada)
  unlock_secret  text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  notes          text,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id) on delete set null
);

create table public.license_payments (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  paid_at     timestamptz not null default now(),
  amount      numeric not null check (amount >= 0),
  method      text,
  covers_from date not null,
  covers_until date not null,
  recorded_by uuid references auth.users (id) on delete set null default auth.uid(),
  notes       text
);
create index license_payments_business_idx on public.license_payments (business_id, paid_at desc);

-- Una sola fila: la versión mínima permitida de la app.
create table public.app_policy (
  id                 boolean primary key default true check (id),
  min_version        text,
  min_version_set_at timestamptz
);
insert into public.app_policy (id) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------
-- Permisos: solo el superadmin lee; nadie escribe directo (solo por RPC)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['licenses', 'license_payments', 'app_policy'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy "solo superadmin" on public.%I for select to authenticated using (private.is_superadmin())', t);
  end loop;
end $$;
-- el panel no necesita ver el secreto del código de desbloqueo
revoke select on public.licenses from authenticated;
grant select (business_id, cut_day, monthly_amount, paid_until, enforce, notes, updated_at, updated_by)
  on public.licenses to authenticated;

-- ---------------------------------------------------------------------
-- Fechas de corte
-- ---------------------------------------------------------------------
-- Primera fecha con ese día de corte que sea estrictamente posterior a p_after.
create or replace function private.next_cut(p_after date, p_cut_day int) returns date
language sql immutable set search_path = '' as $$
  select case
    when make_date(extract(year from p_after)::int, extract(month from p_after)::int, p_cut_day) > p_after
      then make_date(extract(year from p_after)::int, extract(month from p_after)::int, p_cut_day)
    else (make_date(extract(year from p_after)::int, extract(month from p_after)::int, p_cut_day) + interval '1 month')::date
  end
$$;

create or replace function private.require_superadmin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then
    raise exception 'Solo el administrador del sistema puede manejar licencias' using errcode = '42501';
  end if;
end $$;

-- Definir o cambiar la licencia de un negocio (día de corte, monto, vigente hasta).
create or replace function public.lic_upsert(
  p_business_id uuid, p_cut_day int, p_monthly_amount numeric, p_paid_until date, p_notes text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r public.licenses;
begin
  perform private.require_superadmin();
  if p_cut_day is null or p_cut_day not between 1 and 28 then
    raise exception 'El día de corte debe ser del 1 al 28' using errcode = '22023';
  end if;
  if p_paid_until is null then
    raise exception 'Falta la fecha de vigencia' using errcode = '22023';
  end if;
  insert into public.licenses as l (business_id, cut_day, monthly_amount, paid_until, notes, updated_by)
  values (p_business_id, p_cut_day, coalesce(p_monthly_amount, 0), p_paid_until, p_notes, auth.uid())
  on conflict (business_id) do update set
    cut_day = excluded.cut_day, monthly_amount = excluded.monthly_amount,
    paid_until = excluded.paid_until, notes = excluded.notes,
    updated_at = now(), updated_by = auth.uid()
  returning * into r;
  return jsonb_build_object('business_id', r.business_id, 'paid_until', r.paid_until, 'enforce', r.enforce);
end $$;

-- Encender o apagar el bloqueo de un negocio.
create or replace function public.lic_set_enforce(p_business_id uuid, p_enforce boolean) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  update public.licenses set enforce = coalesce(p_enforce, false), updated_at = now(), updated_by = auth.uid()
  where business_id = p_business_id;
  if not found then
    raise exception 'Ese negocio todavía no tiene licencia definida' using errcode = 'P0002';
  end if;
  return coalesce(p_enforce, false);
end $$;

-- Registrar un pago y liberar: "vigente hasta" pasa a la siguiente fecha de corte.
create or replace function public.lic_register_payment(
  p_business_id uuid, p_amount numeric, p_method text default null, p_notes text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare l public.licenses; v_from date; v_until date;
begin
  perform private.require_superadmin();
  select * into l from public.licenses where business_id = p_business_id for update;
  if not found then
    raise exception 'Ese negocio todavía no tiene licencia definida' using errcode = 'P0002';
  end if;
  v_from := greatest(l.paid_until, (now() at time zone 'America/Mexico_City')::date);
  v_until := private.next_cut(v_from, l.cut_day);
  insert into public.license_payments (business_id, amount, method, covers_from, covers_until, notes)
  values (p_business_id, coalesce(p_amount, 0), left(p_method, 40), v_from, v_until, left(p_notes, 500));
  update public.licenses set paid_until = v_until, updated_at = now(), updated_by = auth.uid()
  where business_id = p_business_id;
  return jsonb_build_object('paid_until', v_until, 'covers_from', v_from);
end $$;

-- Versión mínima de la app (null = sin mínimo). Las cajas por debajo tienen 7 días de aviso.
create or replace function public.lic_set_min_version(p_version text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_version, '')), '');
begin
  perform private.require_superadmin();
  if v is not null and v !~ '^\d+\.\d+\.\d+$' then
    raise exception 'La versión debe tener el formato 0.2.13' using errcode = '22023';
  end if;
  update public.app_policy set min_version = v, min_version_set_at = case when v is null then null else now() end
  where id;
  return jsonb_build_object('min_version', v);
end $$;

-- Código de desbloqueo por teléfono: 8 caracteres, válido el día en que se genera
-- (la caja lo acepta también el día anterior o siguiente por diferencias de zona horaria)
-- y da 7 días más de uso. Lo calcula igual la caja, con el secreto que recibió.
create or replace function private.unlock_code(p_license_key text, p_secret text, p_day date) returns text
language sql immutable set search_path = '' as $$
  select upper(substr(encode(extensions.hmac(p_license_key || '|' || to_char(p_day, 'YYYY-MM-DD'), p_secret, 'sha256'), 'hex'), 1, 8))
$$;

create or replace function public.lic_unlock_code(p_business_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_key text; v_secret text; v_day date := (now() at time zone 'America/Mexico_City')::date;
begin
  perform private.require_superadmin();
  select b.license_key, l.unlock_secret into v_key, v_secret
  from public.businesses b join public.licenses l on l.business_id = b.id where b.id = p_business_id;
  if v_key is null then
    raise exception 'Ese negocio todavía no tiene licencia definida' using errcode = 'P0002';
  end if;
  return jsonb_build_object('code', private.unlock_code(v_key, v_secret, v_day), 'day', v_day, 'days', 7);
end $$;

-- ---------------------------------------------------------------------
-- Lo que recibe la caja (solo cajas aprobadas). La Edge Function "licencia"
-- lo firma; la app solo confía en la versión firmada.
-- ---------------------------------------------------------------------
create or replace function public.pos_license(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.pos_devices; b public.businesses; l public.licenses; p public.app_policy;
begin
  d := private.approved_device(p_token);
  select * into b from public.businesses where id = d.business_id;
  select * into l from public.licenses where business_id = d.business_id;
  select * into p from public.app_policy where id;
  return jsonb_build_object(
    'business_id', b.id,
    'license_key', b.license_key,
    'device_id', d.id,
    'has_license', l.business_id is not null,
    'cut_day', l.cut_day,
    'monthly_amount', l.monthly_amount,
    'paid_until', l.paid_until,
    'enforce', coalesce(l.enforce, false),
    'unlock_secret', l.unlock_secret,
    'min_version', p.min_version,
    'min_version_deadline', case when p.min_version is null then null else p.min_version_set_at + interval '7 days' end,
    'server_time', now()
  );
end $$;

-- Permisos de ejecución
revoke all on function private.next_cut(date, int), private.require_superadmin(), private.unlock_code(text, text, date)
  from public, anon, authenticated;
revoke all on function public.lic_upsert(uuid, int, numeric, date, text)        from public, anon, authenticated;
revoke all on function public.lic_set_enforce(uuid, boolean)                    from public, anon, authenticated;
revoke all on function public.lic_register_payment(uuid, numeric, text, text)   from public, anon, authenticated;
revoke all on function public.lic_set_min_version(text)                         from public, anon, authenticated;
revoke all on function public.lic_unlock_code(uuid)                             from public, anon, authenticated;
revoke all on function public.pos_license(text)                                 from public, anon, authenticated;
grant execute on function public.lic_upsert(uuid, int, numeric, date, text)      to authenticated;
grant execute on function public.lic_set_enforce(uuid, boolean)                  to authenticated;
grant execute on function public.lic_register_payment(uuid, numeric, text, text) to authenticated;
grant execute on function public.lic_set_min_version(text)                       to authenticated;
grant execute on function public.lic_unlock_code(uuid)                           to authenticated;
grant execute on function public.pos_license(text)                               to anon;
