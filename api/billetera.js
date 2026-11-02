// Billetera de saldo: POST /api/billetera?accion=<estado|cargar|comprar> (maxDuration 90 en vercel.json).
// El cliente inicia sesión con Supabase Auth en public/billetera.html y manda su access_token en
// "Authorization: Bearer …". El saldo vive en Supabase (supabase/billetera.sql) y SOLO lo cambia este
// endpoint (y el webhook de Central One) con la llave secreta, a través de las funciones billetera_*.
//
//  - estado:  saldo, últimos movimientos y pedidos, y los paquetes de Free Fire que se pueden comprar.
//  - cargar:  { referencia } (últimos 5 dígitos de un Pago Móvil). Se toma el pago de la hoja "pagos"
//             (verificar_pago, igual que una recarga), se acredita TODO lo pagado y el pago queda "Usado".
//             Una referencia se acredita una sola vez (índice único en Supabase).
//  - comprar: { id, paquete (clave), nombre? }. Free Fire por la API de Central One: se comprueba el
//             producto, se descuenta el saldo, se crea el pedido (Idempotency-Key "bil-…") y, si Central One
//             lo rechaza, el saldo se devuelve. El resultado final llega por api/centralone-webhook.js.
//
// Peor caso cargar:  sesión 8 + verificar 32 + Supabase 10 + bloqueo/aviso 24 = 74 s
// Peor caso comprar: sesión 8 + precios 12 + catálogo 8 + Supabase 10 + Central One 40 + Supabase 10 = 88 s
// (lo que se anota en la hoja va en segundo plano)
import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { llamarScript, conCache, catalogoValido, ErrorExterno } from './_lib/externo.js';
import { faltaConfiguracion, PAQUETE_VALIDO, textoParaHoja } from './_lib/validacion.js';
import { FASES } from './_lib/reporte.js';
import { limpiarMontoVES, formatearVES, crearUtilidadesPedido } from './_lib/recarga-comun.js';
import { datosParaPedido, crearPedidoCentralOne } from './_lib/centralone.js';
import { clavePaquete, productosDe } from './_lib/juegos/freefire.js';
import { supabaseConfigurado, variablesFaltantes, usuarioDeSesion, rpc, leerTabla, ErrorSupabase } from './_lib/supabase.js';
import { avisarEnHoja } from './_lib/billetera.js';

const TIEMPOS = {
  // verificar_pago es idempotente con idPedido (recargas.gs v2 o más): hasta 3 intentos de 15 s
  verificar: { tiempoMs: 32000, intentoMs: 15000, reintentos: 2, reintentarTrasTimeout: true },
  precios: { reintentos: 2, intentoMs: 8000, tiempoMs: 12000, reintentarTrasTimeout: true },
  centralOne: 40000,
  incidente: 12000,
};
const CLAVE_PAQUETE = /^[a-z0-9_]{1,40}$/;
const llaveFreeFire = () => (process.env.freefire_nuevo || '').trim();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  res.setHeader('Cache-Control', 'no-store');

  const acciones = { estado, cargar, comprar };
  const accion = String(req.query.accion || '');
  if (!Object.hasOwn(acciones, accion)) return res.status(400).json({ status: 'error', message: 'Acción no válida.' });

  if (!supabaseConfigurado()) {
    return faltaConfiguracion(res, variablesFaltantes(), { status: 'error', message: 'La billetera no está disponible en este momento. Intenta más tarde.' });
  }

  let usuario;
  try {
    usuario = await usuarioDeSesion(req);
  } catch (error) {
    console.error('❌ billetera: Supabase no respondió al comprobar la sesión:', error.message);
    return res.status(503).json({ status: 'error', message: 'No pudimos comprobar tu sesión. Intenta de nuevo en unos segundos.' });
  }
  if (!usuario) return res.status(401).json({ status: 'error', sesion: false, message: 'Tu sesión venció. Vuelve a iniciar sesión.' });

  try {
    return await acciones[accion](req, res, usuario);
  } catch (error) {
    // Cada acción maneja los errores que tocan dinero; esto es lo no previsto antes de tocar nada
    console.error(`❌ billetera (${accion}):`, error.message);
    if (res.headersSent) return res;
    return res.status(error instanceof ErrorExterno ? 503 : 500).json({ status: 'error', message: 'No pudimos completar la operación. Intenta de nuevo en unos segundos.' });
  }
}

// Catálogo de Free Fire (pestaña "precios", con el product_id de Central One). Sin copia vieja: es el precio que se cobra.
async function catalogoFreeFire() {
  const url = (process.env.SCRIPT_RECARGAS_URL || '').trim();
  if (!url) throw new ErrorExterno('falta SCRIPT_RECARGAS_URL');
  const { datos } = await conCache('precios:ff',
    () => llamarScript(url, { accion: 'obtener_precios' }, TIEMPOS.precios),
    { esValido: catalogoValido, respaldoMs: 0 });
  return datos.catalogo;
}

// Solo los paquetes de UN pedido de Central One (220 = "2x110" queda fuera: si fallara la mitad no
// habría forma limpia de devolver solo una parte) y con precio
function paquetesComprables(catalogo) {
  return catalogo
    .map((p) => ({ clave: clavePaquete(p.diamantes), nombre: String(p.diamantes ?? '').slice(0, 60), precio: limpiarMontoVES(p.precio), productos: productosDe(p.producto) }))
    .filter((p) => p.clave && CLAVE_PAQUETE.test(p.clave) && p.precio > 0 && p.productos.length === 1);
}

// =========================================================================
// ESTADO
// =========================================================================
async function estado(req, res, usuario) {
  const filtro = `usuario=eq.${encodeURIComponent(usuario.id)}`;
  const [billetera, movimientos, pedidos, catalogo] = await Promise.all([
    leerTabla('billeteras', `${filtro}&select=saldo`),
    leerTabla('movimientos', `${filtro}&select=tipo,monto,saldo_despues,detalle,creado&order=creado.desc&limit=20`),
    leerTabla('pedidos', `${filtro}&select=jugador,nombre_jugador,paquete,precio,estado,creado&order=creado.desc&limit=10`),
    // Sin catálogo la página igual muestra el saldo (solo no deja comprar)
    catalogoFreeFire().catch((error) => { console.error('⚠️ billetera: no se pudo leer el catálogo:', error.message); return null; }),
  ]);
  return res.status(200).json({
    status: 'success',
    email: usuario.email,
    saldo: Number(billetera[0]?.saldo) || 0,
    movimientos: movimientos.map((m) => ({ tipo: m.tipo, monto: Number(m.monto), saldo: Number(m.saldo_despues), detalle: m.detalle || '', fecha: m.creado })),
    pedidos: pedidos.map((p) => ({ jugador: p.jugador, nombre: p.nombre_jugador || '', paquete: p.paquete, precio: Number(p.precio), estado: p.estado, fecha: p.creado })),
    // Sin llave de Central One no se puede comprar con saldo (pero sí cargar)
    paquetes: catalogo && llaveFreeFire() ? paquetesComprables(catalogo).map(({ clave, nombre, precio }) => ({ clave, nombre, precio })) : [],
  });
}

// =========================================================================
// CARGAR SALDO
// =========================================================================
async function cargar(req, res, usuario) {
  const referencia = String(req.body?.referencia ?? '');
  if (!/^\d{5}$/.test(referencia)) {
    return res.status(400).json({ status: 'error', message: 'Escribe los últimos 5 dígitos de la referencia de tu Pago Móvil.' });
  }
  const URL_GOOGLE_SCRIPT = (process.env.SCRIPT_RECARGAS_URL || '').trim();
  if (!URL_GOOGLE_SCRIPT) {
    return faltaConfiguracion(res, ['SCRIPT_RECARGAS_URL'], { status: 'error', message: 'No podemos verificar pagos en este momento. No hagas el pago todavía.' });
  }

  // Mismo límite de intentos fallidos que las recargas (frena probar referencias al azar)
  const clavesLimite = [`ip:${obtenerIp(req)}`, `billetera:${usuario.id}`];
  const minutosEspera = await minutosBloqueado(clavesLimite);
  if (minutosEspera > 0) {
    return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
  }

  const idPedido = randomUUID();
  const cuenta = `billetera ${usuario.email || usuario.id}`;
  const { marcarReferencia, registrarEnHoja, informe, bloquearPago, bloquearPorError, cerrarEnSegundoPlano } = crearUtilidadesPedido({
    urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente,
    datosInforme: { idPedido, idJugador: cuenta, paquete: 'CARGA DE SALDO (billetera)', referenciaCliente: referencia, comprobante: 'Sin comprobante' },
  });
  const enRevision = () => res.status(202).json({ status: 'error', revision: true, message: 'Fallo técnico momentáneo. Tu pago quedó registrado y la carga está en revisión: escríbenos por WhatsApp con tu referencia.' });

  // 1) Tomar el pago ("En proceso"). monto 0: se acredita lo que haya pagado, nunca es "insuficiente".
  let pago;
  try {
    pago = await llamarScript(URL_GOOGLE_SCRIPT, { accion: 'verificar_pago', referencia, monto: 0, idPedido }, TIEMPOS.verificar);
    if (pago?.status === 'error' && !pago.ocupado) throw new Error(`Apps Script respondió con error: ${pago.message || 'sin detalle'}`);
  } catch (error) {
    // El pago pudo quedar "En proceso": nunca se libera (bloquear_pedido lo deja "Usado" si lo tomó)
    console.error(`❌ [${FASES.billeteraCarga}] verificar_pago: ${error.message}`);
    const { pagoTomado } = await bloquearPorError({ fase: FASES.billeteraCarga, motivo: `Apps Script falló en verificar_pago (carga de saldo): ${error.message}. Si el pago quedó tomado, acreditarlo a mano con billetera_ajustar`, noAplica: true });
    if (!pagoTomado) return res.status(503).json({ status: 'error', message: 'No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo.' });
    return enRevision();
  }
  if (pago?.ocupado) return res.status(503).json({ status: 'error', message: 'Sistema ocupado. Intenta de nuevo en unos segundos.' });
  if (!pago?.encontrado) {
    await registrarFallo(clavesLimite);
    return res.status(400).json({ status: 'error', message: pago?.message || 'Pago no encontrado o ya utilizado.' });
  }

  const referenciaCompleta = String(pago.referencia || '');
  const monto = Math.round(Number(pago.montoPagado) * 100) / 100;
  const queHacerAMano = `revisar en Supabase (tabla movimientos) si la referencia ${referenciaCompleta} se acreditó a ${cuenta}; si no, acreditar ${formatearVES(monto)} Bs con billetera_ajustar`;
  if (!/^\d{5,30}$/.test(referenciaCompleta) || !(monto > 0)) {
    await bloquearPago(referenciaCompleta || referencia, { fase: FASES.billeteraCarga, noAplica: true, motivo: `El pago encontrado no tiene referencia o monto válidos (referencia "${referenciaCompleta}", monto "${pago.montoPagado}")`, queHacer: queHacerAMano });
    return enRevision();
  }

  // 2) Acreditar en Supabase (idempotente por referencia: repetir no suma dos veces)
  let acreditado;
  try {
    acreditado = await rpc('billetera_acreditar_carga', { p_usuario: usuario.id, p_referencia: referenciaCompleta, p_monto: monto });
  } catch (error) {
    console.error(`❌ [${FASES.billeteraCarga}] Supabase: ${error.message} | REF ${referenciaCompleta}`);
    // ErrorSupabase: se sabe que no se acreditó; ErrorExterno: no se sabe. En los dos el pago queda "Usado"
    await bloquearPago(referenciaCompleta, {
      fase: FASES.billeteraCarga, noAplica: true,
      motivo: error instanceof ErrorSupabase ? `Supabase rechazó la carga: ${error.message}. NO se acreditó.` : `Supabase no respondió al acreditar: ${error.message}. NO se sabe si se acreditó.`,
      queHacer: queHacerAMano,
    });
    return enRevision();
  }

  if (!acreditado?.nuevo && !acreditado?.mismo_usuario) {
    // La referencia ya estaba acreditada a OTRA cuenta (la fila del pago estaba repetida en la hoja)
    await bloquearPago(referenciaCompleta, { fase: FASES.billeteraCarga, noAplica: true, motivo: `La referencia ${referenciaCompleta} ya se había acreditado a otra cuenta de la billetera`, queHacer: 'no acreditar otra vez; revisar si la fila del pago está repetida en "pagos"' });
    await registrarFallo(clavesLimite);
    return res.status(400).json({ status: 'error', message: 'Este pago ya fue utilizado.' });
  }

  // 3) El pago queda "Usado" (después de responder; se repite si no se confirma)
  cerrarEnSegundoPlano([
    { nombre: 'marcar el pago como "Usado"', repetible: true, ejecutar: () => marcarReferencia('marcar_usado', referenciaCompleta) },
  ], (faltan, rondas, motivoFallo) => registrarEnHoja(informe({
    fase: FASES.billeteraCarga, noAplica: true, referenciaCompleta,
    motivo: `Saldo ACREDITADO en la billetera (${formatearVES(monto)} Bs), pero Apps Script no respondió al cierre${rondas ? ` (ni tras ${rondas} reintento(s))` : ''}: falta ${faltan.join(' y ')}${motivoFallo ? `. Motivo: ${motivoFallo}` : ''}`,
    estadoPago: `SIN CONFIRMAR: marcar a mano como "Usado" la referencia ${referenciaCompleta}`,
  })));

  console.info(`💰 Billetera: +${monto} Bs (REF ${referenciaCompleta}) a ${usuario.id}${acreditado.nuevo ? '' : ' (ya estaba acreditada)'}`);
  return res.status(200).json({
    status: 'success', saldo: Number(acreditado.saldo) || 0, acreditado: monto,
    message: acreditado.nuevo ? `¡Listo! Sumamos ${formatearVES(monto)} Bs a tu saldo.` : 'Este pago ya estaba en tu saldo.',
  });
}

// =========================================================================
// COMPRAR FREE FIRE CON SALDO
// =========================================================================
async function comprar(req, res, usuario) {
  const id = String(req.body?.id ?? '');
  const clave = String(req.body?.paquete ?? '');
  const nombreJugador = textoParaHoja(req.body?.nombre ?? '', 60).replace(/[<>"'`\\]/g, '');
  if (!/^\d{5,15}$/.test(id) || !CLAVE_PAQUETE.test(clave)) {
    return res.status(400).json({ status: 'error', message: 'Revisa tu ID (5 a 15 números) y el paquete.' });
  }
  const apiKey = llaveFreeFire();
  if (!apiKey) {
    return faltaConfiguracion(res, ['freefire_nuevo'], { status: 'error', message: 'Las compras con saldo no están disponibles en este momento. Tu saldo está seguro.' });
  }

  const clavesLimite = [`ip:${obtenerIp(req)}`, `billetera:${usuario.id}`];
  const minutosEspera = await minutosBloqueado(clavesLimite);
  if (minutosEspera > 0) {
    return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
  }

  // 1) Precio real y producto (nunca los del navegador)
  let catalogo;
  try {
    catalogo = await catalogoFreeFire();
  } catch (error) {
    console.error(`❌ [${FASES.precios}] billetera: ${error.message}`);
    return res.status(503).json({ status: 'error', message: 'No pudimos leer los precios. Intenta de nuevo en un momento.' });
  }
  const paquete = paquetesComprables(catalogo).find((p) => p.clave === clave);
  if (!paquete || !PAQUETE_VALIDO.test(paquete.nombre)) {
    return res.status(400).json({ status: 'error', message: 'Este paquete no se puede comprar con saldo ahora. Elige otro.' });
  }
  const productId = paquete.productos[0];

  // 2) ¿Central One lo puede recargar? (catálogo, stock y datos que pide). Todavía no se cobró nada.
  const datos = await datosParaPedido({ apiKey, productId, idJugador: id }).catch((error) => ({ error: error.message }));
  if (datos.error) {
    console.error(`⚠️ billetera: ${paquete.nombre} no se puede pedir a Central One: ${datos.error}`);
    return res.status(503).json({ status: 'error', message: 'Este paquete está agotado en este momento. Tu saldo no se tocó.' });
  }

  // 3) Cobrar del saldo (con candado por cliente en Supabase)
  const idPedido = `bil-${randomUUID()}`;
  const devolver = (detalle) => rpc('billetera_actualizar_pedido', { p_id_pedido: idPedido, p_estado: 'reembolsado', p_orden: null, p_detalle: detalle, p_reembolsar: true });
  const datosAviso = { idPedido, idJugador: id, paquete: `${paquete.nombre} (saldo de ${usuario.email || usuario.id})` };
  let cobro;
  try {
    cobro = await rpc('billetera_cobrar_pedido', {
      p_usuario: usuario.id, p_id_pedido: idPedido, p_precio: paquete.precio, p_jugador: id,
      p_nombre: nombreJugador, p_paquete: paquete.nombre, p_product_id: productId,
    });
  } catch (error) {
    console.error(`❌ [${FASES.billeteraCompra}] cobro: ${error.message}`);
    if (!(error instanceof ErrorSupabase)) {
      // No se sabe si se cobró: como NO se pidió nada a Central One, si se cobró se devuelve (no hace nada si no existe)
      waitUntil(devolver('No se pudo confirmar el cobro: la recarga no se pidió').catch((e) => avisarEnHoja({
        ...datosAviso, fase: FASES.billeteraCompra,
        motivo: `No se confirmó el cobro del pedido ${idPedido} ni se pudo devolver (${e.message}). La recarga NO se pidió a Central One.`,
        estadoPago: `REVISAR en Supabase (tabla pedidos): si el pedido ${idPedido} está "pagado", devolverlo con billetera_actualizar_pedido`,
      })));
    }
    return res.status(503).json({ status: 'error', message: 'No pudimos procesar tu compra. Si se descontó saldo, se devuelve solo en unos segundos.' });
  }
  if (cobro?.error === 'saldo_insuficiente') {
    return res.status(400).json({ status: 'error', insuficiente: true, saldo: Number(cobro.saldo) || 0, message: `Saldo insuficiente: tienes ${formatearVES(Number(cobro.saldo) || 0)} Bs y el paquete cuesta ${formatearVES(paquete.precio)} Bs.` });
  }
  if (cobro?.error || cobro?.repetido) {
    console.error(`❌ billetera: respuesta inesperada al cobrar ${idPedido}: ${JSON.stringify(cobro).slice(0, 200)}`);
    return res.status(503).json({ status: 'error', message: 'No pudimos procesar tu compra. Intenta de nuevo.' });
  }

  // 4) Pedido en Central One (misma Idempotency-Key en el reintento: nunca cobra dos veces)
  const orden = await crearPedidoCentralOne({
    apiKey, productId, payload: datos.payload, idempotencia: idPedido,
    nota: `Level Up ${idPedido} (saldo)`, tiempoMs: TIEMPOS.centralOne,
  });
  const saldoDespues = Number(cobro.saldo) || 0;

  if (orden.tipo === 'ok') {
    console.info(`🛒 Billetera: Central One ${orden.orden.referencia} (${orden.orden.status}) para ${idPedido} (ID ${id})`);
    // Después de responder: estado "enviado" en Supabase y la recarga en "finalizados" (contador del inicio)
    waitUntil((async () => {
      await rpc('billetera_actualizar_pedido', { p_id_pedido: idPedido, p_estado: 'enviado', p_orden: orden.orden.referencia, p_detalle: null, p_reembolsar: false })
        .catch((e) => console.error(`⚠️ billetera: no se pudo marcar "enviado" ${idPedido}: ${e.message} (el webhook lo actualizará)`));
      await llamarScript(process.env.SCRIPT_RECARGAS_URL, {
        accion: 'registrar_finalizado', idJugador: id, paquete: paquete.nombre, referencias: 'SALDO (billetera)',
        codigosUsados: textoParaHoja(`API Central One (pedido ${orden.orden.referencia}, ${orden.orden.total}) · pagado con saldo de ${usuario.email || usuario.id}`),
        urlImagen: 'Sin comprobante', idPedido,
      }, { tiempoMs: TIEMPOS.incidente }).catch((e) => console.error(`⚠️ billetera: no se anotó ${idPedido} en "finalizados": ${e.message}`));
    })());
    return res.status(200).json({ status: 'success', saldo: saldoDespues, message: `¡Recarga enviada! ${paquete.nombre} para el ID ${id}. Llega en unos minutos.` });
  }

  if (orden.tipo === 'rechazo') {
    // Central One no creó el pedido: se devuelve el saldo
    console.error(`❌ [${FASES.billeteraCompra}] ${orden.motivo} | ${idPedido}`);
    try {
      const r = await devolver(`No se recargó: ${orden.errorCliente}`);
      if (orden.codigo !== 'invalid_request') {
        waitUntil(avisarEnHoja({ ...datosAviso, fase: FASES.billeteraCompra, motivo: `${orden.motivo} Producto ${productId}. Saldo devuelto al cliente.`, estadoPago: orden.codigo === 'insufficient_balance' ? 'RECARGAR SALDO en Central One (saldo del cliente devuelto)' : 'saldo del cliente devuelto' }));
      }
      if (orden.codigo !== 'insufficient_balance') await registrarFallo(clavesLimite);
      return res.status(400).json({ status: 'error', devuelto: r?.cambiado === true, message: `No se pudo recargar: ${orden.errorCliente}. Te devolvimos ${formatearVES(paquete.precio)} Bs a tu saldo.` });
    } catch (error) {
      waitUntil(avisarEnHoja({ ...datosAviso, fase: FASES.billeteraCompra, motivo: `${orden.motivo} y NO se pudo devolver el saldo (${error.message}).`, estadoPago: `DEVOLVER a mano: billetera_actualizar_pedido('${idPedido}', 'reembolsado', null, 'devuelto a mano', true)` }));
      return res.status(202).json({ status: 'error', revision: true, message: 'No se pudo recargar y tu devolución quedó en revisión. Escríbenos por WhatsApp.' });
    }
  }

  // Incierto: el pedido PUDO crearse. Queda "revisar": decide el aviso de Central One (webhook) o el dueño
  console.error(`❌ [${FASES.billeteraCompra}] ${orden.motivo} | ${idPedido}`);
  waitUntil((async () => {
    await rpc('billetera_actualizar_pedido', { p_id_pedido: idPedido, p_estado: 'revisar', p_orden: null, p_detalle: textoParaHoja(orden.motivo, 300), p_reembolsar: false })
      .catch((e) => console.error(`⚠️ billetera: no se pudo marcar "revisar" ${idPedido}: ${e.message}`));
    await avisarEnHoja({
      ...datosAviso, fase: FASES.billeteraCompra,
      motivo: `${orden.motivo} Producto ${productId}. ANTES DE HACER NADA: buscar en el portal de Central One un pedido con la nota "Level Up ${idPedido} (saldo)".`,
      estadoPago: `Saldo COBRADO. Si Central One no tiene el pedido, devolverlo: billetera_actualizar_pedido('${idPedido}', 'reembolsado', null, 'devuelto a mano', true)`,
    });
  })());
  return res.status(202).json({ status: 'error', revision: true, saldo: saldoDespues, message: 'Tu recarga quedó en revisión con el proveedor. Si no llega, te devolvemos el saldo.' });
}
