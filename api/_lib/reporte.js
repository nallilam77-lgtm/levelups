// Informe de errores para la pestaña "errores" de Google Sheets.
// Cada informe dice EXACTAMENTE: en qué fase falló, el motivo técnico, qué pasó con cada pin,
// en qué estado quedó el pago y todos los datos del pedido. Nada de "revisar si...".
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)

export const FASES = {
  precios: '1. LECTURA DE PRECIOS (Google Sheets)',
  verificacion: '2. VERIFICACIÓN DEL PAGO (Google Sheets)',
  codigos: '3. OBTENCIÓN DE CÓDIGOS (inventario en Google Sheets)',
  botFreeFire: '4. CANJE EN FREE FIRE (bot de Railway)',
  apiBloodStrike: '4. RECARGA EN LA API DEL PROVEEDOR (Central One)',
  apiFreeFire: '4. RECARGA DE FREE FIRE EN LA API DEL PROVEEDOR (Central One)',
  apiMobileLegends: '4. RECARGA DE MOBILE LEGENDS EN LA API DEL PROVEEDOR (Central One)',
  cierre: '5. CIERRE DEL PEDIDO (marcar pago usado / registrar finalizado)',
  billeteraCarga: 'BILLETERA · CARGA DE SALDO (pago móvil → Supabase)',
  billeteraCompra: 'BILLETERA · COMPRA CON SALDO (Supabase → Central One)',
  inesperado: 'ERROR INESPERADO (excepción o respuesta no prevista en Vercel)',
};

// Estados posibles de los pines. Siempre van acompañados de los códigos exactos.
export const ESTADO_PINES = {
  ninguno: 'NINGUNO: el fallo ocurrió antes de asignar pines a este pedido',
  usados: 'SE USARON (canjeados por el bot)',
  devueltos: 'NO SE USARON — DEVUELTOS AL INVENTARIO automáticamente',
  noDevueltos: 'NO SE USARON — NO se pudieron devolver al inventario: devolverlos a mano',
  retenidos: 'NO SE CANJEARON (el bot lo confirma) — retenidos en esta fila, NO devueltos al inventario porque el bot intentó canjearlos y falló',
  inciertos: 'ESTADO INCIERTO: el bot no respondió a tiempo y pudo haberlos canjeado; comprobar en la cuenta del jugador antes de reutilizarlos',
  noAplica: 'NO APLICA: recarga directa por API, sin pines',
};

const lista = (pines) => (pines && pines.length ? pines.join(' | ') : 'ninguno');

/**
 * Construye el registro para la acción "registrar_error" del Apps Script.
 * - Campos estructurados (fase, motivo, pines...) para las columnas F-K de recargas.gs v2.
 * - codigosUsados y urlImagen con el informe completo en texto, para que también quede
 *   legible en las columnas C y E de los Apps Script anteriores.
 */
export function informeError({
  fase, motivo, idPedido, idJugador, paquete,
  referenciaCliente, referenciaCompleta,
  pinesUsados = [], pinesNoUsados = [], estadoNoUsados = null, sinPines = false, noAplica = false,
  estadoPago, comprobante, telefono = '',
}) {
  const partesPines = [];
  if (noAplica) partesPines.push(ESTADO_PINES.noAplica);
  else if (sinPines) partesPines.push(ESTADO_PINES.ninguno);
  else {
    if (pinesUsados.length) partesPines.push(`${ESTADO_PINES.usados}: ${lista(pinesUsados)}`);
    if (pinesNoUsados.length) partesPines.push(`${estadoNoUsados || ESTADO_PINES.retenidos}: ${lista(pinesNoUsados)}`);
    if (!partesPines.length) partesPines.push(ESTADO_PINES.ninguno);
  }
  const estadoPines = partesPines.join(' || ');
  const referencia = referenciaCompleta
    ? `${referenciaCompleta} (el cliente indicó los últimos 5: ${referenciaCliente})`
    : `${referenciaCliente} (últimos 5 dígitos; referencia completa no confirmada)`;
  const urlComprobante = comprobante || 'Sin comprobante';

  const informe = [
    `FASE: ${fase}`,
    `MOTIVO TÉCNICO: ${motivo}`,
    `PINES: ${estadoPines}`,
    `PAGO: ${estadoPago}`,
    `JUGADOR: ${idJugador}`,
    `PAQUETE: ${paquete}`,
    `REFERENCIA: ${referencia}`,
    `PEDIDO: ${idPedido}`,
    `COMPROBANTE: ${urlComprobante}`,
    `WHATSAPP: ${telefono || 'no lo dejó'}`,
  ].join(' | ');

  return {
    accion: 'registrar_error',
    idJugador,
    paquete,
    referencia: referenciaCompleta || referenciaCliente,
    idPedido,
    // Columnas nuevas (recargas.gs v2)
    fase,
    motivo,
    estadoPines,
    estadoPago,
    referenciaDetalle: referencia,
    comprobante: urlComprobante,
    pinesUsados: lista(pinesUsados),
    pinesNoUsados: lista(pinesNoUsados),
    // WhatsApp del cliente ("+58…" o vacío): columna "WhatsApp" de "errores"
    telefono,
    // Columnas clásicas: C (códigos) y E (informe completo)
    codigosUsados: estadoPines,
    urlImagen: informe,
  };
}
