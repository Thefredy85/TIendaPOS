-- =====================================================================
-- v0.2.17: usuarios de la caja y permisos por rol desde el panel.
-- Solo agrega: una tabla para el PIN que viaja a la caja (pos_command_secrets),
-- un disparador que lo borra en cuanto la orden deja de estar pendiente, la
-- entrega del PIN en pos_pull_commands (lo demás queda igual) y dos funciones
-- del panel. No toca productos, existencias ni ventas.
--
-- En la caja el "usuario" es el mismo PIN con el que se entra. Desde la
-- v0.2.17 la caja sube a pos_users un identificador interno ("U-…") en lugar
-- del PIN. El PIN nunca se guarda en pos_commands, que puede leer el gestor.
-- =====================================================================

create table if not exists public.pos_command_secrets (
  command_id  uuid primary key references public.pos_commands (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  secret      text not null,
  created_at  timestamptz not null default now()
);
-- Nadie la lee directamente: solo las funciones de abajo (security definer).
alter table public.pos_command_secrets enable row level security;
revoke all on public.pos_command_secrets from public, anon, authenticated;

-- En cuanto la orden se aplica, se rechaza o se cancela, el PIN se borra.
create or replace function private.drop_command_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'pendiente' then
    delete from public.pos_command_secrets where command_id = new.id;
  end if;
  return new;
end $$;
revoke all on function private.drop_command_secret() from public, anon, authenticated;

drop trigger if exists borrar_secreto on public.pos_commands;
create trigger borrar_secreto after update of status on public.pos_commands
  for each row execute function private.drop_command_secret();

-- La caja baja sus órdenes; si la orden trae PIN, va dentro de su payload.
create or replace function public.pos_pull_commands(p_token text, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.pos_devices;
begin
  d := private.approved_device(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'seq', c.seq, 'type', c.type,
                                        'payload', c.payload || case when s.secret is null then '{}'::jsonb
                                                                     else jsonb_build_object('pin', s.secret) end,
                                        'created_at', c.created_at) order by c.seq)
    from (select * from public.pos_commands
           where business_id = d.business_id and status = 'pendiente'
             and (target_device_id is null or target_device_id = d.id)
           order by seq
           limit greatest(1, least(coalesce(p_limit, 50), 200))) c
    left join public.pos_command_secrets s on s.command_id = c.id
  ), '[]'::jsonb);
end $$;

-- La caja ya sube usuarios con identificador interno (v0.2.17 o más nueva)
create or replace function private.caja_con_usuarios_seguros(p_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.pos_users
                  where business_id = p_business_id and username like 'U-%' and deleted_at is null)
$$;
revoke all on function private.caja_con_usuarios_seguros(uuid) from public, anon, authenticated;

-- Alta (p_uid vacío) o cambio de un usuario de la caja. p_old es lo que vio el panel:
-- si en la caja ya cambió, la caja rechaza. p_pin vacío = no cambia el PIN.
create or replace function public.panel_save_pos_user(
  p_business_id uuid, p_uid text, p_old jsonb, p_display_name text, p_role text,
  p_active boolean, p_pin text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_name text := btrim(coalesce(p_display_name, '')); v_pin text := btrim(coalesce(p_pin, ''));
        v_uid text := btrim(coalesce(p_uid, '')); v_payload jsonb;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if not private.caja_con_usuarios_seguros(p_business_id) then
    raise exception 'La caja todavía no tiene la versión 0.2.17: actualízala para manejar usuarios desde el panel' using errcode = '55000';
  end if;
  if p_role not in ('admin', 'encargado', 'cajero') then
    raise exception 'Rol no reconocido' using errcode = '22023';
  end if;
  if v_name = '' or length(v_name) > 80 then
    raise exception 'Escribe el nombre del usuario' using errcode = '22023';
  end if;
  if v_pin <> '' and v_pin !~ '^[0-9]{4,12}$' then
    raise exception 'El PIN debe tener de 4 a 12 números' using errcode = '22023';
  end if;
  if v_pin <> '' and v_pin = v_name then
    raise exception 'El nombre no puede ser igual al PIN' using errcode = '22023';
  end if;
  if v_uid = '' and v_pin = '' then
    raise exception 'Escribe el PIN del usuario nuevo' using errcode = '22023';
  end if;
  if v_uid <> '' then
    if not exists (select 1 from public.pos_users
                    where business_id = p_business_id and username = v_uid and deleted_at is null) then
      raise exception 'Ese usuario ya no existe' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.pos_commands
                where business_id = p_business_id and status = 'pendiente' and type = 'user_save'
                  and payload ->> 'uid' = v_uid) then
      raise exception 'Este usuario ya tiene un cambio esperando a la caja' using errcode = '23505';
    end if;
  end if;
  v_payload := jsonb_build_object('display_name', v_name, 'role', p_role, 'has_pin', v_pin <> '',
                                  'by', private.current_email());
  if v_uid <> '' then
    v_payload := v_payload || jsonb_build_object('uid', v_uid, 'old', coalesce(p_old, '{}'::jsonb));
  end if;
  if p_active is not null then
    v_payload := v_payload || jsonb_build_object('active', p_active);
  end if;
  insert into public.pos_commands (business_id, type, payload, created_by)
  values (p_business_id, 'user_save', v_payload, auth.uid())
  returning id into v_id;
  if v_pin <> '' then
    insert into public.pos_command_secrets (command_id, business_id, secret) values (v_id, p_business_id, v_pin);
  end if;
  return v_id;
end $$;

-- Permisos por rol (encargado y cajero; el admin siempre tiene todo)
create or replace function public.panel_save_role_permissions(p_business_id uuid, p_before jsonb, p_after jsonb)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; r text; k text;
begin
  if not private.is_owner(p_business_id) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if not private.caja_con_usuarios_seguros(p_business_id) then
    raise exception 'La caja todavía no tiene la versión 0.2.17: actualízala para cambiar permisos desde el panel' using errcode = '55000';
  end if;
  if jsonb_typeof(p_after) <> 'object' or p_after = '{}'::jsonb then
    raise exception 'No hay permisos que cambiar' using errcode = '22023';
  end if;
  for r in select jsonb_object_keys(p_after) loop
    if r not in ('encargado', 'cajero') or jsonb_typeof(p_after -> r) <> 'object' then
      raise exception 'Rol no permitido: %', r using errcode = '22023';
    end if;
    for k in select jsonb_object_keys(p_after -> r) loop
      if k not in ('settings', 'catalogs', 'products', 'movements', 'counts', 'cashcut')
         or jsonb_typeof(p_after -> r -> k) <> 'boolean' then
        raise exception 'Permiso no reconocido: %', k using errcode = '22023';
      end if;
    end loop;
  end loop;
  if exists (select 1 from public.pos_commands
              where business_id = p_business_id and status = 'pendiente' and type = 'role_permissions') then
    raise exception 'Ya hay un cambio de permisos esperando a la caja' using errcode = '23505';
  end if;
  insert into public.pos_commands (business_id, type, payload, created_by)
  values (p_business_id, 'role_permissions',
          jsonb_build_object('before', coalesce(p_before, '{}'::jsonb), 'after', p_after, 'by', private.current_email()),
          auth.uid())
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.panel_save_pos_user(uuid, text, jsonb, text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.panel_save_role_permissions(uuid, jsonb, jsonb)                  from public, anon, authenticated;
grant execute on function public.panel_save_pos_user(uuid, text, jsonb, text, text, boolean, text) to authenticated;
grant execute on function public.panel_save_role_permissions(uuid, jsonb, jsonb)                  to authenticated;
