// Billetera de saldo (Supabase): lo que comparten api/billetera.js y api/centralone-webhook.js.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { llamarScript } from './externo.js';
import { informeError } from './reporte.js';

// Idempotency-Key de una compra con saldo en Central One = id_pedido de la tabla "pedidos" de Supabase
export const PEDIDO_BILLETERA = /^bil-[0-9a-f-]{36}$/;

/**
 * Fila en la pestaña "errores" de la hoja de Free Fire para lo que el dueño debe revisar a mano
 * (compra incierta, saldo no devuelto, entrega después de devolver...). Nunca lanza: devuelve true/false.
 * No se repite tras un tiempo agotado (agrega una fila).
 */
export async function avisarEnHoja({ fase, motivo, estadoPago, idPedido, idJugador, paquete, referencia = 'SALDO (billetera)', tiempoMs = 12000 }) {
  const url = (process.env.SCRIPT_RECARGAS_URL || '').trim();
  if (!url) {
    console.error(`🚨 billetera: falta SCRIPT_RECARGAS_URL; no se pudo anotar en "errores": ${motivo}`);
    return false;
  }
  try {
    const r = await llamarScript(url, informeError({
      fase, motivo, estadoPago, idPedido, idJugador, paquete, noAplica: true,
      referenciaCliente: referencia, referenciaCompleta: referencia, comprobante: 'Sin comprobante',
    }), { tiempoMs });
    if (r?.status === 'error') throw new Error(r.message || 'Apps Script respondió status "error"');
    return true;
  } catch (error) {
    console.error(`❌ billetera: no se pudo anotar en "errores" (${error.message}). Aviso: ${motivo}`);
    return false;
  }
}
