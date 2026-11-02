-- =====================================================================
-- LEVEL UP · BILLETERA (Supabase, plan gratis)
--
-- Cómo instalarlo: Supabase → tu proyecto → SQL Editor → New query → pega TODO este archivo → Run.
-- Se puede volver a correr: crea lo que falta y reemplaza las funciones.
--
-- Qué guarda:
--   billeteras  saldo de cada cliente (nunca negativo).
--   movimientos cada carga, compra o devolución (el historial que ve el cliente). Una referencia de
--               Pago Móvil solo se acredita UNA vez (índice único) y cada pedido se cobra y se
--               devuelve una sola vez.
--   pedidos     recargas de Free Fire pagadas con saldo y su estado en Central One.
--
-- Quién escribe: SOLO Vercel (api/billetera.js y api/centralone-webhook.js) con la llave secreta,
-- y solo a través de las funciones billetera_*. El navegador nunca toca el saldo: las tablas tienen
-- RLS y el cliente con sesión solo puede LEER sus propias filas.
--
-- Devolver a mano un pedido "revisar" (Central One no confirmó si lo creó y no llegó aviso):
--   select billetera_actualizar_pedido('bil-xxxxxxxx-...', 'reembolsado', null, 'devuelto a mano', true);
-- (Si el pedido ya figura "entregado", hay que pasar 'forzar' en vez de 'reembolsado'.)
-- Ajuste manual de saldo (positivo suma, negativo resta):
--   select billetera_ajustar('<uuid del usuario>', 50.00, 'regalo de bienvenida');
-- =====================================================================

create table if not exists public.billeteras (
  usuario     uuid primary key references auth.users (id) on delete cascade,
  saldo       numeric(12, 2) not null default 0 check (saldo >= 0),
  actualizado timestamptz not null default now()
);

create table if not exists public.movimientos (
  id            bigint generated always as identity primary key,
  usuario       uuid not null references auth.users (id) on delete cascade,
  tipo          text not null check (tipo in ('carga', 'compra', 'reembolso', 'ajuste')),
  monto         numeric(12, 2) not null,            -- + entra, - sale
  saldo_despues numeric(12, 2) not null,
  referencia    text,                               -- carga: referencia COMPLETA del pago móvil
  id_pedido     text,                               -- compra / reembolso
  detalle       text,
  creado        timestamptz not null default now()
);
-- Un pago móvil se acredita una sola vez (aunque lo intenten dos cuentas a la vez)
create unique index if not exists movimientos_carga_unica on public.movimientos (referencia) where tipo = 'carga';
-- Un pedido se cobra una vez y se devuelve una vez
create unique index if not exists movimientos_pedido_unico on public.movimientos (id_pedido, tipo) where id_pedido is not null;
create index if not exists movimientos_por_usuario on public.movimientos (usuario, creado desc);

create table if not exists public.pedidos (
  id_pedido      text primary key,                  -- "bil-<uuid>" = Idempotency-Key en Central One
  usuario        uuid not null references auth.users (id) on delete cascade,
  jugador        text not null,
  nombre_jugador text,
  paquete        text not null,
  precio         numeric(12, 2) not null check (precio > 0),
  product_id     text not null,
  -- pagado: saldo descontado, aún sin respuesta de Central One · enviado: Central One lo aceptó ·
  -- entregado · reembolsado (saldo devuelto) · revisar: no se sabe si Central One lo creó (decide el aviso o tú)
  estado         text not null default 'pagado' check (estado in ('pagado', 'enviado', 'entregado', 'reembolsado', 'revisar')),
  orden_central  text,
  detalle        text,
  creado         timestamptz not null default now(),
  actualizado    timestamptz not null default now()
);
create index if not exists pedidos_por_usuario on public.pedidos (usuario, creado desc);

-- ---------------------------------------------------------------------
-- RLS: el cliente con sesión solo LEE lo suyo; nadie escribe desde el navegador
-- ---------------------------------------------------------------------
alter table public.billeteras  enable row level security;
alter table public.movimientos enable row level security;
alter table public.pedidos     enable row level security;

drop policy if exists "leer mi billetera" on public.billeteras;
create policy "leer mi billetera" on public.billeteras for select to authenticated using (usuario = (select auth.uid()));
drop policy if exists "leer mis movimientos" on public.movimientos;
create policy "leer mis movimientos" on public.movimientos for select to authenticated using (usuario = (select auth.uid()));
drop policy if exists "leer mis pedidos" on public.pedidos;
create policy "leer mis pedidos" on public.pedidos for select to authenticated using (usuario = (select auth.uid()));

revoke insert, update, delete on public.billeteras, public.movimientos, public.pedidos from anon, authenticated;

-- ---------------------------------------------------------------------
-- Acreditar una carga de Pago Móvil (ya verificada en la hoja de pagos por Vercel)
-- { nuevo, mismo_usuario, saldo }: nuevo=false si esa referencia ya se había acreditado.
-- ---------------------------------------------------------------------
create or replace function public.billetera_acreditar_carga(p_usuario uuid, p_referencia text, p_monto numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_dueno uuid;
  v_saldo numeric;
begin
  if p_monto is null or p_monto <= 0 or p_monto > 100000000 then raise exception 'monto_invalido'; end if;
  if coalesce(p_referencia, '') !~ '^[0-9]{5,30}$' then raise exception 'referencia_invalida'; end if;

  select usuario into v_dueno from movimientos where tipo = 'carga' and referencia = p_referencia;
  if found then
    select saldo into v_saldo from billeteras where usuario = p_usuario;
    return jsonb_build_object('nuevo', false, 'mismo_usuario', v_dueno = p_usuario, 'saldo', coalesce(v_saldo, 0));
  end if;

  begin
    insert into billeteras (usuario) values (p_usuario) on conflict (usuario) do nothing;
    update billeteras set saldo = saldo + round(p_monto, 2), actualizado = now()
      where usuario = p_usuario returning saldo into v_saldo;
    insert into movimientos (usuario, tipo, monto, saldo_despues, referencia, detalle)
      values (p_usuario, 'carga', round(p_monto, 2), v_saldo, p_referencia, 'Pago Móvil');
  exception when unique_violation then
    -- Otra petición acreditó la misma referencia en el mismo instante: aquí no se sumó nada
    select usuario into v_dueno from movimientos where tipo = 'carga' and referencia = p_referencia;
    select saldo into v_saldo from billeteras where usuario = p_usuario;
    return jsonb_build_object('nuevo', false, 'mismo_usuario', v_dueno = p_usuario, 'saldo', coalesce(v_saldo, 0));
  end;
  return jsonb_build_object('nuevo', true, 'mismo_usuario', true, 'saldo', v_saldo);
end $$;

-- ---------------------------------------------------------------------
-- Cobrar un pedido con saldo (antes de pedirlo a Central One)
-- { estado, saldo, repetido } o { error: 'saldo_insuficiente' | 'pedido_ajeno', saldo }
-- Repetir el mismo id_pedido no cobra otra vez: devuelve el pedido que ya existe.
-- ---------------------------------------------------------------------
create or replace function public.billetera_cobrar_pedido(
  p_usuario uuid, p_id_pedido text, p_precio numeric, p_jugador text, p_nombre text, p_paquete text, p_product_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos%rowtype;
  v_saldo numeric;
begin
  if p_precio is null or p_precio <= 0 then raise exception 'precio_invalido'; end if;
  if coalesce(p_id_pedido, '') !~ '^bil-[0-9a-f-]{36}$' then raise exception 'pedido_invalido'; end if;

  insert into billeteras (usuario) values (p_usuario) on conflict (usuario) do nothing;
  -- Candado de la billetera: dos compras a la vez del mismo cliente se hacen una detrás de otra
  select saldo into v_saldo from billeteras where usuario = p_usuario for update;

  select * into v_pedido from pedidos where id_pedido = p_id_pedido;
  if found then
    if v_pedido.usuario <> p_usuario then return jsonb_build_object('error', 'pedido_ajeno'); end if;
    return jsonb_build_object('repetido', true, 'estado', v_pedido.estado, 'saldo', v_saldo);
  end if;

  if v_saldo < p_precio then return jsonb_build_object('error', 'saldo_insuficiente', 'saldo', v_saldo); end if;

  update billeteras set saldo = saldo - round(p_precio, 2), actualizado = now()
    where usuario = p_usuario returning saldo into v_saldo;
  insert into pedidos (id_pedido, usuario, jugador, nombre_jugador, paquete, precio, product_id)
    values (p_id_pedido, p_usuario, p_jugador, nullif(p_nombre, ''), p_paquete, round(p_precio, 2), p_product_id);
  insert into movimientos (usuario, tipo, monto, saldo_despues, id_pedido, detalle)
    values (p_usuario, 'compra', -round(p_precio, 2), v_saldo, p_id_pedido, p_paquete || ' · ID ' || p_jugador);
  return jsonb_build_object('repetido', false, 'estado', 'pagado', 'saldo', v_saldo);
end $$;

-- ---------------------------------------------------------------------
-- Cambiar el estado de un pedido y, si p_reembolsar, devolver su precio al saldo (una sola vez).
-- Un pedido "reembolsado" ya no cambia. { cambiado, estado }
-- ---------------------------------------------------------------------
create or replace function public.billetera_actualizar_pedido(
  p_id_pedido text, p_estado text, p_orden text, p_detalle text, p_reembolsar boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos%rowtype;
  v_saldo numeric;
begin
  select * into v_pedido from pedidos where id_pedido = p_id_pedido for update;
  if not found then return jsonb_build_object('cambiado', false, 'estado', null); end if;
  if v_pedido.estado = 'reembolsado' then return jsonb_build_object('cambiado', false, 'estado', v_pedido.estado); end if;

  -- Central One puede avisar "failed" y después "delivered": un pedido ya entregado no se devuelve solo
  -- (lo decide el dueño: billetera_actualizar_pedido(..., true) desde el SQL Editor tras revisar)
  if p_reembolsar and v_pedido.estado = 'entregado' and p_estado <> 'forzar' then
    return jsonb_build_object('cambiado', false, 'estado', v_pedido.estado);
  end if;

  if p_reembolsar then
    update billeteras set saldo = saldo + v_pedido.precio, actualizado = now()
      where usuario = v_pedido.usuario returning saldo into v_saldo;
    insert into movimientos (usuario, tipo, monto, saldo_despues, id_pedido, detalle)
      values (v_pedido.usuario, 'reembolso', v_pedido.precio, v_saldo, p_id_pedido, left(coalesce(p_detalle, 'Recarga no realizada'), 200));
    update pedidos set estado = 'reembolsado', orden_central = coalesce(p_orden, orden_central),
      detalle = left(p_detalle, 300), actualizado = now() where id_pedido = p_id_pedido;
    return jsonb_build_object('cambiado', true, 'estado', 'reembolsado');
  end if;

  if p_estado not in ('enviado', 'entregado', 'revisar') then raise exception 'estado_invalido'; end if;
  -- Un aviso atrasado no devuelve a "enviado" un pedido ya entregado
  if v_pedido.estado = 'entregado' and p_estado <> 'entregado' then
    return jsonb_build_object('cambiado', false, 'estado', v_pedido.estado);
  end if;
  update pedidos set estado = p_estado, orden_central = coalesce(p_orden, orden_central),
    detalle = coalesce(left(p_detalle, 300), detalle), actualizado = now() where id_pedido = p_id_pedido;
  return jsonb_build_object('cambiado', true, 'estado', p_estado);
end $$;

-- ---------------------------------------------------------------------
-- Ajuste manual (solo desde el SQL Editor)
-- ---------------------------------------------------------------------
create or replace function public.billetera_ajustar(p_usuario uuid, p_monto numeric, p_detalle text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_saldo numeric;
begin
  insert into billeteras (usuario) values (p_usuario) on conflict (usuario) do nothing;
  update billeteras set saldo = saldo + round(p_monto, 2), actualizado = now()
    where usuario = p_usuario returning saldo into v_saldo;   -- falla si quedaría negativo
  insert into movimientos (usuario, tipo, monto, saldo_despues, detalle)
    values (p_usuario, 'ajuste', round(p_monto, 2), v_saldo, left(coalesce(p_detalle, 'Ajuste'), 200));
  return jsonb_build_object('saldo', v_saldo);
end $$;

-- Solo la llave secreta (service_role) puede ejecutar las funciones
revoke all on function public.billetera_acreditar_carga(uuid, text, numeric) from public, anon, authenticated;
revoke all on function public.billetera_cobrar_pedido(uuid, text, numeric, text, text, text, text) from public, anon, authenticated;
revoke all on function public.billetera_actualizar_pedido(text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.billetera_ajustar(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.billetera_acreditar_carga(uuid, text, numeric) to service_role;
grant execute on function public.billetera_cobrar_pedido(uuid, text, numeric, text, text, text, text) to service_role;
grant execute on function public.billetera_actualizar_pedido(text, text, text, text, boolean) to service_role;
grant execute on function public.billetera_ajustar(uuid, numeric, text) to service_role;
