// Free Fire: precios, verificación de ID y recarga. Cómo se entrega lo decide el modo del menú
// "🖐️ Recargas Free Fire" de la hoja (recargas.gs): manual ("sin_codigo"), pines + bot de Railway,
// o API de Central One (pestaña "fazer_card", con el estado en tiempo real vía api/centralone-webhook.js).
// Lo usan api/juego.js (acciones precios y verificar) y api/recargar.js (recargar).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, catalogoValido, cabecerasCachePrecios, ErrorExterno } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion, telefonoCliente } from '../validacion.js';
import { FASES, ESTADO_PINES } from '../reporte.js';
import { formatearVES, limpiarMontoVES, crearUtilidadesPedido, responderErrorInesperado } from '../recarga-comun.js';
import { crearAccionDescuento, aplicarDescuentoARecarga } from '../descuentos.js';
import { datosParaPedido, crearPedidoCentralOne } from '../centralone.js';

// Tiempos (maxDuration de api/recargar.js = 180 s en vercel.json). Peor caso con fallo del bot:
// precios 8 + verificar 32 + códigos 32 + bot 45 + devolver pines 15 + registrar 12 + marcar 12 = 156 s
// Peor caso con éxito: precios 12 + verificar 32 + códigos 32 + bot 45 + marcar 12 + finalizado 12 + aviso 12 = 157 s
// Peor caso por Central One: precios 12 + verificar 32 + catálogo 17 + códigos 32 + pedidos 40 + respuesta = 133 s
// (el cierre sigue en segundo plano)
const TIEMPOS = {
  // verificar_pago y obtener_codigo: hasta 3 intentos de 15 s dentro de 32 s
  idempotente: { tiempoMs: 32000, intentoMs: 15000, reintentos: 2, reintentarTrasTimeout: true },
  // Apps Script anterior (sin idPedido): un solo intento largo, nunca se repite
  sinIdempotencia: { tiempoMs: 20000 },
  bot: 45000,
  // Pedidos de Central One (todos los de un paquete: 220 = dos de 110). Solo se repiten con la misma
  // Idempotency-Key, así Central One nunca cobra dos veces
  centralOne: 40000,
  devolver: { tiempoMs: 15000, intentoMs: 10000, reintentos: 1, reintentarTrasTimeout: true },
  incidente: 12000,
};
const RAILWAY_URL = "https://bot-levelup-production.up.railway.app/canjear";
// Error no previsto: no se sabe si el bot llegó a canjear los pines (recargas.gs los lista en la columna L)
const PINES_POR_REVISAR = { pinesNoUsados: ['los de la columna L ("pines asignados al pedido")'], estadoNoUsados: ESTADO_PINES.inciertos };

// Modo API (Central One): el product_id de cada paquete está en la fila 3 de la pestaña "precios"
// (la llena el menú "🖐️ Recargas Free Fire → 🔄 Traer productos de Central One" de recargas.gs) y
// obtener_precios lo manda como "producto". Nunca se envía al navegador (ver sinProducto).
// "2x<product_id>" = dos pedidos de ese producto (Central One no vende 220: son dos de 110).
const PRODUCTO_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCTOS_DEL_PAQUETE = /^(?:([2-9])x)?([0-9a-f-]{36})$/i;
const sinProducto = ({ producto, ...paquete }) => paquete;
// Lista de product_id a pedir para un paquete (vacía = no se puede pedir por la API)
export function productosDe(producto) {
  const partes = String(producto ?? '').trim().match(PRODUCTOS_DEL_PAQUETE);
  if (!partes || !PRODUCTO_VALIDO.test(partes[2])) return [];
  return Array(Number(partes[1] || 1)).fill(partes[2].toLowerCase());
}
// Cómo se anota en la hoja: "<id>" o "2x<id>"
const textoProductos = (lista) => (lista.length > 1 ? `${lista.length}x${lista[0]}` : lista[0] || '');
// Idempotency-Key de cada pedido: el webhook reconoce los de Free Fire por el "ff-" (api/centralone-webhook.js)
const llavePedido = (idPedido, i, total) => `ff-${idPedido}${total > 1 ? `-${i + 1}` : ''}`;

// Clave de un paquete, igual que clavePaquete() de recargas.gs: "110 Diamantes" -> "110";
// las tarjetas se reconocen por el nombre de su columna en "precios" ("Tarjeta semanal",
// "Semanal Lite", "Tarjeta mensual"; también en inglés) -> "semanal", "semanal_lite", "mensual";
// los demás productos con nombre (p. ej. "Pase de Subida de Nivel") por sus palabras -> "pase_de_subida_de_nivel".
export function clavePaquete(texto) {
  const t = String(texto ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/semanal|weekly/.test(t)) return /lite/.test(t) ? 'semanal_lite' : 'semanal';
  if (/mensual|monthly/.test(t)) return 'mensual';
  const nombre = t.replace(/free\s*fire|latam|diamantes?|diamonds?/g, ' ');
  if (!/[a-z]/.test(nombre)) return t.replace(/[^0-9]/g, '');
  return nombre.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Completar un pago insuficiente: la clave que recibe el cliente (la hoja solo guarda su huella SHA-256)
const CLAVE_COMPLEMENTO = /^[A-Za-z0-9_-]{32,64}$/;
const huella = (texto) => createHash('sha256').update(String(texto)).digest('hex');
// Errores de conexión en los que la petición NUNCA llegó al bot: es seguro reintentar
const CONEXION_NO_ESTABLECIDA = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// IDs ya validados (por instancia de Vercel): el mismo jugador suele verificar su ID varias veces
// mientras compra, y así solo la primera consulta espera a Apps Script. Solo se guardan los válidos.
const VALIDOS_MS = 10 * 60 * 1000;
const MAX_VALIDOS = 5000;
const validados = new Map();

// =========================================================================
// ACCIONES DE api/juego.js
// =========================================================================

async function precios(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
  if (!URL_GOOGLE_SCRIPT) {
    return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL"], { status: "error", message: "Error al conectar con la hoja de precios." });
  }

  try {
    // Lectura sin efectos secundarios (20 s con 1 reintento). Con copia en caché el cliente no espera.
    const { datos } = await conCache('precios:ff',
      () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, LECTURA_APPS_SCRIPT),
      { esValido: catalogoValido });
    cabecerasCachePrecios(res);
    return res.status(200).json({ ...datos, catalogo: datos.catalogo.map(sinProducto) });
  } catch (error) {
    console.error("Error al obtener precios de Free Fire:", error.message);
    return res.status(503).json({ status: "error", message: "Error al conectar con la hoja de precios." });
  }
}

async function verificar(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { id } = req.body || {};

  // Mismo formato de ID que exige la recarga
  if (!/^\d{5,15}$/.test(String(id ?? ''))) {
    return res.status(400).json({ valid: false, message: "ID con formato inválido. Debe tener entre 5 y 15 números." });
  }

  const URL_VALIDADOR = process.env.SCRIPT_VALIDADOR_URL;
  if (!URL_VALIDADOR) {
    return faltaConfiguracion(res, ["SCRIPT_VALIDADOR_URL"], { valid: false, message: "El validador de IDs no está disponible. Intenta de nuevo en unos minutos." });
  }

  const guardado = validados.get(String(id));
  if (guardado && Date.now() - guardado.momento < VALIDOS_MS) {
    return res.status(200).json({ valid: true, player_name: guardado.player_name });
  }

  try {
    const data = await llamarScript(URL_VALIDADOR, { id: String(id), juego: 'freefire' }, LECTURA_APPS_SCRIPT);
    if (data?.valid === true) {
      validados.delete(String(id));
      validados.set(String(id), { player_name: data.player_name ? String(data.player_name).slice(0, 60) : undefined, momento: Date.now() });
      if (validados.size > MAX_VALIDOS) validados.delete(validados.keys().next().value);
    }

    // Solo se devuelven los campos que usa la página, nunca la respuesta cruda de Apps Script
    return res.status(200).json({
      valid: data?.valid === true,
      player_name: data?.valid === true && data.player_name ? String(data.player_name).slice(0, 60) : undefined
    });
  } catch (error) {
    console.error("Error al verificar ID de Free Fire:", error.message);
    if (error.name === 'ErrorExterno') {
      return res.status(503).json({ valid: false, message: "El validador de IDs está lento. Intenta de nuevo en unos segundos." });
    }
    return res.status(500).json({ valid: false, message: "Error en el servidor" });
  }
}

// Catálogo de Free Fire para la acción "descuento" (misma caché que la acción precios)
async function catalogoFreeFire() {
  const { datos } = await conCache('precios:ff',
    () => llamarScript(process.env.SCRIPT_RECARGAS_URL, { accion: "obtener_precios" }, LECTURA_APPS_SCRIPT),
    { esValido: catalogoValido });
  return datos.catalogo.map(sinProducto);
}

// Contador del inicio: recargas entregadas (pestaña "finalizados", Free Fire y Mobile Legends).
// Copia de 1 h en esta instancia y 1 h en la CDN: la hoja casi nunca se despierta por esto.
// Sin dato (Apps Script anterior o caído) responde total 0 y la página no muestra nada.
async function estadisticas(req, res) {
  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
  // Solo un dato real se guarda en la CDN: un 0 por fallo se volvería a pedir enseguida
  res.setHeader('Cache-Control', 'no-store');
  // Sin dato: total null (un 0 se mostraría como "0 recargas hoy")
  if (!URL_GOOGLE_SCRIPT) return res.status(200).json({ total: null });
  try {
    // Recargas de HOY (hora de Venezuela, UTC-4 todo el año). La fecha va en la clave de la caché y la CDN
    // no guarda la respuesta más allá de la medianoche: nunca se muestra el número de ayer
    const ahoraVenezuela = new Date(Date.now() - 4 * 60 * 60_000);
    const hoy = ahoraVenezuela.toISOString().slice(0, 10);
    const segundosHastaMedianoche = 86_400 - Math.floor((ahoraVenezuela.getTime() % 86_400_000) / 1000);
    const { datos } = await conCache(`estadisticas:ff:${hoy}`,
      () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "contar_finalizados_hoy" }, LECTURA_APPS_SCRIPT),
      { frescoMs: 10 * 60_000, respaldoMs: 60 * 60_000, esValido: (d) => d?.status === 'success' && Number.isFinite(Number(d.hoy)) });
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${Math.max(1, Math.min(600, segundosHastaMedianoche))}`);
    return res.status(200).json({ total: Math.max(0, Math.floor(Number(datos.hoy))) });
  } catch (error) {
    console.error("⚠️ estadisticas: no se pudo contar las recargas:", error.message);
    return res.status(200).json({ total: null });
  }
}

export const acciones = { precios, verificar, estadisticas, descuento: crearAccionDescuento('Free Fire', catalogoFreeFire) };

// =========================================================================
// RECARGA (api/recargar.js)
// =========================================================================

/**
 * Envía los pines al bot de Railway y clasifica el resultado:
 *  - ok:          el bot canjeó todo.
 *  - fallo_bot:   el bot respondió que falló e indica qué pines canjeó y cuáles no.
 *  - no_procesado: la petición nunca llegó a procesarse (conexión rechazada, servicio caído,
 *                 clave rechazada, datos rechazados): ningún pin se canjeó.
 *  - incierto:    el bot no respondió a tiempo o la conexión se cortó a mitad: pudo canjear.
 * Solo se reintenta cuando es seguro (no_procesado por conexión o 503), dentro de 45 s.
 */
async function canjearEnBot({ pines, idJugador, secreto }) {
  const limite = Date.now() + TIEMPOS.bot;
  let intentos = 0;
  while (true) {
    intentos++;
    const restante = limite - Date.now();
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), restante);
    let resultado;
    try {
      const respuesta = await fetch(RAILWAY_URL, {
        method: "POST",
        // El bot (bot-levelup/main.py, POST /canjear) lee SOLO la cabecera "x-secret-token"
        // y la compara con su variable WEBHOOK_SECRET en Railway. Deben ser idénticas.
        headers: { "Content-Type": "application/json", "x-secret-token": secreto },
        body: JSON.stringify({ pins: pines, player_id: idJugador }),
        signal: controlador.signal
      });
      const texto = await respuesta.text();
      let datos = null;
      try { datos = JSON.parse(texto); } catch (e) { /* respuesta no JSON */ }

      if (respuesta.status === 401 || respuesta.status === 403) {
        return { tipo: 'no_procesado', intentos, motivo: `El bot rechazó la autenticación (HTTP ${respuesta.status}): RAILWAY_SECRET en Vercel no coincide con WEBHOOK_SECRET del bot en Railway. El bot no intentó canjear ningún pin.` };
      }
      if (datos && datos.status === 'success') {
        return { tipo: 'ok', intentos, usados: datos.pines_exitosos?.length ? datos.pines_exitosos : pines };
      }
      if (datos && datos.status === 'error') {
        const usados = Array.isArray(datos.pines_exitosos) ? datos.pines_exitosos : [];
        const pendientes = Array.isArray(datos.pines_pendientes) ? datos.pines_pendientes : pines.filter((p) => !usados.includes(p));
        return { tipo: 'fallo_bot', intentos, usados, pendientes, motivo: `El bot respondió con error: ${datos.detail || datos.error || 'sin detalle'}` };
      }
      if (respuesta.status === 503) {
        resultado = { tipo: 'no_procesado', reintentable: true, motivo: `Railway respondió HTTP 503 (servicio del bot no disponible o reiniciándose). El bot no procesó la petición.` };
      } else if (respuesta.status >= 400 && respuesta.status < 500) {
        return { tipo: 'no_procesado', intentos, motivo: `El bot rechazó la petición (HTTP ${respuesta.status}) antes de canjear: ${texto.slice(0, 200)}` };
      } else {
        return { tipo: 'incierto', intentos, motivo: `Respuesta inesperada del bot (HTTP ${respuesta.status}): ${texto.slice(0, 200) || 'vacía'}. No se puede confirmar si canjeó los pines.` };
      }
    } catch (error) {
      // Con varias direcciones (IPv4/IPv6) Node agrupa los errores en cause.errors
      const codigo = error.cause?.code || error.cause?.errors?.[0]?.code || error.code;
      if (error.name === 'AbortError') {
        return { tipo: 'incierto', intentos, motivo: `El bot no respondió en ${Math.round(TIEMPOS.bot / 1000)} s (tiempo agotado tras ${intentos} intento(s)). Pudo haber canjeado los pines antes del corte.` };
      }
      if (CONEXION_NO_ESTABLECIDA.has(codigo)) {
        resultado = { tipo: 'no_procesado', reintentable: true, motivo: `No se pudo conectar con el bot de Railway (${codigo}). La petición nunca llegó al bot.` };
      } else {
        return { tipo: 'incierto', intentos, motivo: `Se cortó la conexión con el bot a mitad de la petición (${codigo || error.message}). No se puede confirmar si canjeó los pines.` };
      }
    } finally {
      clearTimeout(temporizador);
    }
    // Reintento seguro: espera creciente (1 s, 2 s) si todavía queda tiempo
    const espera = intentos * 1000;
    if (!resultado.reintentable || intentos >= 3 || limite - Date.now() < espera + 5000) {
      return { ...resultado, intentos, motivo: `${resultado.motivo} (tras ${intentos} intento(s))` };
    }
    await esperar(espera);
  }
}

// Llave de Central One para Free Fire (catalog:read, orders:read y orders:write). Sin ella, en modo
// API los pedidos van a "sin_codigo" (recarga manual).
const llaveFreeFire = () => (process.env.freefire_nuevo || "").trim();

/**
 * Qué pedir a Central One para este paquete, comprobado antes de tocar el saldo:
 *  - { productos, payload }: listo (productos = lista de product_id; payload = datos del jugador).
 *  - { motivo }: no se puede pedir por la API (sin llave, sin product_id, fuera del catálogo, sin stock
 *               o pide un dato que la tienda no pregunta). En modo API el pedido va a "sin_codigo".
 * En los modos manual y bot el resultado no se usa (solo cuesta leer el catálogo, en caché 15 min).
 */
async function prepararCentralOne({ apiKey, producto, id, paquete }) {
  if (!apiKey) return { motivo: 'falta la variable freefire_nuevo en Vercel' };
  const productos = productosDe(producto);
  if (!productos.length) return { motivo: `el paquete "${paquete}" no tiene product_id de Central One en la fila 3 de "precios" (usar 🔄 Traer productos de Central One)` };
  try {
    const datos = await datosParaPedido({ apiKey, productId: productos[0], idJugador: String(id) });
    return datos.error ? { motivo: datos.error } : { productos, payload: datos.payload };
  } catch (error) {
    return { motivo: `no se pudo preparar el pedido de Central One: ${error.message}` };
  }
}

// product_id del paquete al completar un pago (el paquete sale de "por_completar"). "" si no se puede leer.
async function productoDelCatalogo(urlScript, clave) {
  try {
    const { datos } = await conCache('precios:ff',
      () => llamarScript(urlScript, { accion: "obtener_precios" }, { reintentos: 2, intentoMs: 8000, tiempoMs: 12000, reintentarTrasTimeout: true }),
      { esValido: catalogoValido, respaldoMs: 0 });
    return datos.catalogo.find((p) => clavePaquete(p.diamantes) === clave)?.producto || '';
  } catch (error) {
    console.error(`⚠️ No se pudo leer el producto de Central One del paquete ${clave}: ${error.message}`);
    return '';
  }
}

/**
 * Fases 3-5 de una recarga con el pago ya verificado (y bloqueado "En proceso"): pines o
 * "sin_codigo" o API de Central One, canje y cierre. La usan recargar (un pago) y completarPago
 * (varios pagos que juntos cubren el precio).
 */
async function entregarRecarga(res, {
  URL_GOOGLE_SCRIPT, RAILWAY_SECRET, CENTRALONE_API_KEY, producto, idPedido, id, paquete, numeroDiamantes, precioReal, desc,
  comprobante, telefono, referencias, scriptV2, cierreIdempotente, opcionesCriticas,
  utilidades: { marcarReferencia, registrarEnHoja, informe, bloquearPago, cerrarEnSegundoPlano },
}) {
  // Texto para la hoja y los informes: "ref1" o "ref1 + ref2" (pago completado)
  const referenciaCompleta = referencias.join(' + ');
  // Ante cualquier error: TODOS los pagos de este pedido quedan "Usado" (en orden, nunca en paralelo)
  const bloquear = async (datos) => {
    const [primera, ...resto] = referencias;
    const ok = await bloquearPago(primera, resto.length ? { ...datos, motivo: `${datos.motivo} (pago completado con ${referenciaCompleta})` } : datos);
    for (const ref of resto) await marcarReferencia("marcar_usado", ref);
    return ok;
  };
  const marcarPagos = async () => {
    let todos = true;
    for (const ref of referencias) todos = (await marcarReferencia("marcar_usado", ref)) && todos;
    return todos;
  };

  // Modo API: qué se pediría a Central One. Se comprueba ANTES de obtener_codigo (catálogo, stock y
  // datos que pide el producto): si no se puede, en modo API el pedido va a "sin_codigo" con el motivo,
  // en vez de bloquear el pago por un pedido que Central One iba a rechazar. No se ha gastado nada.
  const api = await prepararCentralOne({ apiKey: CENTRALONE_API_KEY, producto, id, paquete });

  // ==========================================
  // FASE 3: EXTRAER LOS CÓDIGOS DE LA HOJA
  // ==========================================
  let dataCodigos;
  try {
    // manualSiNoHay: si no hay pines del paquete, recargas.gs anota el pedido en la pestaña
    // "sin_codigo" para hacerlo a mano y responde { manual: true } (al cliente: recarga exitosa)
    dataCodigos = await llamarScript(URL_GOOGLE_SCRIPT, {
      accion: "obtener_codigo", diamantes: numeroDiamantes, idPedido, referencia: referenciaCompleta,
      manualSiNoHay: true, idJugador: String(id), paquete: textoParaHoja(String(paquete)), montoCobrado: precioReal, comprobante,
      // Modo API: qué producto se pediría a Central One (vacío = no se puede: va a "sin_codigo" con el motivo)
      ofertaFazer: textoProductos(api.productos || []),
      ...(api.motivo && { motivoSinApi: textoParaHoja(api.motivo, 300) }),
      ...(desc && { codigoDescuento: desc.codigo }),
      telefono,
    }, opcionesCriticas);
  } catch (error) {
    console.error(`⚠️ [${FASES.codigos}] ${error.message} | REF: ${referenciaCompleta}`);
    // Con v2 sabemos exactamente qué pines se asignaron a este pedido: como el bot nunca los
    // recibió, se devuelven al inventario. Sin v2 no hay forma de saberlo.
    let detallePines;
    let queHacer = 'la recarga NO se entregó; hacerla a mano';
    if (scriptV2) {
      const devolucion = await llamarScript(URL_GOOGLE_SCRIPT,
        { accion: "devolver_codigos", idPedido, motivo: `obtener_codigo sin respuesta: ${error.message}` }, TIEMPOS.devolver)
        .catch((e) => ({ status: 'error', message: e.message }));
      if (devolucion?.status === 'success') {
        detallePines = devolucion.pines?.length
          ? { pinesNoUsados: devolucion.pines, estadoNoUsados: ESTADO_PINES.devueltos }
          : { sinPines: true };
        // El pedido se quedó en "sin_codigo": hacerlo desde ahí
        if (devolucion.manual) queHacer = 'el pedido está en la pestaña "sin_codigo": hacer la recarga a mano desde ahí';
        // Modo API: el pedido NO se envió a Central One (quedó "NO ENVIADO" en "fazer_card")
        if (devolucion.api) queHacer = 'el pedido NO se envió a Central One (pestaña "fazer_card"): hacer la recarga a mano';
      } else {
        detallePines = { pinesNoUsados: [`consultar la pestaña "asignaciones_pines", pedido ${idPedido}`], estadoNoUsados: `${ESTADO_PINES.noDevueltos} (Apps Script tampoco respondió a la devolución: ${devolucion?.message})` };
      }
    } else {
      detallePines = { pinesNoUsados: ['desconocidos'], estadoNoUsados: 'NO SE PUEDE SABER: el Apps Script instalado no registra asignaciones de pines; actualiza a recargas.gs v2' };
    }

    // El pago NUNCA se libera: se bloquea y la recarga pasa a revisión manual
    await bloquear({ fase: FASES.codigos, motivo: `Apps Script no respondió a obtener_codigo: ${error.message}`, ...detallePines, queHacer });
    return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago está verificado y la recarga quedó en revisión." });
  }

  // Sin pines: el pedido quedó en "sin_codigo" para hacerlo a mano; se cierra igual que una recarga
  const manual = dataCodigos?.status === "success" && dataCodigos.manual === true;
  if (manual) console.info(`📝 Sin pines de ${numeroDiamantes}: pedido ${idPedido} (ID ${id}) anotado en "sin_codigo" para recarga manual`);
  // Modo API: el pedido quedó en "fazer_card" y la recarga la hace Central One
  const porApi = dataCodigos?.status === "success" && dataCodigos.api === true;

  if (!manual && !porApi && (!dataCodigos || dataCodigos.status !== "success" || !Array.isArray(dataCodigos.pines) || !dataCodigos.pines.length)) {
    // Apps Script anterior (sin "sin_codigo") o error: no salió ningún pin; el pago se bloquea igual
    await bloquear({
      fase: FASES.codigos, sinPines: true,
      motivo: `Apps Script no entregó códigos: ${dataCodigos?.message || 'respuesta sin pines'}`,
      queHacer: 'la recarga NO se entregó; hacerla a mano',
    });
    return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago está verificado y la recarga quedó en revisión." });
  }

  const pinesExtraidos = manual || porApi ? [] : dataCodigos.pines;

  // ==========================================
  // FASE 4 (modo API): PEDIDOS EN CENTRAL ONE
  // ==========================================
  let ordenFazer = null;
  if (porApi) {
    const productos = api.productos || [];
    const productoTexto = textoProductos(productos);
    // Un pedido tras otro (220 = dos de 110), cada uno con su Idempotency-Key, dentro del mismo tiempo total
    const ordenes = [];
    let orden = productos.length ? null
      // No debería pasar (sin producto recargas.gs lo manda a "sin_codigo"); por si acaso, no se llama a la API
      : { tipo: 'rechazo', motivo: `El paquete ${numeroDiamantes} no se puede pedir a Central One (${api.motivo || 'sin product_id'}). No se llamó a la API.` };
    for (let i = 0; i < productos.length && !orden; i++) {
      const resultado = await crearPedidoCentralOne({
        apiKey: CENTRALONE_API_KEY, productId: productos[i], payload: api.payload,
        idempotencia: llavePedido(idPedido, i, productos.length),
        nota: `Level Up ${idPedido}${productos.length > 1 ? ` (${i + 1} de ${productos.length})` : ''}`,
        tiempoMs: Math.round(TIEMPOS.centralOne / productos.length),
      });
      if (resultado.tipo === 'ok') ordenes.push(resultado.orden);
      else orden = ordenes.length
        ? { ...resultado, motivo: `${resultado.motivo} OJO: antes ya se había creado ${ordenes.length} de ${productos.length} pedidos (${ordenes.map((o) => o.referencia).join(', ')}): esa parte SÍ se recargó; falta el resto.` }
        : resultado;
    }

    if (orden) {
      console.error(`❌ [${FASES.apiFreeFire}] ${orden.motivo} | REF: ${referenciaCompleta}`);
      // Registrar el incidente y LUEGO bloquear el pago (en orden, dentro de bloquearPago)
      await bloquear({
        fase: FASES.apiFreeFire, noAplica: true,
        motivo: orden.tipo === 'incierto'
          ? `${orden.motivo} Producto ${productoTexto}. ANTES DE REPETIR: buscar en el portal de Central One un pedido con la nota "Level Up ${idPedido}" para el jugador ${id}.`
          : `${orden.motivo} Producto ${productoTexto}.`,
        queHacer: orden.tipo === 'incierto'
          ? 'confirmar el pedido en Central One antes de repetir la recarga'
          : orden.codigo === 'insufficient_balance'
            ? 'RECARGAR SALDO en Central One; no se cobró nada. Hacer la recarga a mano o devolver el pago'
            : 'no se cobró nada en Central One; hacer la recarga a mano con el ID correcto o devolver el pago',
      });
      // "fallo técnico": la página muestra el modal de "recarga en revisión"
      return res.status(202).json({ status: "error", message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión." });
    }
    // Varios pedidos: sus reference_code separados por comas (recargas.gs pone cada uno en su fila de
    // "fazer_card"; el webhook de Central One los busca por ese código)
    ordenFazer = { id: ordenes.map((o) => o.referencia).join(','), status: ordenes[0].status, total: ordenes.map((o) => o.total).join(' + ') };
    console.info(`🛒 Central One: pedido ${ordenFazer.id} (${ordenFazer.status}, ${ordenFazer.total}) para el pedido ${idPedido} (ID ${id})`);
  }

  // ==========================================
  // FASE 4: CANJE EN EL BOT DE RAILWAY (no aplica a una recarga manual)
  // ==========================================
  const bot = manual || porApi
    ? { tipo: 'ok', usados: [] }
    : await canjearEnBot({ pines: pinesExtraidos, idJugador: id, secreto: RAILWAY_SECRET });

  if (bot.tipo !== 'ok') {
    console.error(`❌ [${FASES.botFreeFire}] ${bot.motivo} | REF: ${referenciaCompleta}`);
    let detallePines;
    if (bot.tipo === 'no_procesado') {
      // El bot no tocó ningún pin: se devuelven al inventario (v2) para no perderlos
      const devolucion = scriptV2
        ? await llamarScript(URL_GOOGLE_SCRIPT, { accion: "devolver_codigos", idPedido, motivo: bot.motivo }, TIEMPOS.devolver)
            .catch((e) => ({ status: 'error', message: e.message }))
        : { status: 'error', message: 'el Apps Script instalado no tiene la acción devolver_codigos (actualiza a recargas.gs v2)' };
      detallePines = devolucion?.status === 'success'
        ? { pinesNoUsados: pinesExtraidos, estadoNoUsados: ESTADO_PINES.devueltos }
        : { pinesNoUsados: pinesExtraidos, estadoNoUsados: `${ESTADO_PINES.noDevueltos} (${devolucion?.message})` };
    } else if (bot.tipo === 'fallo_bot') {
      detallePines = { pinesUsados: bot.usados, pinesNoUsados: bot.pendientes, estadoNoUsados: ESTADO_PINES.retenidos };
    } else {
      detallePines = { pinesNoUsados: pinesExtraidos, estadoNoUsados: ESTADO_PINES.inciertos };
    }

    // 📝 ANOTAR EL INCIDENTE Y LUEGO 🔥 QUEMAR EL PAGO (en orden, dentro de bloquearPago)
    await bloquear({
      fase: FASES.botFreeFire, motivo: bot.motivo, ...detallePines,
      queHacer: 'la recarga NO se completó; entregarla manualmente al jugador',
    });

    // El mensaje contiene "fallo técnico": la página muestra el modal de "recarga en proceso"
    return res.status(400).json({
      status: "error",
      message: "Fallo técnico del bot. Pines respaldados correctamente en hoja de errores."
    });
  }

  // ==========================================
  // FASE 5: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS (en orden, en segundo plano)
  // ==========================================
  // La recarga YA se hizo: al cliente se le responde éxito sin esperar a Apps Script y el cierre sigue
  // después de responder (cerrarEnSegundoPlano). Una tras otra, NO en paralelo: las dos esperan el mismo
  // candado de recargas.gs y, cuando registrar_finalizado (con código de descuento) lo retenía,
  // marcar_usado se quedaba "ocupado" y el pago no pasaba a "Usado" aunque la recarga quedara en finalizados.
  // Lo que no se confirme se repite (registrar_finalizado solo con recargas.gs v3, que no lo anota dos veces).
  const guardarFinalizado = () => registrarEnHoja({
    accion: "registrar_finalizado",
    idJugador: id,
    paquete: paquete,
    referencias: referenciaCompleta,
    codigosUsados: manual ? 'SIN CÓDIGO: recarga manual pendiente (pestaña "sin_codigo")'
      : porApi ? `API Central One (pedido ${ordenFazer.id || 'sin id'}, ${ordenFazer.total})` : pinesExtraidos.join(" | "),
    // recargas.gs guarda la orden y su estado en la pestaña "fazer_card"
    ...(porApi && { ordenFazer: ordenFazer.id, estadoFazer: ordenFazer.status }),
    urlImagen: comprobante,
    telefono,
    idPedido,
    // recargas.gs suma +1 uso y el monto cobrado al código en la pestaña "Descuentos"
    ...(desc && { codigoDescuento: desc.codigo, montoCobrado: precioReal })
  });
  const nombreFinalizado = 'anotar la recarga en "finalizados"'
    + (porApi ? ' (y la orden en "fazer_card")' : '')
    // registrar_finalizado es quien suma el uso del código: sin él, el creador pierde esa comisión
    + (desc ? ` y el uso del código ${desc.codigo} (${precioReal} Bs, pedido ${idPedido}) en "Descuentos"` : '');
  cerrarEnSegundoPlano([
    { nombre: 'marcar el pago como "Usado"', repetible: true, ejecutar: marcarPagos },
    { nombre: nombreFinalizado, repetible: cierreIdempotente, ejecutar: guardarFinalizado },
  ], (faltan, rondas, motivoFallo) => {
    const pendiente = faltan.join(' y ') + (motivoFallo ? `. Motivo: ${motivoFallo}` : '');
    const reintentos = rondas ? ` (ni tras ${rondas} reintento(s) en segundo plano)` : '';
    return registrarEnHoja(informe({
      fase: FASES.cierre,
      motivo: manual
        ? `Recarga MANUAL (anotada en "sin_codigo"), pero Apps Script no respondió al cierre${reintentos}: falta ${pendiente}`
        : porApi
          ? `Central One aceptó el pedido ${ordenFazer.id}, pero Apps Script no respondió al cierre${reintentos}: falta ${pendiente}`
          : `La recarga SÍ se entregó, pero Apps Script no respondió al cierre${reintentos}: falta ${pendiente}`,
      referenciaCompleta, pinesUsados: bot.usados, noAplica: porApi,
      estadoPago: faltan.includes('marcar el pago como "Usado"')
        ? `SIN CONFIRMAR: marcar a mano como "Usado" la referencia ${referenciaCompleta}` : 'USADO (correcto)',
    }));
  });

  return res.status(200).json({ status: "success", message: "Recarga procesada exitosamente con Level Up Bot." });

}

export async function recargar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });
  // Segunda (o tercera...) referencia de un pago que no alcanzó
  if (req.body?.tokenComplemento !== undefined) return completarPago(req, res);

  // Desde verificar_pago: con quién bloquear el pago si algo falla sin estar previsto (ver el catch)
  let pedido = null;
  try {
    const { id, paquete, referencia } = req.body || {};
    // El comprobante viaja a la hoja de cálculo: se limpia para que no pueda inyectar fórmulas
    const urlImagen = textoParaHoja(req.body?.urlImagen || "");
    // WhatsApp opcional: inválido o vacío queda "" y la compra sigue igual
    const telefono = telefonoCliente(req.body?.telefono);

    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    // Formato estricto: ID numérico y exactamente 5 dígitos de referencia
    if (!/^\d{5,15}$/.test(String(id)) || !/^\d{5}$/.test(String(referencia)) || !PAQUETE_VALIDO.test(String(paquete))) {
      return res.status(400).json({ status: "error", message: "Datos con formato inválido. Revisa tu ID y los 5 dígitos de la referencia." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
    // trim(): al pegar el valor en Vercel es fácil que se cuele un espacio o salto de línea,
    // y el bot lo rechaza con 401 aunque la clave "se vea" igual
    const RAILWAY_SECRET = (process.env.RAILWAY_SECRET || "").trim();
    // Opcional: sin ella, en modo API los pedidos van a "sin_codigo" (recarga manual)
    const CENTRALONE_API_KEY = llaveFreeFire();

    // Sin secreto no se puede autenticar con el bot: se aborta antes de tocar pagos o códigos
    if (!URL_GOOGLE_SCRIPT || !RAILWAY_SECRET) {
      return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL", "RAILWAY_SECRET"].filter((v) => !(process.env[v] || "").trim()),
        { status: "error", message: "Las recargas automáticas no están disponibles en este momento. No realices el pago todavía; escríbenos por WhatsApp." });
    }

    // Identificador único del pedido: con recargas.gs v2 hace idempotentes verificar_pago y
    // obtener_codigo (repetir la petición devuelve el mismo pago y los MISMOS pines) y enlaza
    // el pedido con la pestaña "asignaciones_pines".
    const idPedido = randomUUID();
    const comprobante = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";

    const { marcarReferencia, registrarEnHoja, informe, bloquearPago, bloquearPorError, cerrarEnSegundoPlano } = crearUtilidadesPedido({
      urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente,
      datosInforme: { idPedido, idJugador: id, paquete, referenciaCliente: referencia, comprobante, telefono },
    });

    // Antes de consultar la hoja de pagos: ¿esta IP o este jugador acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:ff:${id}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: "error", message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    // ==========================================
    // FASE 1: OBTENER EL PRECIO REAL
    // ==========================================
    // Copia de hasta 60 s para no repetir la consulta en cada compra; sin respaldo viejo,
    // porque este precio es el que se cobra.
    let dataPrecios;
    try {
      ({ datos: dataPrecios } = await conCache('precios:ff',
        () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, { reintentos: 2, intentoMs: 8000, tiempoMs: 12000, reintentarTrasTimeout: true }),
        { esValido: catalogoValido, respaldoMs: 0 }));
    } catch (error) {
      console.error(`❌ [${FASES.precios}] ${error.message}`);
      return res.status(503).json({ status: "error", message: "Error al leer la base de datos de precios. Intenta de nuevo en un momento." });
    }

    // recargas.gs v2 anuncia "version: 2" en los precios: solo entonces es seguro reintentar
    // verificar_pago y obtener_codigo después de un timeout
    const scriptV2 = Number(dataPrecios.version) >= 2;
    // v3: registrar_finalizado ignora un idPedido ya anotado (se puede repetir el cierre en segundo plano)
    const cierreIdempotente = Number(dataPrecios.version) >= 3;
    const opcionesCriticas = scriptV2 ? TIEMPOS.idempotente : TIEMPOS.sinIdempotencia;

    const numeroDiamantes = clavePaquete(paquete);
    const paqueteGsheet = numeroDiamantes && dataPrecios.catalogo.find(p => clavePaquete(p.diamantes) === numeroDiamantes);
    if (!paqueteGsheet) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }
    const precioLista = limpiarMontoVES(paqueteGsheet.precio);

    // Descuento opcional: se vuelve a consultar el código (pudo desactivarse) antes de tocar el pago
    const descuento = await aplicarDescuentoARecarga(req.body?.codigoDescuento, precioLista);
    if (descuento.error) return res.status(descuento.error.codigo).json(descuento.error.cuerpo);
    const { desc, precio: precioReal } = descuento;

    // ==========================================
    // FASE 2: BUSCAR PAGO Y VERIFICAR
    // ==========================================
    pedido = { utilidades: { registrarEnHoja, informe, bloquearPorError }, referencias: [] };
    let dataVerificacion;
    try {
      dataVerificacion = await llamarScript(URL_GOOGLE_SCRIPT,
        { accion: "verificar_pago", referencia: referencia, monto: precioReal, idPedido }, opcionesCriticas);
      // Un error de Apps Script (salvo "ocupado", que no ejecutó nada) pudo dejar el pago "En proceso":
      // se trata igual que si no hubiera respondido
      if (dataVerificacion?.status === 'error' && !dataVerificacion.ocupado) {
        throw new Error(`Apps Script respondió con error: ${dataVerificacion.message || 'sin detalle'}`);
      }
    } catch (error) {
      // El pago pudo quedar "En proceso" en la hoja: NUNCA se libera, se marca "Usado" (bloquear_pedido
      // solo toca el pago que bloqueó ESTE pedido) y la recarga pasa a revisión manual.
      console.error(`❌ [${FASES.verificacion}] ${error.message}`);
      const motivo = `Apps Script falló en verificar_pago: ${error.message}`;
      let pagoTomado = true;
      if (scriptV2) {
        ({ pagoTomado } = await bloquearPorError({ fase: FASES.verificacion, motivo, sinPines: true }));
      } else {
        await registrarEnHoja(informe({ fase: FASES.verificacion, motivo, sinPines: true,
          estadoPago: `SIN CONFIRMAR: si la fila del pago (referencia terminada en ${referencia}) quedó "En proceso", márcala "Usado" y haz la recarga a mano` }));
      }
      if (!pagoTomado) {
        return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo." });
      }
      // "fallo técnico": la página muestra el modal de "recarga en revisión"
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Si tu pago es válido, quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tu referencia." });
    }

    // Ocupado: Apps Script no tocó ningún pago; no cuenta como intento fallido del cliente
    if (dataVerificacion?.ocupado) {
      return res.status(503).json({ status: "error", message: dataVerificacion.message || "Sistema ocupado. Intenta de nuevo en unos segundos." });
    }
    if (!dataVerificacion || !dataVerificacion.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: dataVerificacion?.message || "Pago no encontrado o ya utilizado." });
    }
    const referenciaCompleta = dataVerificacion.referencia;
    pedido.referencias = [referenciaCompleta];

    if (dataVerificacion.insuficiente) {
      await registrarFallo(clavesLimite);
      const pagado = Number(dataVerificacion.montoPagado) || 0;
      const faltante = precioReal - pagado;

      // El pago queda "Por completar" (nadie más puede usarlo) y el cliente recibe una clave para pagar
      // la diferencia. El jugador, el paquete y el precio quedan en la hoja: al completar se usan esos,
      // nunca los que mande el navegador. Se puede repetir: recargas.gs reconoce el idPedido.
      const clave = randomBytes(24).toString('base64url');
      const porCompletar = await llamarScript(URL_GOOGLE_SCRIPT, {
        accion: "pago_por_completar", idPedido, referencia: referenciaCompleta, idJugador: String(id),
        paquete: textoParaHoja(String(paquete)), precio: precioReal, pagado, comprobante, telefono,
        codigoDescuento: desc?.codigo || "", claveHash: huella(clave),
      }, { reintentos: 2, tiempoMs: TIEMPOS.incidente, reintentarTrasTimeout: true }).catch((e) => ({ status: 'error', message: e.message }));
      if (porCompletar?.status === 'success') {
        return res.status(400).json({
          status: "error",
          insuficiente: true,
          montoPagado: pagado,
          precioRequerido: precioReal,
          faltante: faltante,
          tokenComplemento: clave,
          horasParaCompletar: Number(porCompletar.horas) || 48,
          message: `Pago insuficiente: Encontramos ${formatearVES(pagado)} Bs, pero el paquete cuesta ${formatearVES(precioReal)} Bs. Faltan ${formatearVES(faltante)} Bs: paga la diferencia y escribe la nueva referencia para completar tu recarga.`
        });
      }
      console.error(`⚠️ pago_por_completar falló para REF ${referenciaCompleta}: ${porCompletar?.message}. Se bloquea el pago como antes.`);

      // Sin "completar" (Apps Script anterior o sin respuesta): el pago queda "Usado" y se resuelve por WhatsApp
      await bloquearPago(referenciaCompleta, {
        fase: FASES.verificacion, sinPines: true,
        motivo: `Pago insuficiente: pagó ${formatearVES(pagado)} Bs y el paquete cuesta ${formatearVES(precioReal)} Bs (faltan ${formatearVES(faltante)} Bs)`,
        queHacer: 'NO se recargó; el cliente completa la diferencia o pide la devolución por WhatsApp',
      });

      return res.status(400).json({
        status: "error",
        insuficiente: true,
        montoPagado: pagado,
        precioRequerido: precioReal,
        faltante: faltante,
        message: `Pago insuficiente: Encontramos ${formatearVES(pagado)} Bs, pero el paquete cuesta ${formatearVES(precioReal)} Bs. Faltan ${formatearVES(faltante)} Bs.`
      });
    }

    return await entregarRecarga(res, {
      URL_GOOGLE_SCRIPT, RAILWAY_SECRET, CENTRALONE_API_KEY, producto: paqueteGsheet.producto, idPedido, id, paquete, numeroDiamantes, precioReal, desc,
      comprobante, telefono, referencias: [referenciaCompleta], scriptV2, cierreIdempotente, opcionesCriticas,
      utilidades: { marcarReferencia, registrarEnHoja, informe, bloquearPago, cerrarEnSegundoPlano },
    });
  } catch (error) {
    console.error("Error crítico en la recarga de Free Fire:", error.message);
    // Con el pago ya pedido: se bloquea y va a "errores" (los pines del pedido salen en la columna L)
    const respuesta = await responderErrorInesperado(res, pedido, error, PINES_POR_REVISAR);
    if (respuesta) return respuesta;
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si te dice que ya fue utilizado, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}

/**
 * Completar un pago insuficiente: POST { tokenComplemento, referencia (últimos 5 del nuevo pago) }.
 * La clave solo sirve para el pedido que la generó: el jugador, el paquete y el precio salen de la
 * pestaña "por_completar" (el navegador no puede cambiarlos). usar_complemento corre con el candado
 * de recargas.gs: si dos dispositivos lo intentan a la vez, solo uno avanza; el pago nuevo queda
 * "En proceso" o "Por completar" y nunca vuelve a "Verificado".
 */
async function completarPago(req, res) {
  // Desde usar_complemento: con quién bloquear los pagos si algo falla sin estar previsto (ver el catch)
  let pedido = null;
  // Límite del cierre en segundo plano (las utilidades del pedido se crean más tarde)
  const inicio = Date.now();
  try {
    const clave = String(req.body?.tokenComplemento ?? '');
    const referencia = String(req.body?.referencia ?? '');
    if (!CLAVE_COMPLEMENTO.test(clave) || !/^\d{5}$/.test(referencia)) {
      return res.status(400).json({ status: "error", message: "Escribe los últimos 5 dígitos de la referencia del pago que hiciste para completar." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
    const RAILWAY_SECRET = (process.env.RAILWAY_SECRET || "").trim();
    const CENTRALONE_API_KEY = llaveFreeFire();
    if (!URL_GOOGLE_SCRIPT || !RAILWAY_SECRET) {
      return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL", "RAILWAY_SECRET"].filter((v) => !(process.env[v] || "").trim()),
        { status: "error", message: "No podemos completar tu pago en este momento. Escríbenos por WhatsApp con tus referencias." });
    }

    const claveHash = huella(clave);
    // Intentos fallidos por IP y por clave (frena probar referencias al azar)
    const clavesLimite = [`ip:${obtenerIp(req)}`, `completar:ff:${claveHash.slice(0, 24)}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: "error", message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    const idPedido = randomUUID();
    // Hasta conocer el pedido (sale de la hoja), los informes de "errores" remiten a "por_completar"
    pedido = {
      utilidades: crearUtilidadesPedido({
        urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente, inicio,
        datosInforme: { idPedido, idJugador: 'ver pestaña "por_completar"', paquete: 'pago por completar', referenciaCliente: referencia, comprobante: 'Sin comprobante' },
      }),
      referencias: [],
    };
    const revisarPorCompletar = `Revisar la pestaña "por_completar" (clave ${claveHash.slice(0, 12)}…)`;
    let datos;
    try {
      // Se puede repetir: recargas.gs guarda la respuesta de este idPedido
      datos = await llamarScript(URL_GOOGLE_SCRIPT, { accion: "usar_complemento", claveHash, referencia, idPedido }, TIEMPOS.idempotente);
      // Un error de Apps Script (salvo "ocupado") pudo dejar el pago nuevo "En proceso"
      if (datos?.status === 'error' && !datos.ocupado) throw new Error(`Apps Script respondió con error: ${datos.message || 'sin detalle'}`);
    } catch (error) {
      // El pago nuevo pudo quedar "En proceso": se bloquea (solo el que tomó ESTE pedido) y va a revisión
      console.error(`❌ [${FASES.verificacion}] usar_complemento falló: ${error.message}`);
      await pedido.utilidades.bloquearPorError({
        fase: FASES.verificacion, sinPines: true,
        motivo: `Apps Script falló al completar un pago (usar_complemento): ${error.message}. ${revisarPorCompletar}`,
      });
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tus referencias." });
    }

    // Ocupado: Apps Script no tocó ningún pago; la clave sigue sirviendo
    if (datos?.ocupado) {
      return res.status(503).json({ status: "error", message: datos.message || "Sistema ocupado. Intenta de nuevo en unos segundos." });
    }
    if (datos?.status !== 'success' || !datos.valido) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", complementoInvalido: true, message: datos?.message || "No pudimos completar este pago. Escríbenos por WhatsApp con tus referencias." });
    }
    if (!datos.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: datos.message || "Pago no encontrado o ya utilizado." });
    }
    if (!datos.completo) {
      const falta = Number(datos.falta) || 0;
      return res.status(400).json({
        status: "error", insuficiente: true, tokenComplemento: clave,
        montoPagado: Number(datos.pagadoTotal) || 0, precioRequerido: Number(datos.precio) || 0, faltante: falta,
        message: `Pago insuficiente: con este pago llevas ${formatearVES(Number(datos.pagadoTotal) || 0)} Bs y faltan ${formatearVES(falta)} Bs. Paga la diferencia y escribe la nueva referencia.`,
      });
    }

    // Pago completo: los datos del pedido salen de la hoja (se validan igual que en recargar)
    const id = String(datos.idJugador || '');
    const paquete = String(datos.paquete || '');
    const referencias = Array.isArray(datos.referencias) ? datos.referencias.map(String).filter((r) => /^\d{5,30}$/.test(r)) : [];
    const precioReal = limpiarMontoVES(datos.precio);
    const numeroDiamantes = clavePaquete(paquete);
    if (!/^\d{5,15}$/.test(id) || !PAQUETE_VALIDO.test(paquete) || !numeroDiamantes || !referencias.length || !(precioReal > 0)) {
      console.error(`❌ usar_complemento devolvió datos inválidos para el pedido ${idPedido}: ${JSON.stringify(datos).slice(0, 300)}`);
      // Los pagos de este pedido quedan "Usado" (si no se pueden leer las referencias, el que tomó este pedido)
      await pedido.utilidades.bloquearPorError({
        fase: FASES.inesperado, sinPines: true, referencias,
        motivo: `usar_complemento devolvió datos inválidos (jugador "${id}", paquete "${paquete}", precio ${datos.precio}, referencias ${JSON.stringify(datos.referencias)}). ${revisarPorCompletar}`,
      });
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tus referencias." });
    }
    const comprobante = textoParaHoja(datos.comprobante || "Sin comprobante");
    // El WhatsApp que dejó en el primer pago (recargas.gs lo guarda en "por_completar") o el de ahora
    const telefono = telefonoCliente(datos.telefono) || telefonoCliente(req.body?.telefono);
    const utilidades = crearUtilidadesPedido({
      urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente, inicio,
      datosInforme: { idPedido, idJugador: id, paquete, referenciaCliente: referencia, comprobante, telefono },
    });
    pedido = { utilidades, referencias };
    console.info(`🧩 Pago completado (${referencias.join(' + ')}) para el pedido ${datos.idPedidoOriginal} -> ${idPedido} (ID ${id})`);

    return await entregarRecarga(res, {
      URL_GOOGLE_SCRIPT, RAILWAY_SECRET, CENTRALONE_API_KEY, idPedido, id, paquete, numeroDiamantes, precioReal,
      producto: await productoDelCatalogo(URL_GOOGLE_SCRIPT, numeroDiamantes),
      desc: datos.codigoDescuento ? { codigo: String(datos.codigoDescuento) } : null,
      comprobante, telefono, referencias, scriptV2: true, opcionesCriticas: TIEMPOS.idempotente, utilidades,
      // usar_complemento de recargas.gs v3 anuncia su versión
      cierreIdempotente: Number(datos.version) >= 3,
    });
  } catch (error) {
    console.error("Error crítico al completar un pago de Free Fire:", error.message);
    const respuesta = await responderErrorInesperado(res, pedido, error, PINES_POR_REVISAR);
    if (respuesta) return respuesta;
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si persiste, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
