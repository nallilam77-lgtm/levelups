-- =====================================================================
-- LEVEL UP · MERCADO DE CUENTAS DE FREE FIRE CON INTERMEDIARIO (Supabase, mismo proyecto que la billetera)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run.
-- Se puede volver a correr: crea lo que falta y reemplaza funciones y políticas.
-- Después, hazte administrador (una sola vez, con el correo con el que entras a la web):
--   insert into public.mercado_admins (usuario) select id from auth.users where email = 'tu-correo@gmail.com';
--
-- Las cuentas de usuario son las mismas de la billetera (Supabase Auth).
--
-- FLUJO DE UN TRATO (reglas en public/reglas-cuentas.html):
--   pendiente_pago → el comprador tocó "Comprar"; la cuenta queda "reservada". Tiene `horas_pago` para
--                    informar su pago (método + referencia); si no, se cancela sola y la cuenta vuelve al mercado.
--   pagada         → un admin confirmó que el dinero llegó (queda RETENIDO por Level Up).
--   entregada      → el vendedor entregó los datos en el chat del trato. El comprador tiene `horas_revision`
--                    para "Finalizar" o "Tengo un problema" (con video); si no hace nada, se cierra solo.
--   en_reclamo     → un admin decide: a favor del vendedor (se cierra) o del comprador (se cancela y se reembolsa).
--   cerrada        → el precio COMPLETO pasa al saldo del vendedor y la cuenta queda "vendida".
--   cancelada      → no hubo venta (si el comprador ya había pagado, el reembolso lo haces tú).
--
-- COMISIÓN: comprar y vender no cuesta nada. Solo al RETIRAR se descuenta `comision_retiro` % (4).
-- La Garantía Extendida (`garantia_usd`) la paga el comprador y es para Level Up, no para el vendedor.
--
-- SEGURIDAD: el navegador solo LEE (RLS). Todo cambio de estado, saldo o mensaje pasa por las funciones
-- de abajo (security definer), que comprueban quién llama y en qué estado está el trato.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Administradores y configuración
-- ---------------------------------------------------------------------
create table if not exists public.mercado_admins (
  usuario uuid primary key references auth.users (id) on delete cascade
);

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from mercado_admins where usuario = auth.uid());
$$;

create table if not exists public.mercado_config (
  clave text primary key,
  valor text not null
);
insert into public.mercado_config (clave, valor) values
  ('comision_retiro', '4'),        -- % que se descuenta al retirar
  ('retiro_minimo', '5'),          -- USD
  ('garantia_usd', '1'),           -- Garantía Extendida
  ('horas_pago', '2'),             -- para informar el pago tras tocar "Comprar"
  ('horas_revision', '24'),        -- para finalizar o reclamar tras la entrega
  ('tasa_bs', ''),                 -- Bs por 1 USD (vacío = no se muestra el monto en Bs)
  ('instrucciones_pago', 'Paga el total por Pago Móvil (al cambio del día) o por Binance y escribe abajo la referencia. Te confirmamos en el chat del trato.')
on conflict (clave) do nothing;

create or replace function public._config_num(p_clave text, p_defecto numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select valor into v from mercado_config where clave = p_clave;
  return coalesce(nullif(trim(v), '')::numeric, p_defecto);
exception when others then
  return p_defecto;
end $$;

-- ---------------------------------------------------------------------
-- Publicaciones
-- ---------------------------------------------------------------------
create table if not exists public.cuentas_venta (
  id              bigint generated always as identity primary key,
  vendedor        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  titulo          text not null check (char_length(titulo) between 8 and 80),
  nivel           smallint not null check (nivel between 1 and 100),
  region          text not null check (region in ('LATAM', 'Brasil', 'EE. UU.', 'Europa', 'Asia', 'Otra')),
  vinculacion     text not null check (vinculacion in ('Facebook', 'Google', 'VK', 'X (Twitter)', 'Apple', 'Huawei', 'Otra')),
  precio_usd      numeric(8, 2) not null check (precio_usd between 1 and 5000),
  destacados      text not null default '' check (char_length(destacados) <= 300),
  descripcion     text not null default '' check (char_length(descripcion) <= 1500),
  fotos           text[] not null default '{}' check (cardinality(fotos) between 1 and 6),
  estado          text not null default 'revision',
  motivo_rechazo  text,
  creado          timestamptz not null default now(),
  actualizado     timestamptz not null default now()
);
alter table public.cuentas_venta drop constraint if exists cuentas_venta_estado_check;
alter table public.cuentas_venta add constraint cuentas_venta_estado_check
  check (estado in ('revision', 'publicada', 'pausada', 'reservada', 'vendida', 'rechazada'));
create index if not exists cuentas_venta_publicadas on public.cuentas_venta (creado desc) where estado = 'publicada';
create index if not exists cuentas_venta_por_vendedor on public.cuentas_venta (vendedor, creado desc);

create table if not exists public.cuentas_contacto (
  cuenta    bigint primary key references public.cuentas_venta (id) on delete cascade,
  vendedor  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  whatsapp  text not null check (whatsapp ~ '^\+58(412|414|416|422|424|426)[0-9]{7}$')
);

-- Reglas que el navegador no puede saltarse. Las funciones del mercado (mercado.sistema = '1'),
-- los admins y el panel de Supabase sí pueden cambiar cualquier cosa.
create or replace function public.cuentas_venta_reglas()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  libre  boolean := coalesce(auth.role(), '') <> 'authenticated'
                    or coalesce(current_setting('mercado.sistema', true), '') = '1'
                    or public.es_admin();
  activas int;
begin
  if libre then
    new.actualizado := now();
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.vendedor := auth.uid();
    new.estado := 'revision';
    new.motivo_rechazo := null;
    new.creado := now();
    select count(*) into activas from cuentas_venta
      where vendedor = auth.uid() and estado in ('revision', 'publicada', 'pausada', 'reservada');
    if activas >= 10 then
      raise exception 'LIMITE_PUBLICACIONES';
    end if;
  else
    if new.vendedor <> old.vendedor or new.creado <> old.creado then
      raise exception 'NO_PERMITIDO';
    end if;
    if old.estado in ('reservada', 'vendida', 'rechazada') then
      raise exception 'NO_EDITABLE';
    end if;
    new.motivo_rechazo := old.motivo_rechazo;
    -- El vendedor solo puede pausar y reanudar una cuenta ya aprobada
    if new.estado <> old.estado and not (
         (old.estado = 'publicada' and new.estado = 'pausada')
      or (old.estado = 'pausada' and new.estado = 'publicada')
    ) then
      raise exception 'NO_PERMITIDO';
    end if;
    -- Cambiar el texto o las fotos de una cuenta aprobada la manda otra vez a revisión (el precio no)
    if old.estado in ('publicada', 'pausada') and (
         new.titulo <> old.titulo or new.nivel <> old.nivel or new.region <> old.region
      or new.vinculacion <> old.vinculacion or new.destacados <> old.destacados
      or new.descripcion <> old.descripcion or new.fotos <> old.fotos
    ) then
      new.estado := 'revision';
    end if;
  end if;

  if exists (select 1 from unnest(new.fotos) f where f !~ ('^' || new.vendedor::text || '/[A-Za-z0-9_-]{8,64}\.(webp|jpg|jpeg|png)$')) then
    raise exception 'FOTO_INVALIDA';
  end if;

  new.actualizado := now();
  return new;
end $$;

drop trigger if exists cuentas_venta_reglas on public.cuentas_venta;
create trigger cuentas_venta_reglas before insert or update on public.cuentas_venta
  for each row execute function public.cuentas_venta_reglas();

-- ---------------------------------------------------------------------
-- Tratos, chat, saldo de vendedores y retiros
-- ---------------------------------------------------------------------
create table if not exists public.ventas_cuentas (
  id                 bigint generated always as identity primary key,
  cuenta             bigint references public.cuentas_venta (id) on delete set null,
  comprador          uuid not null references auth.users (id) on delete restrict,
  vendedor           uuid not null references auth.users (id) on delete restrict,
  titulo             text not null,
  precio_usd         numeric(8, 2) not null check (precio_usd > 0),   -- lo que recibe el vendedor
  garantia           boolean not null default false,
  total_usd          numeric(8, 2) not null check (total_usd > 0),    -- lo que paga el comprador
  estado             text not null default 'pendiente_pago'
                     check (estado in ('pendiente_pago', 'pagada', 'entregada', 'en_reclamo', 'cerrada', 'cancelada')),
  metodo_pago        text,
  referencia_pago    text,
  pago_informado_en  timestamptz,
  pagada_en          timestamptz,
  entregada_en       timestamptz,
  cerrada_en         timestamptz,
  reclamo_motivo     text,
  reclamo_video      text,
  resolucion         text,
  creado             timestamptz not null default now(),
  actualizado        timestamptz not null default now()
);
-- Una cuenta solo puede estar en UN trato abierto
create unique index if not exists ventas_cuenta_abierta on public.ventas_cuentas (cuenta)
  where estado not in ('cerrada', 'cancelada');
create index if not exists ventas_por_comprador on public.ventas_cuentas (comprador, creado desc);
create index if not exists ventas_por_vendedor on public.ventas_cuentas (vendedor, creado desc);
create index if not exists ventas_abiertas on public.ventas_cuentas (estado) where estado not in ('cerrada', 'cancelada');

create table if not exists public.mensajes_venta (
  id      bigint generated always as identity primary key,
  venta   bigint not null references public.ventas_cuentas (id) on delete cascade,
  autor   uuid references auth.users (id) on delete set null,
  rol     text not null check (rol in ('comprador', 'vendedor', 'admin', 'sistema')),
  texto   text not null check (char_length(texto) between 1 and 1000),
  creado  timestamptz not null default now()
);
create index if not exists mensajes_por_venta on public.mensajes_venta (venta, id);

create table if not exists public.saldos_vendedor (
  vendedor    uuid primary key references auth.users (id) on delete cascade,
  disponible  numeric(12, 2) not null default 0 check (disponible >= 0),
  ventas      int not null default 0,       -- ventas cerradas (reputación)
  actualizado timestamptz not null default now()
);

create table if not exists public.retiros (
  id            bigint generated always as identity primary key,
  vendedor      uuid not null references auth.users (id) on delete restrict,
  monto_usd     numeric(12, 2) not null check (monto_usd > 0),
  comision_usd  numeric(12, 2) not null check (comision_usd >= 0),
  neto_usd      numeric(12, 2) not null check (neto_usd > 0),
  metodo        text not null check (metodo in ('Pago Móvil', 'Binance', 'Zinli', 'Otro')),
  datos         text not null check (char_length(datos) between 5 and 200),
  estado        text not null default 'pendiente' check (estado in ('pendiente', 'pagado', 'rechazado')),
  referencia    text,     -- del pago que hiciste tú
  motivo        text,     -- si lo rechazaste
  creado        timestamptz not null default now(),
  resuelto      timestamptz
);
create index if not exists retiros_por_vendedor on public.retiros (vendedor, creado desc);
create index if not exists retiros_pendientes on public.retiros (creado) where estado = 'pendiente';

create table if not exists public.movimientos_vendedor (
  id             bigint generated always as identity primary key,
  vendedor       uuid not null references auth.users (id) on delete cascade,
  tipo           text not null check (tipo in ('venta', 'retiro', 'retiro_devuelto', 'ajuste')),
  monto          numeric(12, 2) not null,      -- + entra, - sale
  saldo_despues  numeric(12, 2) not null,
  venta          bigint references public.ventas_cuentas (id) on delete set null,
  retiro         bigint references public.retiros (id) on delete set null,
  detalle        text,
  creado         timestamptz not null default now()
);
-- Una venta se acredita una sola vez
create unique index if not exists movimientos_vendedor_venta_unica on public.movimientos_vendedor (venta) where tipo = 'venta';
create index if not exists movimientos_vendedor_por_usuario on public.movimientos_vendedor (vendedor, creado desc);

-- ---------------------------------------------------------------------
-- Funciones internas (no se pueden llamar desde el navegador)
-- ---------------------------------------------------------------------
create or replace function public._mensaje_sistema(p_venta bigint, p_texto text)
returns void language sql security definer set search_path = public as $$
  insert into mensajes_venta (venta, autor, rol, texto) values (p_venta, null, 'sistema', left(p_texto, 1000));
$$;

create or replace function public._mover_saldo(p_vendedor uuid, p_monto numeric, p_tipo text, p_venta bigint, p_retiro bigint, p_detalle text)
returns numeric language plpgsql security definer set search_path = public as $$
declare nuevo numeric;
begin
  insert into saldos_vendedor (vendedor) values (p_vendedor) on conflict (vendedor) do nothing;
  update saldos_vendedor
     set disponible = disponible + p_monto,
         ventas = ventas + case when p_tipo = 'venta' then 1 else 0 end,
         actualizado = now()
   where vendedor = p_vendedor
   returning disponible into nuevo;
  insert into movimientos_vendedor (vendedor, tipo, monto, saldo_despues, venta, retiro, detalle)
  values (p_vendedor, p_tipo, p_monto, nuevo, p_venta, p_retiro, p_detalle);
  return nuevo;
end $$;

create or replace function public._venta_cerrar(p_venta bigint, p_detalle text)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.estado not in ('pagada', 'entregada', 'en_reclamo') then
    raise exception 'ESTADO_INVALIDO';
  end if;
  perform set_config('mercado.sistema', '1', true);
  update ventas_cuentas set estado = 'cerrada', cerrada_en = now(), actualizado = now(),
         resolucion = coalesce(resolucion, p_detalle) where id = p_venta;
  update cuentas_venta set estado = 'vendida' where id = v.cuenta;
  perform _mover_saldo(v.vendedor, v.precio_usd, 'venta', v.id, null, format('Venta T-%s · %s', v.id, v.titulo));
  perform _mensaje_sistema(p_venta, format('Trato cerrado. %s USD pasaron al saldo del vendedor. %s', v.precio_usd, coalesce(p_detalle, '')));
end $$;

create or replace function public._venta_cancelar(p_venta bigint, p_motivo text, p_estado_cuenta text)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.estado in ('cerrada', 'cancelada') then
    raise exception 'ESTADO_INVALIDO';
  end if;
  perform set_config('mercado.sistema', '1', true);
  update ventas_cuentas set estado = 'cancelada', cerrada_en = now(), actualizado = now(), resolucion = p_motivo where id = p_venta;
  update cuentas_venta
     set estado = p_estado_cuenta,
         motivo_rechazo = case when p_estado_cuenta = 'rechazada' then p_motivo else motivo_rechazo end
   where id = v.cuenta and estado = 'reservada';
  perform _mensaje_sistema(p_venta, 'Trato cancelado. ' || p_motivo);
end $$;

-- Rol de quien llama dentro de un trato (o null si no participa)
create or replace function public._rol_en_venta(v ventas_cuentas)
returns text language sql stable security definer set search_path = public as $$
  select case when v.comprador = auth.uid() then 'comprador'
              when v.vendedor = auth.uid() then 'vendedor'
              when public.es_admin() then 'admin' end;
$$;

-- ---------------------------------------------------------------------
-- Mantenimiento: vence tratos sin pago y cierra los entregados sin reclamo.
-- Corre solo cada 10 min si pg_cron está activo (abajo); además lo llaman las funciones y la página.
-- ---------------------------------------------------------------------
create or replace function public.mercado_mantenimiento()
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from ventas_cuentas
            where estado = 'pendiente_pago' and pago_informado_en is null
              and creado < now() - make_interval(hours => _config_num('horas_pago', 2)::int)
            for update skip locked loop
    perform _venta_cancelar(r.id, 'No se informó el pago a tiempo.', 'publicada');
  end loop;
  for r in select id from ventas_cuentas
            where estado = 'entregada'
              and entregada_en < now() - make_interval(hours => _config_num('horas_revision', 24)::int)
            for update skip locked loop
    perform _venta_cerrar(r.id, 'Cierre automático: pasó el tiempo de revisión sin reclamo.');
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Funciones del COMPRADOR
-- ---------------------------------------------------------------------
create or replace function public.venta_crear(p_cuenta bigint, p_garantia boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare c cuentas_venta; v_id bigint; pendientes int; extra numeric;
begin
  if auth.uid() is null then raise exception 'SIN_SESION'; end if;
  perform mercado_mantenimiento();
  select * into c from cuentas_venta where id = p_cuenta for update;
  if not found or c.estado <> 'publicada' then raise exception 'NO_DISPONIBLE'; end if;
  if c.vendedor = auth.uid() then raise exception 'ES_TUYA'; end if;
  select count(*) into pendientes from ventas_cuentas where comprador = auth.uid() and estado = 'pendiente_pago';
  if pendientes >= 2 then raise exception 'DEMASIADAS_PENDIENTES'; end if;

  extra := case when p_garantia then _config_num('garantia_usd', 1) else 0 end;
  perform set_config('mercado.sistema', '1', true);
  update cuentas_venta set estado = 'reservada' where id = c.id;
  insert into ventas_cuentas (cuenta, comprador, vendedor, titulo, precio_usd, garantia, total_usd)
  values (c.id, auth.uid(), c.vendedor, c.titulo, c.precio_usd, coalesce(p_garantia, false), c.precio_usd + extra)
  returning id into v_id;
  perform _mensaje_sistema(v_id, format(
    'Trato T-%s abierto por la cuenta FF-%s. Total a pagar: %s USD%s. El comprador tiene %s h para pagar e informar la referencia. Nadie debe pagar ni entregar datos fuera de este chat.',
    v_id, c.id, c.precio_usd + extra, case when p_garantia then ' (incluye Garantía Extendida)' else '' end, _config_num('horas_pago', 2)));
  return v_id;
end $$;

create or replace function public.venta_informar_pago(p_venta bigint, p_metodo text, p_referencia text)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.comprador is distinct from auth.uid() then raise exception 'NO_PERMITIDO'; end if;
  if v.estado <> 'pendiente_pago' then raise exception 'ESTADO_INVALIDO'; end if;
  if p_metodo not in ('Pago Móvil', 'Binance', 'Zinli', 'Otro') then raise exception 'DATO_INVALIDO'; end if;
  if coalesce(p_referencia, '') !~ '^[A-Za-z0-9-]{4,40}$' then raise exception 'DATO_INVALIDO'; end if;
  update ventas_cuentas set metodo_pago = p_metodo, referencia_pago = p_referencia, pago_informado_en = now(), actualizado = now()
   where id = p_venta;
  perform _mensaje_sistema(p_venta, format('El comprador informó su pago por %s (referencia %s). Level Up lo está verificando.', p_metodo, p_referencia));
end $$;

create or replace function public.venta_finalizar(p_venta bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.comprador is distinct from auth.uid() then raise exception 'NO_PERMITIDO'; end if;
  if v.estado <> 'entregada' then raise exception 'ESTADO_INVALIDO'; end if;
  perform _venta_cerrar(p_venta, 'El comprador confirmó que recibió la cuenta.');
end $$;

create or replace function public.venta_reclamar(p_venta bigint, p_motivo text, p_video text)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.comprador is distinct from auth.uid() then raise exception 'NO_PERMITIDO'; end if;
  if v.estado <> 'entregada' then raise exception 'ESTADO_INVALIDO'; end if;
  if v.entregada_en < now() - make_interval(hours => _config_num('horas_revision', 24)::int) then raise exception 'FUERA_DE_PLAZO'; end if;
  if char_length(trim(coalesce(p_motivo, ''))) not between 10 and 600 then raise exception 'DATO_INVALIDO'; end if;
  -- (Postgres no acepta repeticiones {n,m} mayores a 255: el largo se revisa aparte)
  if coalesce(p_video, '') !~ '^https://[^\s]{6,}$' or char_length(p_video) > 300 then raise exception 'VIDEO_REQUERIDO'; end if;
  update ventas_cuentas set estado = 'en_reclamo', reclamo_motivo = trim(p_motivo), reclamo_video = p_video, actualizado = now()
   where id = p_venta;
  perform _mensaje_sistema(p_venta, 'El comprador abrió un reclamo con video. Level Up lo revisará y decidirá. El dinero sigue retenido.');
end $$;

-- El comprador puede cancelar mientras no haya pagado (o mientras Level Up no haya confirmado el pago)
create or replace function public.venta_cancelar(p_venta bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.comprador is distinct from auth.uid() then raise exception 'NO_PERMITIDO'; end if;
  if v.estado <> 'pendiente_pago' then raise exception 'ESTADO_INVALIDO'; end if;
  perform _venta_cancelar(p_venta, 'El comprador canceló antes de que se confirmara el pago.', 'publicada');
end $$;

-- ---------------------------------------------------------------------
-- Funciones del VENDEDOR
-- ---------------------------------------------------------------------
create or replace function public.venta_entregar(p_venta bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.vendedor is distinct from auth.uid() then raise exception 'NO_PERMITIDO'; end if;
  if v.estado <> 'pagada' then raise exception 'ESTADO_INVALIDO'; end if;
  update ventas_cuentas set estado = 'entregada', entregada_en = now(), actualizado = now() where id = p_venta;
  perform _mensaje_sistema(p_venta, format(
    'El vendedor marcó los datos como entregados. COMPRADOR: graba la pantalla SIN CORTES desde que uses los datos (máx. 5 min después de este mensaje). Tienes %s h para tocar "Todo bien, finalizar" o "Tengo un problema"; si no, el trato se cierra solo.',
    _config_num('horas_revision', 24)));
end $$;

create or replace function public.retiro_solicitar(p_monto numeric, p_metodo text, p_datos text)
returns bigint language plpgsql security definer set search_path = public as $$
declare s saldos_vendedor; r_id bigint; comision numeric; monto numeric := round(p_monto, 2);
begin
  if auth.uid() is null then raise exception 'SIN_SESION'; end if;
  if p_metodo not in ('Pago Móvil', 'Binance', 'Zinli', 'Otro') then raise exception 'DATO_INVALIDO'; end if;
  if char_length(trim(coalesce(p_datos, ''))) not between 5 and 200 then raise exception 'DATO_INVALIDO'; end if;
  if monto is null or monto < _config_num('retiro_minimo', 5) then raise exception 'RETIRO_MINIMO'; end if;
  if exists (select 1 from retiros where vendedor = auth.uid() and estado = 'pendiente') then raise exception 'RETIRO_PENDIENTE'; end if;
  select * into s from saldos_vendedor where vendedor = auth.uid() for update;
  if not found or s.disponible < monto then raise exception 'SALDO_INSUFICIENTE'; end if;

  comision := round(monto * _config_num('comision_retiro', 4) / 100, 2);
  insert into retiros (vendedor, monto_usd, comision_usd, neto_usd, metodo, datos)
  values (auth.uid(), monto, comision, monto - comision, p_metodo, trim(p_datos))
  returning id into r_id;
  perform _mover_saldo(auth.uid(), -monto, 'retiro', null, r_id, format('Retiro R-%s (%s USD - %s USD de comisión)', r_id, monto, comision));
  return r_id;
end $$;

-- ---------------------------------------------------------------------
-- Chat del trato (comprador, vendedor y admins)
-- ---------------------------------------------------------------------
create or replace function public.mensaje_enviar(p_venta bigint, p_texto text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas; rol text; m_id bigint; recientes int; texto text := trim(coalesce(p_texto, ''));
begin
  select * into v from ventas_cuentas where id = p_venta;
  if not found then raise exception 'NO_PERMITIDO'; end if;
  rol := _rol_en_venta(v);
  if rol is null then raise exception 'NO_PERMITIDO'; end if;
  if v.estado in ('cerrada', 'cancelada') and rol <> 'admin' then raise exception 'CHAT_CERRADO'; end if;
  if char_length(texto) not between 1 and 1000 then raise exception 'DATO_INVALIDO'; end if;
  select count(*) into recientes from mensajes_venta where autor = auth.uid() and creado > now() - interval '1 minute';
  if recientes >= 20 then raise exception 'DEMASIADOS_MENSAJES'; end if;
  insert into mensajes_venta (venta, autor, rol, texto) values (p_venta, auth.uid(), rol, texto) returning id into m_id;
  return m_id;
end $$;

-- Reputación pública: ventas cerradas de cada vendedor (sin datos personales)
create or replace function public.mercado_reputacion(p_vendedores uuid[])
returns table (vendedor uuid, ventas int) language sql stable security definer set search_path = public as $$
  select s.vendedor, s.ventas from saldos_vendedor s where s.vendedor = any (p_vendedores[1:100]);
$$;

-- ---------------------------------------------------------------------
-- Funciones de ADMIN
-- ---------------------------------------------------------------------
create or replace function public._exigir_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.es_admin() then raise exception 'SOLO_ADMIN'; end if;
end $$;

create or replace function public.admin_moderar_cuenta(p_cuenta bigint, p_aprobar boolean, p_motivo text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _exigir_admin();
  perform set_config('mercado.sistema', '1', true);
  if p_aprobar then
    update cuentas_venta set estado = 'publicada', motivo_rechazo = null where id = p_cuenta and estado in ('revision', 'rechazada', 'pausada');
  else
    update cuentas_venta set estado = 'rechazada', motivo_rechazo = left(coalesce(nullif(trim(p_motivo), ''), 'No cumple las reglas'), 200)
     where id = p_cuenta and estado in ('revision', 'publicada', 'pausada');
  end if;
  if not found then raise exception 'ESTADO_INVALIDO'; end if;
end $$;

create or replace function public.admin_confirmar_pago(p_venta bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  perform _exigir_admin();
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.estado <> 'pendiente_pago' then raise exception 'ESTADO_INVALIDO'; end if;
  update ventas_cuentas set estado = 'pagada', pagada_en = now(), actualizado = now() where id = p_venta;
  perform _mensaje_sistema(p_venta, format(
    'Level Up confirmó el pago de %s USD: el dinero queda RETENIDO hasta el cierre. VENDEDOR: entrega aquí el correo/usuario y la contraseña de la cuenta y luego toca "Ya entregué los datos".', v.total_usd));
end $$;

-- A favor del vendedor: se cierra y cobra. A favor del comprador: se cancela (reembolsas tú) y la cuenta queda rechazada.
create or replace function public.admin_resolver(p_venta bigint, p_favor text, p_nota text)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas_cuentas;
begin
  perform _exigir_admin();
  select * into v from ventas_cuentas where id = p_venta for update;
  if not found or v.estado not in ('pagada', 'entregada', 'en_reclamo') then raise exception 'ESTADO_INVALIDO'; end if;
  if p_favor = 'vendedor' then
    update ventas_cuentas set resolucion = 'Resuelto a favor del vendedor: ' || coalesce(nullif(trim(p_nota), ''), 'sin nota') where id = p_venta;
    perform _venta_cerrar(p_venta, null);
  elsif p_favor = 'comprador' then
    perform _venta_cancelar(p_venta, 'Resuelto a favor del comprador (reembolso): ' || coalesce(nullif(trim(p_nota), ''), 'sin nota'), 'rechazada');
  else
    raise exception 'DATO_INVALIDO';
  end if;
end $$;

-- Cancelar cualquier trato abierto (p. ej., pago falso). Si ya había pagado, el reembolso lo haces tú.
create or replace function public.admin_cancelar(p_venta bigint, p_motivo text, p_devolver_al_mercado boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _exigir_admin();
  perform _venta_cancelar(p_venta, 'Cancelado por Level Up: ' || coalesce(nullif(trim(p_motivo), ''), 'sin motivo'),
                          case when p_devolver_al_mercado then 'publicada' else 'pausada' end);
end $$;

create or replace function public.admin_resolver_retiro(p_retiro bigint, p_pagado boolean, p_texto text)
returns void language plpgsql security definer set search_path = public as $$
declare r retiros;
begin
  perform _exigir_admin();
  select * into r from retiros where id = p_retiro for update;
  if not found or r.estado <> 'pendiente' then raise exception 'ESTADO_INVALIDO'; end if;
  if p_pagado then
    update retiros set estado = 'pagado', referencia = left(trim(coalesce(p_texto, '')), 80), resuelto = now() where id = p_retiro;
  else
    update retiros set estado = 'rechazado', motivo = left(trim(coalesce(p_texto, '')), 200), resuelto = now() where id = p_retiro;
    perform _mover_saldo(r.vendedor, r.monto_usd, 'retiro_devuelto', null, r.id, format('Retiro R-%s rechazado: %s', r.id, coalesce(nullif(trim(p_texto), ''), 'sin motivo')));
  end if;
end $$;

create or replace function public.admin_ajustar_saldo(p_vendedor uuid, p_monto numeric, p_detalle text)
returns numeric language plpgsql security definer set search_path = public as $$
begin
  perform _exigir_admin();
  return _mover_saldo(p_vendedor, round(p_monto, 2), 'ajuste', null, null, left(coalesce(p_detalle, 'Ajuste'), 200));
end $$;

create or replace function public.admin_config(p_clave text, p_valor text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _exigir_admin();
  if p_clave not in ('comision_retiro', 'retiro_minimo', 'garantia_usd', 'horas_pago', 'horas_revision', 'tasa_bs', 'instrucciones_pago') then
    raise exception 'DATO_INVALIDO';
  end if;
  if p_clave <> 'instrucciones_pago' and nullif(trim(p_valor), '') is not null and trim(p_valor) !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'DATO_INVALIDO';
  end if;
  update mercado_config set valor = left(trim(coalesce(p_valor, '')), 600) where clave = p_clave;
end $$;

-- Correos de comprador/vendedor para el panel (auth.users no es accesible desde la API)
create or replace function public.admin_correos(p_ids uuid[])
returns table (id uuid, email text) language plpgsql stable security definer set search_path = public as $$
begin
  perform _exigir_admin();
  return query select u.id, u.email::text from auth.users u where u.id = any (p_ids[1:200]);
end $$;

-- ---------------------------------------------------------------------
-- RLS: el navegador solo LEE. Todo cambio pasa por las funciones de arriba.
-- ---------------------------------------------------------------------
alter table public.mercado_admins enable row level security;
alter table public.mercado_config enable row level security;
alter table public.cuentas_venta enable row level security;
alter table public.cuentas_contacto enable row level security;
alter table public.ventas_cuentas enable row level security;
alter table public.mensajes_venta enable row level security;
alter table public.saldos_vendedor enable row level security;
alter table public.retiros enable row level security;
alter table public.movimientos_vendedor enable row level security;

drop policy if exists "soy admin" on public.mercado_admins;
create policy "soy admin" on public.mercado_admins for select to authenticated using (usuario = auth.uid());

drop policy if exists "config publica" on public.mercado_config;
create policy "config publica" on public.mercado_config for select using (true);

drop policy if exists "ver publicadas o propias" on public.cuentas_venta;
create policy "ver publicadas o propias" on public.cuentas_venta for select
  using (estado = 'publicada' or vendedor = auth.uid() or public.es_admin());
drop policy if exists "publicar propias" on public.cuentas_venta;
create policy "publicar propias" on public.cuentas_venta for insert to authenticated
  with check (vendedor = auth.uid());
drop policy if exists "editar propias" on public.cuentas_venta;
create policy "editar propias" on public.cuentas_venta for update to authenticated
  using (vendedor = auth.uid()) with check (vendedor = auth.uid());
drop policy if exists "borrar propias" on public.cuentas_venta;
create policy "borrar propias" on public.cuentas_venta for delete to authenticated
  using (vendedor = auth.uid() and estado not in ('vendida', 'reservada'));

drop policy if exists "contacto propio" on public.cuentas_contacto;
create policy "contacto propio" on public.cuentas_contacto for all to authenticated
  using (vendedor = auth.uid())
  with check (vendedor = auth.uid() and exists (select 1 from cuentas_venta c where c.id = cuenta and c.vendedor = auth.uid()));
drop policy if exists "contacto admin" on public.cuentas_contacto;
create policy "contacto admin" on public.cuentas_contacto for select to authenticated using (public.es_admin());

drop policy if exists "tratos propios" on public.ventas_cuentas;
create policy "tratos propios" on public.ventas_cuentas for select to authenticated
  using (comprador = auth.uid() or vendedor = auth.uid() or public.es_admin());

drop policy if exists "mensajes de mis tratos" on public.mensajes_venta;
create policy "mensajes de mis tratos" on public.mensajes_venta for select to authenticated
  using (public.es_admin() or exists (select 1 from ventas_cuentas v where v.id = venta and (v.comprador = auth.uid() or v.vendedor = auth.uid())));

drop policy if exists "saldo propio" on public.saldos_vendedor;
create policy "saldo propio" on public.saldos_vendedor for select to authenticated using (vendedor = auth.uid() or public.es_admin());
drop policy if exists "retiros propios" on public.retiros;
create policy "retiros propios" on public.retiros for select to authenticated using (vendedor = auth.uid() or public.es_admin());
drop policy if exists "movimientos propios" on public.movimientos_vendedor;
create policy "movimientos propios" on public.movimientos_vendedor for select to authenticated using (vendedor = auth.uid() or public.es_admin());

-- Permisos de tabla (además del RLS)
grant select on public.cuentas_venta, public.mercado_config to anon, authenticated;
grant insert, update, delete on public.cuentas_venta to authenticated;
grant select, insert, update, delete on public.cuentas_contacto to authenticated;
grant select on public.ventas_cuentas, public.mensajes_venta, public.saldos_vendedor, public.retiros,
               public.movimientos_vendedor, public.mercado_admins to authenticated;
revoke insert, update, delete on public.ventas_cuentas, public.mensajes_venta, public.saldos_vendedor, public.retiros,
               public.movimientos_vendedor, public.mercado_admins, public.mercado_config from anon, authenticated;

-- Funciones internas: nadie las llama desde la API
revoke execute on function public._mensaje_sistema(bigint, text) from public, anon, authenticated;
revoke execute on function public._mover_saldo(uuid, numeric, text, bigint, bigint, text) from public, anon, authenticated;
revoke execute on function public._venta_cerrar(bigint, text) from public, anon, authenticated;
revoke execute on function public._venta_cancelar(bigint, text, text) from public, anon, authenticated;
revoke execute on function public._rol_en_venta(public.ventas_cuentas) from public, anon, authenticated;
revoke execute on function public._exigir_admin() from public, anon, authenticated;
revoke execute on function public._config_num(text, numeric) from public, anon, authenticated;
-- Las de usuario y admin requieren sesión (las de admin comprueban además es_admin())
revoke execute on function public.venta_crear(bigint, boolean), public.venta_informar_pago(bigint, text, text),
  public.venta_finalizar(bigint), public.venta_reclamar(bigint, text, text), public.venta_cancelar(bigint),
  public.venta_entregar(bigint), public.retiro_solicitar(numeric, text, text), public.mensaje_enviar(bigint, text),
  public.admin_moderar_cuenta(bigint, boolean, text), public.admin_confirmar_pago(bigint), public.admin_resolver(bigint, text, text),
  public.admin_cancelar(bigint, text, boolean), public.admin_resolver_retiro(bigint, boolean, text),
  public.admin_ajustar_saldo(uuid, numeric, text), public.admin_config(text, text), public.admin_correos(uuid[])
  from public, anon;
grant execute on function public.venta_crear(bigint, boolean), public.venta_informar_pago(bigint, text, text),
  public.venta_finalizar(bigint), public.venta_reclamar(bigint, text, text), public.venta_cancelar(bigint),
  public.venta_entregar(bigint), public.retiro_solicitar(numeric, text, text), public.mensaje_enviar(bigint, text),
  public.admin_moderar_cuenta(bigint, boolean, text), public.admin_confirmar_pago(bigint), public.admin_resolver(bigint, text, text),
  public.admin_cancelar(bigint, text, boolean), public.admin_resolver_retiro(bigint, boolean, text),
  public.admin_ajustar_saldo(uuid, numeric, text), public.admin_config(text, text), public.admin_correos(uuid[])
  to authenticated;
grant execute on function public.mercado_mantenimiento(), public.mercado_reputacion(uuid[]), public.es_admin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- Fotos: bucket público, 1 MB por foto (la página las comprime a WebP antes de subir).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cuentas-fotos', 'cuentas-fotos', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "cuentas-fotos subir propias" on storage.objects;
create policy "cuentas-fotos subir propias" on storage.objects for insert to authenticated
  with check (bucket_id = 'cuentas-fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "cuentas-fotos borrar propias" on storage.objects;
create policy "cuentas-fotos borrar propias" on storage.objects for delete to authenticated
  using (bucket_id = 'cuentas-fotos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------
-- Tarea automática cada 10 min (si activas pg_cron en Database → Extensions; si no, la página
-- y las funciones llaman a mercado_mantenimiento() igual).
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('mercado-mantenimiento', '*/10 * * * *', 'select public.mercado_mantenimiento()');
  end if;
end $$;
