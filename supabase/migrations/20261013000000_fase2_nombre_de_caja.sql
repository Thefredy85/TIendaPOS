-- =====================================================================
-- Fase 2: el latido también actualiza el nombre de la caja.
-- Al registrarse, la caja usa el nombre de Windows del equipo; cuando la tienda
-- tiene su nombre asignado en el POS, la caja pasa a llamarse así.
-- Solo para cajas aprobadas (una caja pendiente no puede renombrarse).
-- =====================================================================

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
    -- la caja se nombra con el equipo y luego con el nombre asignado de la tienda
    name                = case when d.status = 'aprobado'
                               then coalesce(private.txt(i -> 'device_name', 80), name) else name end,
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
