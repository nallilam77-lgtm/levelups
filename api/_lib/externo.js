// Llamadas a Apps Script y APIs externas con tiempo límite, reintentos y caché en memoria.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
//
// REGLA DE REINTENTOS: solo se reintenta lo que se puede repetir sin efectos secundarios
// (leer precios, validar un ID, marcar una referencia como usada) o lo que el Apps Script hace
// idempotente con un idPedido (verificar_pago y obtener_codigo en recargas.gs v2: repetir la
// petición devuelve el mismo resultado). Nunca se reintenta lo que crea algo sin esa protección
// (compras, registros), porque un reintento tras un timeout podría duplicar la operación.
// La ruleta sí se reintenta: apps-script/ruleta.gs devuelve el premio ya anotado si se repite el giro.

import { waitUntil } from '@vercel/functions';

export const TIEMPO_LIMITE_MS = 8000;

// Apps Script tarda 5-15 s cuando "despierta" (arranque en frío). Presupuestos para llamarlo:
// - LECTURA: sin efectos secundarios. 20 s en total; si el primer intento pasa de 12 s se corta
//   y se reintenta, porque el segundo suele encontrar el script ya despierto y responde rápido.
// - ESCRITURA: crea algo (un archivo en Drive). 20 s en un solo intento, nunca se reintenta.
// Las funciones que los usan tienen maxDuration 30 en vercel.json para que Vercel no las corte antes.
export const LECTURA_APPS_SCRIPT = { tiempoMs: 20000, intentoMs: 12000, reintentos: 1, reintentarTrasTimeout: true };
export const ESCRITURA_APPS_SCRIPT = { tiempoMs: 20000 };
// Espera antes de cada reintento: 400 ms, 1,2 s, 2,4 s... (le da tiempo a Apps Script de "despertar")
const ESPERAS_REINTENTO_MS = [400, 1200, 2400];

export class ErrorExterno extends Error {
  constructor(mensaje, { tiempoAgotado = false, estadoHttp = null } = {}) {
    super(mensaje);
    this.name = 'ErrorExterno';
    this.tiempoAgotado = tiempoAgotado;
    this.estadoHttp = estadoHttp;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function intentoUnico(url, opciones, tiempoMs) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), tiempoMs);
  try {
    const respuesta = await fetch(url, { ...opciones, signal: controlador.signal });
    const texto = await respuesta.text();
    let datos;
    try {
      datos = JSON.parse(texto);
    } catch (e) {
      // Apps Script devuelve una página HTML cuando el script falla
      console.error(`🚨 Respuesta no JSON (HTTP ${respuesta.status}):`, texto.slice(0, 500));
      throw new ErrorExterno(`Respuesta ilegible (HTTP ${respuesta.status})`, { estadoHttp: respuesta.status });
    }
    if (respuesta.status >= 500) {
      throw new ErrorExterno(`HTTP ${respuesta.status}`, { estadoHttp: respuesta.status });
    }
    return datos;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ErrorExterno(`Tiempo agotado (${Math.round(tiempoMs / 1000)} s)`, { tiempoAgotado: true });
    }
    if (error instanceof ErrorExterno) throw error;
    throw new ErrorExterno(`Red: ${error.message}`);
  } finally {
    clearTimeout(temporizador);
  }
}

// Hace la petición y devuelve el JSON. Todo el proceso (incluidos reintentos) respeta
// un presupuesto total de `tiempoMs`: la función nunca tarda más que eso.
// - intentoMs: tiempo máximo de cada intento (por defecto, todo el presupuesto).
// - reintentarTrasTimeout: solo para operaciones idempotentes; si es false, tras un timeout
//   no se reintenta porque la primera petición pudo haberse completado en el servidor.
// El error final indica cuántos intentos se hicieron (e.intentos) para el informe de errores.
export async function pedirJSON(url, { metodo = 'POST', cuerpo, reintentos = 0, tiempoMs = TIEMPO_LIMITE_MS, intentoMs, reintentarTrasTimeout = false, cabeceras = {} } = {}) {
  const opciones = { method: metodo, headers: { 'Content-Type': 'application/json', ...cabeceras } };
  if (cuerpo !== undefined) opciones.body = JSON.stringify(cuerpo);

  const limite = Date.now() + tiempoMs;
  let ultimoError;
  let intentos = 0;
  for (let intento = 0; intento <= reintentos; intento++) {
    const restante = limite - Date.now();
    if (restante < 500) break;
    intentos++;
    try {
      return await intentoUnico(url, opciones, Math.min(restante, intentoMs || restante));
    } catch (error) {
      ultimoError = error;
      if ((error.tiempoAgotado && !reintentarTrasTimeout) || intento === reintentos) break;
      const espera = ESPERAS_REINTENTO_MS[Math.min(intento, ESPERAS_REINTENTO_MS.length - 1)];
      if (limite - Date.now() < espera + 1000) break; // no queda tiempo para otro intento útil
      await esperar(espera);
    }
  }
  const final = ultimoError || new ErrorExterno('Tiempo agotado');
  final.intentos = intentos;
  if (intentos > 1) final.message = `${final.message} (tras ${intentos} intentos)`;
  throw final;
}

// Atajo para Apps Script: POST con { accion, ... }
// A los Apps Script de recargas (Free Fire), Blood Strike y Mobile Legends se les añade SCRIPT_RECARGAS_TOKEN en el
// cuerpo (Apps Script no puede leer cabeceras): así solo Vercel puede pedir pines o cambiar pagos
// aunque la URL se filtre. Cada script lo exige solo si tiene la propiedad TOKEN_VERCEL.
export function llamarScript(url, cuerpo, opciones = {}) {
  const token = (process.env.SCRIPT_RECARGAS_TOKEN || '').trim();
  const destino = String(url || '').trim();
  const conToken = Boolean(destino) && ['SCRIPT_RECARGAS_URL', 'SCRIPT_BLOOD', 'SCRIPT_MLBB'].some((v) => destino === (process.env[v] || '').trim());
  return pedirJSON(url, { ...opciones, cuerpo: token && conToken ? { ...cuerpo, token } : cuerpo });
}

// =========================================================================
// CACHÉ EN MEMORIA (por instancia de Vercel; sobrevive entre peticiones "tibias")
// - Dentro de `frescoMs`: responde al instante sin llamar a Apps Script.
// - Pasado ese tiempo consulta de nuevo; si Apps Script falla o tarda, devuelve la
//   última copia buena (hasta `respaldoMs`) para que la página nunca se quede sin precios.
//   Si solo tarda, la consulta termina después de responder (waitUntil) y la próxima visita
//   ya ve lo nuevo: un cambio en la hoja tarda como mucho ~2 minutos en verse.
// - Peticiones simultáneas comparten una sola llamada a Apps Script.
// =========================================================================
const cache = new Map();
const enCurso = new Map();
// Marca de "Apps Script tardó más de esperaConRespaldoMs" (no es un fallo: la consulta sigue)
const LENTO = new ErrorExterno('Apps Script lento', { tiempoAgotado: true });

export async function conCache(clave, obtener, { frescoMs = 60_000, respaldoMs = 6 * 60 * 60_000, esperaConRespaldoMs = 1500, esValido = () => true } = {}) {
  const guardado = cache.get(clave);
  const edad = guardado ? Date.now() - guardado.momento : Infinity;
  if (edad < frescoMs) return { datos: guardado.datos, origen: 'cache' };
  const hayRespaldo = guardado && edad < respaldoMs;

  if (!enCurso.has(clave)) {
    const promesa = (async () => {
      try {
        const datos = await obtener();
        if (!esValido(datos)) throw new ErrorExterno('Datos inválidos de Apps Script');
        cache.set(clave, { datos, momento: Date.now() });
        return datos;
      } finally {
        enCurso.delete(clave);
      }
    })();
    promesa.catch(() => {}); // puede terminar después de responder con el respaldo
    enCurso.set(clave, promesa);
  }

  const consulta = enCurso.get(clave);
  try {
    // Con copia guardada no se hace esperar al cliente: si Apps Script tarda más de 1,5 s
    // se responde con la copia y la consulta sigue renovando la caché en segundo plano
    // (waitUntil: sin él, Vercel congela la función al responder y la copia vieja no se renovaba).
    const datos = hayRespaldo
      ? await Promise.race([consulta, esperar(esperaConRespaldoMs).then(() => { throw LENTO; })])
      : await consulta;
    return { datos, origen: 'fresco' };
  } catch (error) {
    if (!hayRespaldo) throw error;
    if (error === LENTO) {
      // Solo tardó: es lo normal en Apps Script, no un fallo. Solo se avisa si la renovación falla.
      waitUntil(consulta.catch((e) => console.error(`⚠️ ${clave}: no se pudo renovar (${e.message}). Se sigue usando la copia anterior.`)));
    } else {
      console.error(`⚠️ ${clave}: Apps Script falló (${error.message}). Usando copia de hace ${Math.round(edad / 1000)} s.`);
    }
    return { datos: guardado.datos, origen: 'respaldo' };
  }
}

export const catalogoValido = (datos) => datos?.status === 'success' && Array.isArray(datos.catalogo) && datos.catalogo.length > 0;

// Precios: el navegador y la CDN de Vercel reutilizan la respuesta solo 20 s. Sin
// stale-while-revalidate: con él la CDN seguía sirviendo precios viejos varios minutos después
// de cambiarlos en la hoja. La carga real sobre Apps Script ya la frena conCache (1 consulta por
// minuto), así que un cambio en la hoja se ve en ~1,5 minutos como mucho.
export function cabecerasCachePrecios(res) {
  res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=20');
}

// =========================================================================
// WEBHOOKS (api/fazer-webhook.js, api/centralone-webhook.js): la firma se calcula sobre el cuerpo
// CRUDO, así que el endpoint exporta config.api.bodyParser = false y NO lee req.body antes de esto.
// =========================================================================
const MAX_CUERPO_WEBHOOK = 64 * 1024;

export async function leerCuerpoCrudo(req) {
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > MAX_CUERPO_WEBHOOK) throw new Error('cuerpo demasiado grande');
    partes.push(Buffer.from(parte));
  }
  if (total > 0) return Buffer.concat(partes);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  // Vercel ya lo convirtió a objeto: se vuelve a JSON compacto (la firma solo coincide si el
  // proveedor lo envió así)
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));
  return Buffer.alloc(0);
}
