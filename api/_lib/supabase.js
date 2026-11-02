// Supabase (billetera de saldo): sesión del cliente y funciones billetera_* de supabase/billetera.sql.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
// Sin librería: dos llamadas REST con fetch (no alarga el arranque en frío).
// La llave secreta (SUPABASE_SECRET_KEY) salta el RLS: solo vive en Vercel y solo se usa aquí.
import { pedirJSON, ErrorExterno } from './externo.js';

const url = () => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const llave = () => (process.env.SUPABASE_SECRET_KEY || '').trim();

export const supabaseConfigurado = () => Boolean(url() && llave());
export const variablesFaltantes = () => ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'].filter((v) => !(process.env[v] || '').trim());

// Llave nueva (sb_secret_…): solo en "apikey". Llave anterior (JWT service_role): también en Authorization.
function cabecerasServidor() {
  const k = llave();
  return k.startsWith('eyJ') ? { apikey: k, Authorization: `Bearer ${k}` } : { apikey: k };
}

const TOKEN_VALIDO = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Usuario de la sesión: Authorization: Bearer <access_token de Supabase Auth> que manda la página.
 * Supabase comprueba la firma y que no venció. { id, email } o null (sin sesión o sesión vencida).
 * Lanza ErrorExterno si Supabase no responde.
 */
export async function usuarioDeSesion(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 4096 || !TOKEN_VALIDO.test(token)) return null;
  // Un token inválido o vencido responde 401/403 con un JSON de error (sin id): sin sesión
  const usuario = await pedirJSON(`${url()}/auth/v1/user`, {
    metodo: 'GET', cabeceras: { apikey: llave(), Authorization: `Bearer ${token}` },
    tiempoMs: 8000, reintentos: 1, reintentarTrasTimeout: true,
  });
  return usuario?.id ? { id: String(usuario.id), email: String(usuario.email || '') } : null;
}

// PostgREST responde los errores 4xx como JSON { code, message, details, hint } (pedirJSON no los lanza)
const esErrorPostgrest = (d) => d && typeof d === 'object' && !Array.isArray(d) && 'code' in d && 'message' in d;

/**
 * Llama a una función billetera_* (RPC). Todas son idempotentes (referencia única, id_pedido único),
 * así que se pueden repetir tras un tiempo agotado sin cobrar ni acreditar dos veces.
 */
export async function rpc(funcion, parametros, { tiempoMs = 10000 } = {}) {
  const datos = await pedirJSON(`${url()}/rest/v1/rpc/${funcion}`, {
    cuerpo: parametros, cabeceras: cabecerasServidor(),
    tiempoMs, intentoMs: Math.min(tiempoMs, 6000), reintentos: 2, reintentarTrasTimeout: true,
  });
  // Error de la función (raise exception) o de permisos: NO se hizo nada en la base de datos
  if (esErrorPostgrest(datos)) throw new ErrorSupabase(`${funcion}: ${datos.message} (${datos.code})`, datos.message);
  return datos;
}

// La función respondió con un error controlado: se sabe que no cambió nada (a diferencia de ErrorExterno)
export class ErrorSupabase extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.name = 'ErrorSupabase';
    this.codigo = String(codigo || '');
  }
}

// Lectura de una tabla (filtros de PostgREST ya armados, p. ej. "usuario=eq.<uuid>&order=creado.desc&limit=20")
export async function leerTabla(tabla, consulta) {
  const datos = await pedirJSON(`${url()}/rest/v1/${tabla}?${consulta}`, {
    metodo: 'GET', cabeceras: cabecerasServidor(), tiempoMs: 8000, reintentos: 1, reintentarTrasTimeout: true,
  });
  if (!Array.isArray(datos)) throw new ErrorExterno(`Supabase no devolvió la tabla ${tabla}: ${datos?.message || 'respuesta inválida'}`);
  return datos;
}
