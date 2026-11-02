// =====================================================================
// LEVEL UP - Apps Script de ROBLOX (variable GAS_URL en Vercel). Usado por api/_lib/juegos/roblox.js.
//
// Cómo actualizarlo: pega este archivo en el proyecto de Apps Script de Roblox y luego
// Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva versión" > Implementar.
// Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Pestañas de este libro: "PreciosRoblox" (fila 1 paquetes, fila 2 precios, fila 3 product_id de
// Central One, fila 4 costo USD, fila 5 stock: las llena el menú 🎮 Roblox → 🔄), "Codigos" (una
// columna por paquete), "Exitosas" (A fecha, B usuario, C paquete, D referencia, E código,
// F comprobante, G cobrado Bs, H código de descuento, I id del pedido, J origen del código),
// "pedidos_api" (compras en Central One) y "tasa_dolar" (B1 dólar en Bs, B2 ganancia %).
//
// Códigos: primero se entregan los guardados en "Codigos". Si no queda ninguno y el paquete tiene
// product_id (fila 3), con Vercel nuevo (manda api: true) se compra en Central One:
//   1. Aquí: el pago queda "En proceso" y el pedido en "pedidos_api"; se responde status "comprar".
//   2. Vercel compra el código (variable roblox_nuevo) y espera a que llegue.
//   3. entregar_api: pago(s) "Usado", venta en "Exitosas" y el código para el cliente.
//      liberar_api: no se compró nada; el pago vuelve a "Verificado".
//      Si el código tarda, llega por el aviso de Central One (api/centralone-webhook.js) y "pedidos_api"
//      dice "📲 ENVIAR POR WHATSAPP". Las tres acciones miran el estado de la fila: repetirlas no cambia nada.
// Los pagos se leen de la hoja de pagos compartida (ID_HOJA_PAGOS: C referencia, D monto, E estado).
//
// Seguridad (Configuración del proyecto > Propiedades del script):
//   TOKEN_VERCEL = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel. MUY RECOMENDADO: sin él,
//   cualquiera que conociera la URL /exec podría pedir códigos sin pasar por la tienda (ni por sus
//   límites de intentos) y mandar un precio con descuento inventado. Mientras no exista, no se
//   comprueba (y queda un aviso en el registro de ejecuciones).
//
// Descuentos: Vercel valida el código del cliente y manda "montoACobrar" (precio ya descontado).
// Solo se acepta si es menor que el precio de la hoja y no baja de DESCUENTO_MAXIMO; si no, se
// cobra el precio completo. El uso del código lo anota Vercel en la hoja de recargas de Free Fire.
//
// Stock: obtener_precios devuelve también cuántos códigos quedan de cada paquete. Vercel no se lo
// pasa tal cual al cliente: solo "disponible", "últimos" o "agotado".
//
// Orden de la compra (pensado para que un fallo a mitad nunca cobre sin entregar ni entregue dos
// veces el mismo código):
//   1. Se busca el pago y un código libre (sin tocar nada).
//   2. Se marca el pago "Usado" (comprobando antes que nadie lo usó entretanto).
//   3. Se marca el código "USADO-..." en su celda: ya no se puede entregar a nadie más.
//   4. Se anota la venta en "Exitosas" y se compacta la columna. Si esto falla, el cliente igual
//      recibe su código (el pago ya se gastó) y el detalle queda en el registro de ejecuciones.
//
// Pago insuficiente: si Vercel manda la huella de la clave del cliente, el pago queda "Por completar"
// (ningún juego lo toma) y la compra en la pestaña "por_completar". Con tipo "completar" el cliente
// paga la diferencia: el usuario, el paquete y el precio salen de esa fila, y el código se busca
// ANTES de gastar el pago nuevo. Al entregar, TODOS los pagos quedan "Usado".
// =====================================================================

const ID_HOJA_PAGOS = "1FTjXo7sKybYVmyGO9HBlyla0T2LHBfCB8yHEV70JyOA";
const sheetNameCodigos = "Codigos";
const sheetNameExitosas = "Exitosas";
// Columna K de "Exitosas": WhatsApp del cliente (opcional)
const COLUMNA_WHATSAPP_EXITOSAS = 11;
const sheetNamePreciosRoblox = "PreciosRoblox";

// Vercel espera la compra hasta 45 s: el candado no debe esperar más que eso
const ESPERA_CANDADO_MS = 25000;
// Diferencia que se tolera entre lo pagado y el precio (redondeos del banco), igual que Free Fire
const TOLERANCIA_BS = 0.50;
// Ningún descuento puede dejar el paquete por debajo de este % de su precio (freno ante abusos)
const DESCUENTO_MAXIMO = 0.5;
// Marca de los códigos ya entregados que todavía no se quitaron de la columna
const PREFIJO_USADO = "USADO-";

// --- Pagos por completar (el cliente pagó menos y paga la diferencia con otro pago) ---
// Una fila por pedido en este libro. N = huella SHA-256 de la clave del cliente (la clave nunca llega a
// la hoja). El pago que no alcanzó queda "Por completar" en la hoja de pagos: ningún juego lo toma.
const HOJA_POR_COMPLETAR = "por_completar";
const COLUMNAS_POR_COMPLETAR = ["fecha-hora", "id pedido", "usuario", "paquete", "precio (Bs)", "pagado (Bs)", "falta (Bs)",
  "referencias", "código descuento", "comprobante", "estado", "pedido que completó", "actualizado", "clave (huella)", "vence", "WhatsApp"];
const ESTADO_PAGO_POR_COMPLETAR = "Por completar";
const HORAS_PARA_COMPLETAR = 48;
const MAX_PAGOS_POR_PEDIDO = 4;

// --- Central One (cuando no quedan códigos guardados) ---
const URL_CENTRALONE = "https://portal.centraloneglobal.com/api/v1";
// Llave SOLO con catalog:read, para el menú 🔄 (la que compra vive en Vercel, variable roblox_nuevo)
const PROPIEDAD_LLAVE_CENTRALONE = "CENTRALONE_API_KEY";
// Regiones de las tarjetas que se traen: GLOBAL y Estados Unidos (Central One la escribe de varias formas).
// Si no hay ninguna, el 🔄 avisa qué regiones hay sin tocar la hoja. Solo tarjetas de Robux con stock:
// las de saldo en USD y las agotadas no se traen. Las de EE. UU. llevan SUFIJO_EEUU en el nombre
// ("800 Robux EE. UU.") y las GLOBAL no ("800 Robux"): así son paquetes distintos (ver claveDePaquete).
const REGIONES_ROBLOX = ["GLOBAL", "US", "USA", "UNITED STATES"];
const SUFIJO_EEUU = "EE. UU.";
const FILA_PRODUCTO = 3;
const FILA_COSTO = 4;
const HOJA_TASA = "tasa_dolar";
const GANANCIA_INICIAL = 4;
const PRODUCTO_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// idPedido que genera Vercel (api/_lib/juegos/roblox.js): es la Idempotency-Key en Central One
const PEDIDO_API_VALIDO = /^rbx-[0-9a-f-]{36}$/;
const HOJA_PEDIDOS_API = "pedidos_api";
const COLUMNAS_PEDIDOS_API = ["fecha-hora", "id pedido", "usuario", "paquete", "cobrado (Bs)", "referencias", "código descuento",
  "comprobante", "product_id", "estado", "pedido Central One", "código entregado", "actualizado", "datos internos (no tocar)", "WhatsApp"];
// Columna N (datos internos): "WhatsApp" (O) va después, así las filas anteriores no se mueven
const COLUMNA_DATOS_INTERNOS_API = 14;
// Columna J (estado). Empieza por ⏳ mientras se compra: solo entonces entregar_api y liberar_api cambian algo.
const ESTADO_COMPRANDO = "⏳ COMPRANDO EN CENTRAL ONE";
const ESTADO_ENTREGADO_PAGINA = "✅ ENTREGADO EN LA PÁGINA";
const ESTADO_ENTREGADO_WHATSAPP = "📲 ENVIAR POR WHATSAPP: el código llegó cuando el cliente ya no esperaba en la página";
const ESTADO_LIBERADO = "↩️ NO SE COMPRÓ (pago liberado): ";
// Los avisos de Central One esperan como mucho 10 s: el candado no puede esperar más
const ESPERA_CANDADO_AVISO_MS = 5000;

function doPost(e) {
  var datos;
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return responder({ status: "error", message: "No se recibieron datos válidos." });
  }
  if (!datos || typeof datos !== "object") {
    return responder({ status: "error", message: "No se recibieron datos válidos." });
  }

  // Solo Vercel puede pedir precios o comprar (si la propiedad TOKEN_VERCEL existe)
  var token = PropertiesService.getScriptProperties().getProperty("TOKEN_VERCEL");
  if (token) {
    if (!mismoTexto(String(datos.token || ""), token)) {
      return responder({ status: "error", message: "No autorizado" });
    }
  } else {
    console.warn("Roblox: falta la propiedad TOKEN_VERCEL; cualquiera con la URL /exec puede usar este script");
  }

  try {
    // Leer precios no toca pagos ni códigos: no espera el candado
    if (datos.tipo === "obtener_precios") return obtenerPrecios();
    var acciones = {
      compra: procesarPagoYExtraerCodigo, verificacion: procesarPagoYExtraerCodigo, completar: completarCompra,
      entregar_api: entregarApi, liberar_api: liberarApi, nota_api: notaApi
    };
    if (!Object.prototype.hasOwnProperty.call(acciones, String(datos.tipo))) {
      return responder({ status: "error", message: "Tipo de solicitud no válido." });
    }

    // 🛡️ Candado: una sola compra de Roblox a la vez (también al completar un pago o anotar Central One)
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(datos.aviso === true ? ESPERA_CANDADO_AVISO_MS : ESPERA_CANDADO_MS)) {
      return responder({ status: "error", ocupado: true, message: "⚠️ El servidor está procesando otra compra en este momento. Inténtalo de nuevo en unos segundos." });
    }
    try {
      return responder(acciones[datos.tipo](datos));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    // El detalle va al registro de ejecuciones, nunca al cliente
    console.error("Error en Roblox: " + (error && error.stack || error));
    return responder({ status: "error", message: "Error interno al procesar la compra. Intenta de nuevo en unos segundos." });
  }
}

function procesarPagoYExtraerCodigo(datos) {
  var referencia = String(datos.referencia || "").replace(/\s+/g, "");
  var paquete = String(datos.producto || "").trim();
  var usuario = String(datos.user || datos.usuario || "").trim();
  var urlCapture = String(datos.url_capture || "Sin comprobante");
  var idPedido = String(datos.idPedido || "").slice(0, 60);
  // WhatsApp del cliente (opcional): va a "Exitosas", "por_completar" y "pedidos_api"
  var telefono = enlaceWhatsapp(datos.telefono);

  if (!/^\d{5}$/.test(referencia)) {
    return { status: "error", message: "⚠️ Ingresa una referencia válida de 5 dígitos." };
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(usuario) || !paquete || paquete.length > 60) {
    return { status: "error", message: "⚠️ Datos de la compra incompletos." };
  }

  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var numeroPaquete = claveDePaquete(paquete);
  if (!numeroPaquete) return { status: "error", message: "⚠️ Paquete no reconocido." };

  // ---- Precio del paquete (obligatorio: sin precio en la hoja no se vende) ----
  var precioOficial = precioDePaquete(libro, numeroPaquete);
  if (!(precioOficial > 0)) {
    console.error("Roblox: el paquete '" + paquete + "' no tiene precio en " + sheetNamePreciosRoblox);
    return { status: "error", message: "⚠️ Este paquete no está disponible en este momento." };
  }

  // ---- Precio a cobrar: con descuento solo si es razonable ----
  var precioACobrar = precioOficial;
  var codigoDescuento = "";
  if (datos.montoACobrar !== undefined && datos.montoACobrar !== null && datos.montoACobrar !== "") {
    var conDescuento = limpiarMontoVES(datos.montoACobrar);
    if (conDescuento > 0 && conDescuento <= precioOficial && conDescuento >= precioOficial * (1 - DESCUENTO_MAXIMO)) {
      precioACobrar = conDescuento;
      codigoDescuento = String(datos.codigoDescuento || "").slice(0, 30);
    } else {
      console.error("Roblox: montoACobrar fuera de rango (" + datos.montoACobrar + " para " + precioOficial + "); se cobra el precio completo");
    }
  }

  // ---- Pestañas de este libro (antes de tocar nada). "Codigos" es opcional: sin ella, todo se compra en Central One ----
  var hojaCodigos = libro.getSheetByName(sheetNameCodigos);
  var hojaExitosas = libro.getSheetByName(sheetNameExitosas);
  if (!hojaExitosas) {
    console.error("Roblox: falta la pestaña '" + sheetNameExitosas + "'");
    return { status: "error", message: "⚠️ La tienda de Roblox no está disponible en este momento." };
  }

  // ---- Buscar el pago ----
  var hojaPagos = abrirHojaPagos();
  if (!hojaPagos) {
    return { status: "error", message: "⚠️ No pudimos revisar tu pago en este momento. Intenta de nuevo en unos segundos." };
  }
  var pago = buscarPagoLibre(hojaPagos, referencia);
  if (pago.filaPago === -1) return { status: "error", message: mensajePagoNoDisponible(pago) };
  var filaPago = pago.filaPago, montoPagado = pago.montoPagado;

  if (montoPagado < precioACobrar - TOLERANCIA_BS) {
    var insuficiente = {
      status: "error", insuficiente: true, montoPagado: montoPagado, precioOficial: precioACobrar,
      message: "Pago insuficiente: encontramos " + formatoBs(montoPagado) + ", pero este paquete cuesta " + formatoBs(precioACobrar) + "."
    };
    // Vercel manda la huella de la clave del cliente: el pago queda "Por completar" y el pedido en
    // "por_completar" para que pague la diferencia (sin huella, como antes: el pago no se toca)
    var claveHash = String(datos.claveHash || "");
    if (/^[a-f0-9]{64}$/.test(claveHash) && idPedido && !buscarFilaPorCompletar(14, claveHash)) {
      var celdaPago = hojaPagos.getRange(filaPago, 5);
      var estadoPago = String(celdaPago.getValue()).trim().toLowerCase();
      if (estadoPago === "verificado" || estadoPago === "") {
        celdaPago.setValue(ESTADO_PAGO_POR_COMPLETAR);
        var falta = redondear2(precioACobrar - montoPagado);
        var fechaHora = ahora();
        hojaPorCompletar().appendRow([
          fechaHora, textoSeguro(idPedido), textoSeguro(usuario), textoSeguro(paquete), precioACobrar, montoPagado, falta,
          pago.referencia, textoSeguro(codigoDescuento), textoSeguro(urlCapture), "PENDIENTE: faltan " + formatoBs(falta), "",
          fechaHora, claveHash, new Date(Date.now() + HORAS_PARA_COMPLETAR * 3600 * 1000), telefono
        ]);
        SpreadsheetApp.flush();
        insuficiente.porCompletar = true;
        insuficiente.falta = falta;
        insuficiente.horas = HORAS_PARA_COMPLETAR;
        insuficiente.message += " Faltan " + formatoBs(falta) + ": paga la diferencia y escribe la nueva referencia para completar tu compra.";
      }
    }
    return insuficiente;
  }

  // ---- Buscar un código libre (todavía sin tocarlo) ----
  // Un paquete que solo viene de Central One puede no tener columna en "Codigos"
  var col = columnaDePaquete(hojaCodigos, numeroPaquete);
  var libre = col === -1 ? { codigo: null, fila: -1 } : buscarCodigoLibre(hojaCodigos, col);
  var codigo = libre.codigo, filaCodigo = libre.fila;
  if (!codigo) {
    // Sin códigos guardados: se compra en Central One (si Vercel puede y el paquete tiene product_id)
    var productoApi = datos.api === true ? productoDePaquete(libro, numeroPaquete) : "";
    if (!productoApi && col === -1) return { status: "error", message: "⚠️ Paquete no reconocido en el inventario de códigos." };
    if (!productoApi) return { status: "error", agotado: true, message: "⚠️ Este paquete se acaba de agotar. Elige otro o escríbenos por WhatsApp." };
    return reservarParaCentralOne({
      hojaPagos: hojaPagos, filaPago: filaPago, idPedido: idPedido, usuario: usuario, paquete: paquete,
      precio: precioACobrar, codigoDescuento: codigoDescuento, urlCapture: urlCapture, productId: productoApi,
      pagos: [pago.referencia], porCompletar: null, telefono: telefono
    });
  }

  // ---- Gastar el pago ----
  // Justo antes, se vuelve a leer su estado: Free Fire y Blood Strike usan la misma hoja con su
  // propio candado, así que pudo cambiar mientras se buscaba el código.
  var celdaEstado = hojaPagos.getRange(filaPago, 5);
  var estadoAhora = String(celdaEstado.getValue()).trim().toLowerCase();
  if (estadoAhora !== "verificado" && estadoAhora !== "") {
    return { status: "error", message: "⚠️ Ese pago se acaba de usar en otra recarga." };
  }
  celdaEstado.setValue("Usado");
  SpreadsheetApp.flush();

  entregarCodigo({
    hojaCodigos: hojaCodigos, hojaExitosas: hojaExitosas, col: col, filaCodigo: filaCodigo, codigo: codigo,
    usuario: usuario, paquete: paquete, referencia: referencia, urlCapture: urlCapture,
    precioACobrar: precioACobrar, codigoDescuento: codigoDescuento, idPedido: idPedido, telefono: telefono
  });
  return { status: "success", code: codigo, message: "¡Código canjeado con éxito!" };
}

// Pasos 3 y 4 de la compra, con el pago (o los pagos) ya "Usado": marca el código, anota la venta
// en "Exitosas" y compacta la columna. Un fallo aquí nunca deja al cliente sin su código.
function entregarCodigo(c) {
  var hojaCodigos = c.hojaCodigos, hojaExitosas = c.hojaExitosas, col = c.col, filaCodigo = c.filaCodigo, codigo = c.codigo;
  var usuario = c.usuario, paquete = c.paquete, referencia = c.referencia, urlCapture = c.urlCapture;
  var precioACobrar = c.precioACobrar, codigoDescuento = c.codigoDescuento, idPedido = c.idPedido;

  // ---- Marcar el código como entregado: desde aquí nadie más puede recibirlo ----
  try {
    hojaCodigos.getRange(filaCodigo, col).setValue(PREFIJO_USADO + codigo);
    SpreadsheetApp.flush();
  } catch (err) {
    // El pago ya se gastó: el cliente recibe su código igual. Hay que marcarlo a mano.
    console.error("Roblox: NO se pudo marcar como usado el código de la fila " + filaCodigo + " (columna " + col +
      ") entregado a " + usuario + " (ref " + referencia + "). Quítalo a mano del inventario. " + err);
  }

  // ---- Registro y limpieza: un fallo aquí nunca deja al cliente sin su código ----
  anotarExitosa(hojaExitosas, c, "Inventario (Codigos)");
  try {
    quitarCodigoDeLaColumna(hojaCodigos, col, filaCodigo);
  } catch (err) {
    // Queda la marca USADO-...: no se vuelve a entregar, solo ocupa una celda
    console.error("Roblox: no se pudo compactar la columna " + col + " de Codigos: " + err);
  }
  SpreadsheetApp.flush();
}

// Una fila de "Exitosas" por venta. Si falla, el cliente igual recibe su código: queda en el registro.
// c: { usuario, paquete, referencia, codigo, urlCapture, precioACobrar, codigoDescuento, idPedido, telefono }
function anotarExitosa(hojaExitosas, c, origen) {
  try {
    // La columna J es nueva: se le pone título la primera vez
    if (!String(hojaExitosas.getRange(1, 10).getValue()).trim()) hojaExitosas.getRange(1, 10).setValue("origen del código");
    asegurarTituloWhatsapp(hojaExitosas, COLUMNA_WHATSAPP_EXITOSAS);
    hojaExitosas.appendRow([
      ahora(),                            // A: fecha
      textoSeguro(c.usuario),             // B: usuario
      textoSeguro(c.paquete),             // C: paquete
      textoSeguro(c.referencia),          // D: referencia
      textoSeguro(c.codigo),              // E: código entregado
      textoSeguro(c.urlCapture),          // F: comprobante
      c.precioACobrar,                    // G: cobrado (Bs)
      textoSeguro(c.codigoDescuento),     // H: código de descuento ("" si no usó)
      textoSeguro(c.idPedido),            // I: id del pedido en Vercel
      textoSeguro(origen),                // J: de dónde salió el código
      enlaceWhatsapp(c.telefono)          // K: WhatsApp del cliente (opcional)
    ]);
  } catch (err) {
    console.error("Roblox: venta entregada pero NO anotada en Exitosas | usuario " + c.usuario + " | " + c.paquete +
      " | ref " + c.referencia + " | código " + c.codigo + " | " + c.precioACobrar + " Bs | " + err);
  }
}

// Completar un pago insuficiente (tipo "completar", con candado). Vercel manda la huella de la clave
// del cliente, los últimos 5 del pago nuevo y un idPedido. El usuario, el paquete y el precio salen
// de "por_completar". Si ya alcanza, el código se busca ANTES de gastar el pago nuevo.
function completarCompra(datos) {
  var claveHash = String(datos.claveHash || "");
  var referencia = String(datos.referencia || "").replace(/\s+/g, "");
  var idPedido = String(datos.idPedido || "").slice(0, 60);
  var noValido = function (mensaje) { return { status: "error", complementoInvalido: true, message: mensaje }; };
  if (!/^[a-f0-9]{64}$/.test(claveHash) || !/^\d{5}$/.test(referencia) || !idPedido) {
    return noValido("Datos inválidos para completar el pago.");
  }

  var fila = buscarFilaPorCompletar(14, claveHash);
  if (!fila) return noValido("No encontramos este pago por completar. Escríbenos por WhatsApp con tus referencias.");
  var hojaPc = hojaPorCompletar();
  var v = hojaPc.getRange(fila, 1, 1, COLUMNAS_POR_COMPLETAR.length).getValues()[0];
  if (String(v[10]).indexOf("PENDIENTE") !== 0) {
    return noValido("Este pago ya se completó o está en revisión. Si no recibiste tu código, escríbenos por WhatsApp.");
  }
  var vence = v[14] instanceof Date ? v[14].getTime() : new Date(v[14]).getTime();
  if (vence && Date.now() > vence) {
    hojaPc.getRange(fila, 11).setValue("⌛ VENCIDO: resolver por WhatsApp");
    hojaPc.getRange(fila, 13).setValue(ahora());
    return noValido("Pasaron más de " + HORAS_PARA_COMPLETAR + " horas: escríbenos por WhatsApp con tus referencias para completar tu compra.");
  }
  var referencias = String(v[7]).split(" + ").filter(function (r) { return r; });
  if (referencias.length >= MAX_PAGOS_POR_PEDIDO) {
    return noValido("Ya usaste el máximo de " + MAX_PAGOS_POR_PEDIDO + " pagos para esta compra: escríbenos por WhatsApp.");
  }

  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hojaCodigos = libro.getSheetByName(sheetNameCodigos);
  var hojaExitosas = libro.getSheetByName(sheetNameExitosas);
  var hojaPagos = abrirHojaPagos();
  if (!hojaExitosas || !hojaPagos) {
    return { status: "error", message: "⚠️ No pudimos revisar tu pago en este momento. Intenta de nuevo en unos segundos." };
  }

  var pago = buscarPagoLibre(hojaPagos, referencia);
  if (pago.filaPago === -1) return { status: "error", message: mensajePagoNoDisponible(pago) };

  var usuario = String(v[2]), paquete = String(v[3]);
  // El WhatsApp que dejó en el primer pago o, si no dejó, el que manda ahora
  var telefono = enlaceWhatsapp(v[15]) || enlaceWhatsapp(datos.telefono);
  var precio = limpiarMontoVES(v[4]);
  var pagado = redondear2(limpiarMontoVES(v[5]) + pago.montoPagado);
  var falta = redondear2(Math.max(0, precio - pagado));
  var celdaPago = hojaPagos.getRange(pago.filaPago, 5);
  var estadoAhora = String(celdaPago.getValue()).trim().toLowerCase();
  if (estadoAhora !== "verificado" && estadoAhora !== "") {
    return { status: "error", message: "⚠️ Ese pago se acaba de usar en otra recarga." };
  }

  if (pagado < precio - TOLERANCIA_BS) {
    // Tampoco alcanza: este pago también queda "Por completar" y la compra sigue pendiente
    celdaPago.setValue(ESTADO_PAGO_POR_COMPLETAR);
    referencias.push(pago.referencia);
    hojaPc.getRange(fila, 6, 1, 3).setValues([[pagado, falta, referencias.join(" + ")]]);
    hojaPc.getRange(fila, 11).setValue("PENDIENTE: faltan " + formatoBs(falta));
    hojaPc.getRange(fila, 13).setValue(ahora());
    SpreadsheetApp.flush();
    return {
      status: "error", insuficiente: true, porCompletar: true, montoPagado: pagado, precioOficial: precio, falta: falta,
      horas: HORAS_PARA_COMPLETAR,
      message: "Pago insuficiente: con este pago llevas " + formatoBs(pagado) + " y faltan " + formatoBs(falta) + ". Paga la diferencia y escribe la nueva referencia."
    };
  }

  // Alcanza: primero el código (si se agotó, el pago nuevo NO se toca y la compra sigue pendiente)
  var col = columnaDePaquete(hojaCodigos, claveDePaquete(paquete));
  var libre = col === -1 ? { codigo: null } : buscarCodigoLibre(hojaCodigos, col);
  var productoApi = !libre.codigo && datos.api === true ? productoDePaquete(libro, claveDePaquete(paquete)) : "";
  if (productoApi) {
    // Sin códigos guardados: se compra en Central One. La fila de "por_completar" queda "⏳" (no se puede
    // completar dos veces) y entregar_api la cierra; si no se compra, liberar_api le devuelve su estado.
    var todas = referencias.concat([pago.referencia]);
    var estadoAnterior = String(v[10]);
    var reserva = reservarParaCentralOne({
      hojaPagos: hojaPagos, filaPago: pago.filaPago, idPedido: idPedido, usuario: usuario, paquete: paquete,
      precio: precio, codigoDescuento: String(v[8] || ""), urlCapture: String(v[9] || "Sin comprobante"), productId: productoApi,
      pagos: todas, porCompletar: { claveHash: claveHash, pagado: pagado, falta: falta, estadoAnterior: estadoAnterior },
      telefono: telefono
    });
    if (reserva.status === "comprar") {
      hojaPc.getRange(fila, 11).setValue("⏳ COMPRANDO EN CENTRAL ONE (pedido " + idPedido + ")");
      hojaPc.getRange(fila, 13).setValue(ahora());
      SpreadsheetApp.flush();
    }
    return reserva;
  }
  if (!libre.codigo) {
    console.error("Roblox: pago completado pero sin códigos de '" + paquete + "' (fila " + fila + " de por_completar)");
    return { status: "error", agotado: true, message: "⚠️ Este paquete se agotó justo ahora. Tu pago anterior sigue guardado: escríbenos por WhatsApp y te lo entregamos." };
  }

  // Gastar TODOS los pagos de esta compra
  celdaPago.setValue("Usado");
  referencias.forEach(function (ref) { marcarPagoUsado(hojaPagos, ref); });
  referencias.push(pago.referencia);
  SpreadsheetApp.flush();
  hojaPc.getRange(fila, 6, 1, 3).setValues([[pagado, falta, referencias.join(" + ")]]);
  hojaPc.getRange(fila, 11, 1, 3).setValues([["✅ COMPLETADO Y ENTREGADO", textoSeguro(idPedido), ahora()]]);

  var codigoDescuento = String(v[8] || "");
  entregarCodigo({
    hojaCodigos: hojaCodigos, hojaExitosas: hojaExitosas, col: col, filaCodigo: libre.fila, codigo: libre.codigo,
    usuario: usuario, paquete: paquete, referencia: referencias.join(" + "), urlCapture: String(v[9] || "Sin comprobante"),
    precioACobrar: precio, codigoDescuento: codigoDescuento, idPedido: idPedido, telefono: telefono
  });
  // usuario, precio y código de descuento: para que Vercel anote el uso del código (no llegan al cliente)
  return { status: "success", code: libre.codigo, message: "¡Código canjeado con éxito!", usuario: usuario, precio: precio, codigoDescuento: codigoDescuento };
}

// =====================================================================
// COMPRA EN CENTRAL ONE (sin códigos guardados). Ver el orden al principio del archivo.
// =====================================================================

// Paso 1: el pago queda "En proceso" (ningún juego lo toma) y el pedido en "pedidos_api".
// c: { hojaPagos, filaPago, idPedido, usuario, paquete, precio, codigoDescuento, urlCapture, productId,
//      pagos (referencias completas que se gastan al entregar), porCompletar (null o datos del pago completado),
//      telefono (enlace de WhatsApp o "") }
function reservarParaCentralOne(c) {
  if (!PEDIDO_API_VALIDO.test(c.idPedido) || buscarFilaPedidoApi(c.idPedido)) {
    console.error("Roblox: idPedido inválido o repetido para comprar en Central One: " + c.idPedido);
    return { status: "error", agotado: true, message: "⚠️ Este paquete se acaba de agotar. Elige otro o escríbenos por WhatsApp." };
  }
  // Justo antes, se vuelve a leer el estado del pago (Free Fire y Blood Strike usan la misma hoja)
  var celda = c.hojaPagos.getRange(c.filaPago, 5);
  var estado = String(celda.getValue()).trim().toLowerCase();
  if (estado !== "verificado" && estado !== "") {
    return { status: "error", message: "⚠️ Ese pago se acaba de usar en otra recarga." };
  }
  var enProceso = c.pagos[c.pagos.length - 1];
  celda.setValue("En proceso");
  SpreadsheetApp.flush();
  hojaPedidosApi().appendRow([
    ahora(), textoSeguro(c.idPedido), textoSeguro(c.usuario), textoSeguro(c.paquete), c.precio, c.pagos.join(" + "),
    textoSeguro(c.codigoDescuento), textoSeguro(c.urlCapture), textoSeguro(c.productId), ESTADO_COMPRANDO, "", "", ahora(),
    JSON.stringify({ enProceso: enProceso, pagos: c.pagos, porCompletar: c.porCompletar }),
    c.telefono || ""
  ]);
  SpreadsheetApp.flush();
  return { status: "comprar", productId: c.productId, idPedido: c.idPedido, usuario: c.usuario };
}

// Paso 3 (Vercel con el código, o el aviso de Central One): pago(s) "Usado" y venta en "Exitosas".
// { idPedido, codigo, ordenCentralOne, enPagina (true = el cliente lo vio en la página) }
function entregarApi(datos) {
  var idPedido = String(datos.idPedido || "");
  var codigo = String(datos.codigo || "").trim();
  var ordenCO = String(datos.ordenCentralOne || "").slice(0, 80);
  if (!PEDIDO_API_VALIDO.test(idPedido) || !codigo || codigo.length > 200) return { status: "error", message: "Datos inválidos." };
  var hoja = hojaPedidosApi();
  var fila = buscarFilaPedidoApi(idPedido);
  if (!fila) return { status: "error", message: "Pedido no encontrado en " + HOJA_PEDIDOS_API + "." };
  var v = hoja.getRange(fila, 1, 1, COLUMNAS_PEDIDOS_API.length).getValues()[0];
  var estado = String(v[9]);
  var resumen = { usuario: String(v[2]), precio: limpiarMontoVES(v[4]), codigoDescuento: String(v[6] || "") };

  // Ya entregado (aviso repetido, o Vercel y el aviso a la vez): no se gasta ni se anota dos veces
  if (estado.indexOf(ESTADO_ENTREGADO_PAGINA) === 0 || estado.indexOf(ESTADO_ENTREGADO_WHATSAPP) === 0) {
    if (datos.enPagina === true && estado.indexOf(ESTADO_ENTREGADO_WHATSAPP) === 0) {
      hoja.getRange(fila, 10).setValue(ESTADO_ENTREGADO_PAGINA);
      hoja.getRange(fila, 13).setValue(ahora());
    }
    return { status: "success", yaEntregado: true, code: String(v[11]), usuario: resumen.usuario, precio: resumen.precio, codigoDescuento: resumen.codigoDescuento };
  }
  if (estado.indexOf("⏳") !== 0) {
    // El pago ya se había liberado (Central One avisó que falló) y después entregó: el pago NO se toca
    hoja.getRange(fila, 10, 1, 4).setValues([["⚠️ CENTRAL ONE ENTREGÓ DESPUÉS DE LIBERAR EL PAGO: revisar si el cliente volvió a usar su pago; el código está en la columna L",
      textoSeguro(ordenCO), textoSeguro(codigo), ahora()]]);
    SpreadsheetApp.flush();
    console.error("Roblox: Central One entregó el pedido " + idPedido + " (" + ordenCO + ") después de liberar el pago. Revisar " + HOJA_PEDIDOS_API + ".");
    return { status: "success", yaEntregado: true, code: codigo };
  }

  var interno = leerDatosInternos(v[13]);
  var hojaPagos = abrirHojaPagos();
  var hojaExitosas = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetNameExitosas);
  // Sin la hoja de pagos no se anota nada: "ocupado" para que el aviso se repita más tarde
  if (!hojaPagos || !hojaExitosas) return { status: "error", ocupado: true, message: "No se pudo abrir la hoja de pagos o Exitosas." };

  (interno.pagos || []).forEach(function (ref) { marcarPagoUsado(hojaPagos, String(ref)); });
  SpreadsheetApp.flush();
  hoja.getRange(fila, 10, 1, 4).setValues([[datos.enPagina === true ? ESTADO_ENTREGADO_PAGINA : ESTADO_ENTREGADO_WHATSAPP,
    textoSeguro(ordenCO), textoSeguro(codigo), ahora()]]);

  var pc = interno.porCompletar;
  if (pc) {
    var filaPc = buscarFilaPorCompletar(14, pc.claveHash);
    if (filaPc) {
      var hojaPc = hojaPorCompletar();
      hojaPc.getRange(filaPc, 6, 1, 3).setValues([[pc.pagado, pc.falta, (interno.pagos || []).join(" + ")]]);
      hojaPc.getRange(filaPc, 11, 1, 3).setValues([["✅ COMPLETADO Y ENTREGADO", textoSeguro(idPedido), ahora()]]);
    }
  }
  anotarExitosa(hojaExitosas, {
    usuario: v[2], paquete: v[3], referencia: v[5], codigo: codigo, urlCapture: v[7],
    precioACobrar: v[4], codigoDescuento: v[6], idPedido: idPedido, telefono: v[14]
  }, "Central One " + ordenCO);
  SpreadsheetApp.flush();
  return { status: "success", yaEntregado: false, code: codigo, usuario: resumen.usuario, precio: resumen.precio, codigoDescuento: resumen.codigoDescuento };
}

// No se compró nada en Central One: el pago vuelve a "Verificado" (sirve para otra compra). { idPedido, motivo }
function liberarApi(datos) {
  var idPedido = String(datos.idPedido || "");
  if (!PEDIDO_API_VALIDO.test(idPedido)) return { status: "error", message: "Datos inválidos." };
  var hoja = hojaPedidosApi();
  var fila = buscarFilaPedidoApi(idPedido);
  if (!fila) return { status: "error", message: "Pedido no encontrado en " + HOJA_PEDIDOS_API + "." };
  var v = hoja.getRange(fila, 1, 1, COLUMNAS_PEDIDOS_API.length).getValues()[0];
  var estado = String(v[9]);
  if (estado.indexOf("⏳") !== 0) {
    // Ya entregado o ya liberado: no se toca (un aviso viejo que llega tarde)
    var entregado = estado.indexOf(ESTADO_ENTREGADO_PAGINA) === 0 || estado.indexOf(ESTADO_ENTREGADO_WHATSAPP) === 0;
    return entregado ? { status: "error", yaEntregado: true, message: "El pedido ya se entregó." } : { status: "success", sinCambios: true };
  }
  var hojaPagos = abrirHojaPagos();
  if (!hojaPagos) return { status: "error", ocupado: true, message: "No se pudo abrir la hoja de pagos." };

  var interno = leerDatosInternos(v[13]);
  if (interno.enProceso && !cambiarEstadoPago(hojaPagos, String(interno.enProceso), "en proceso", "Verificado")) {
    console.warn("Roblox: al liberar el pedido " + idPedido + " el pago " + interno.enProceso + " ya no estaba \"En proceso\"");
  }
  // Pago completado: la fila de "por_completar" vuelve a estar pendiente (el cliente puede intentarlo de nuevo)
  var pc = interno.porCompletar;
  if (pc) {
    var filaPc = buscarFilaPorCompletar(14, pc.claveHash);
    if (filaPc) {
      hojaPorCompletar().getRange(filaPc, 11).setValue(textoSeguro(pc.estadoAnterior || ("PENDIENTE: faltan " + formatoBs(pc.falta))));
      hojaPorCompletar().getRange(filaPc, 13).setValue(ahora());
    }
  }
  hoja.getRange(fila, 10).setValue(textoSeguro(ESTADO_LIBERADO + String(datos.motivo || "sin motivo").slice(0, 400)));
  hoja.getRange(fila, 13).setValue(ahora());
  SpreadsheetApp.flush();
  return { status: "success" };
}

// Nota en el estado de "pedidos_api". { idPedido, texto, siempre }: sin "siempre", solo mientras sigue ⏳
// (lo que Vercel sabe cuando el código tarda); con "siempre", se agrega al estado que tenga (avisos).
function notaApi(datos) {
  var idPedido = String(datos.idPedido || "");
  var texto = String(datos.texto || "").slice(0, 400);
  if (!PEDIDO_API_VALIDO.test(idPedido) || !texto) return { status: "error", message: "Datos inválidos." };
  var hoja = hojaPedidosApi();
  var fila = buscarFilaPedidoApi(idPedido);
  if (!fila) return { status: "error", message: "Pedido no encontrado en " + HOJA_PEDIDOS_API + "." };
  var estado = String(hoja.getRange(fila, 10).getValue());
  if (datos.siempre === true) {
    hoja.getRange(fila, 10).setValue(textoSeguro((estado + " · " + texto).slice(0, 1000)));
  } else if (estado.indexOf("⏳") === 0) {
    hoja.getRange(fila, 10).setValue(textoSeguro("⏳ " + texto));
  } else {
    return { status: "success", sinCambios: true };
  }
  hoja.getRange(fila, 13).setValue(ahora());
  SpreadsheetApp.flush();
  return { status: "success" };
}

function hojaPedidosApi() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(HOJA_PEDIDOS_API);
  if (!hoja) {
    hoja = libro.insertSheet(HOJA_PEDIDOS_API);
    hoja.appendRow(COLUMNAS_PEDIDOS_API);
    hoja.getRange(1, 1, 1, COLUMNAS_PEDIDOS_API.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
    hoja.getRange(1, COLUMNA_DATOS_INTERNOS_API).setNote("Lo usa el script para entregar o liberar el pago. No lo cambies.");
  }
  asegurarTituloWhatsapp(hoja, COLUMNAS_PEDIDOS_API.length);
  return hoja;
}

// Fila (la más reciente) de "pedidos_api" con ese idPedido. 0 si no está.
function buscarFilaPedidoApi(idPedido) {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_PEDIDOS_API);
  if (!idPedido || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, 2, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(idPedido)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
}

function leerDatosInternos(valor) {
  try {
    var d = JSON.parse(String(valor || "{}"));
    return d && typeof d === "object" ? d : {};
  } catch (err) {
    console.error("Roblox: columna 'datos internos' ilegible en " + HOJA_PEDIDOS_API + ": " + err);
    return {};
  }
}

// Cambia el estado del pago con esa referencia completa (la fila más reciente) solo si está en "desde"
function cambiarEstadoPago(hojaPagos, referencia, desde, hacia) {
  var ultima = hojaPagos.getLastRow();
  var filas = ultima > 1 ? hojaPagos.getRange(2, 3, ultima - 1, 3).getValues() : [];
  for (var i = filas.length - 1; i >= 0; i--) {
    if (String(filas[i][0]).replace(/\s+/g, "") !== referencia) continue;
    if (String(filas[i][2]).trim().toLowerCase() !== desde) return false;
    hojaPagos.getRange(i + 2, 5).setValue(hacia);
    SpreadsheetApp.flush();
    return true;
  }
  return false;
}

// product_id de Central One del paquete (fila 3 de "PreciosRoblox"). "" si no tiene uno válido.
function productoDePaquete(libro, numeroPaquete) {
  var hoja = libro.getSheetByName(sheetNamePreciosRoblox);
  if (!hoja || !numeroPaquete || hoja.getLastColumn() < 1) return "";
  var filas = hoja.getRange(1, 1, FILA_PRODUCTO, hoja.getLastColumn()).getValues();
  for (var p = 0; p < filas[0].length; p++) {
    if (claveDePaquete(filas[0][p]) !== numeroPaquete) continue;
    var producto = String(filas[FILA_PRODUCTO - 1][p]).trim();
    return PRODUCTO_VALIDO.test(producto) ? producto : "";
  }
  return "";
}

// Pestaña "pagos" de la hoja compartida. null (y aviso en el registro) si no se puede abrir.
function abrirHojaPagos() {
  var hojaPagos = null;
  try {
    var libroPagos = SpreadsheetApp.openById(ID_HOJA_PAGOS);
    // Solo la pestaña "pagos": antes, si no existía, se usaba la primera pestaña del libro
    hojaPagos = libroPagos.getSheetByName("pagos") || libroPagos.getSheetByName("Pagos");
  } catch (err) {
    console.error("Roblox: no se pudo abrir la hoja de pagos: " + err);
  }
  if (!hojaPagos) console.error("Roblox: no se encontró la pestaña 'pagos' en la hoja " + ID_HOJA_PAGOS);
  return hojaPagos;
}

// De abajo hacia arriba, el pago disponible más reciente con esos 5 dígitos exactos.
// Se saltan los "Usado" (un pago viejo no bloquea uno nuevo), los "En proceso" (otra tienda lo está
// usando) y los "Por completar" (esperan la diferencia). Solo se leen las columnas A-E.
// { filaPago (-1 si no hay), montoPagado, referencia, hayUsado, hayEnProceso, hayPorCompletar }
function buscarPagoLibre(hojaPagos, referencia) {
  var ultimaPago = hojaPagos.getLastRow();
  var filas = ultimaPago > 1 ? hojaPagos.getRange(2, 1, ultimaPago - 1, 5).getValues() : [];
  var r = { filaPago: -1, montoPagado: 0, referencia: "", hayUsado: false, hayEnProceso: false, hayPorCompletar: false };
  for (var i = filas.length - 1; i >= 0; i--) {
    var refCompleta = String(filas[i][2]).replace(/\s+/g, "");
    if (!refCompleta || refCompleta.slice(-5) !== referencia) continue;
    var estado = String(filas[i][4]).trim().toLowerCase();
    if (estado.indexOf("usad") === 0) { r.hayUsado = true; continue; }
    if (estado === "en proceso") { r.hayEnProceso = true; continue; }
    if (estado === ESTADO_PAGO_POR_COMPLETAR.toLowerCase()) { r.hayPorCompletar = true; continue; }
    if (estado !== "verificado" && estado !== "") continue;
    r.filaPago = i + 2;
    r.montoPagado = limpiarMontoVES(filas[i][3]);
    r.referencia = refCompleta;
    break;
  }
  return r;
}

function mensajePagoNoDisponible(pago) {
  if (pago.hayEnProceso) return "⚠️ Ese pago se está procesando en otra recarga en este momento.";
  if (pago.hayPorCompletar) return "⏳ Este pago no alcanzó y está esperando que completes la diferencia: usa el botón \"Completar pago\" de la tienda o escríbenos por WhatsApp.";
  if (pago.hayUsado) return "❌ Esta referencia ya fue utilizada anteriormente.";
  return "⚠️ Referencia no encontrada en el sistema de pagos.";
}

// Primer código libre de la columna (todavía sin tocarlo): { codigo, fila } o { codigo: null }
function buscarCodigoLibre(hojaCodigos, col) {
  var ultimaFila = hojaCodigos.getLastRow();
  var columna = ultimaFila > 1 ? hojaCodigos.getRange(2, col, ultimaFila - 1, 1).getValues() : [];
  for (var j = 0; j < columna.length; j++) {
    var celda = String(columna[j][0]).trim();
    if (codigoLibre(celda)) return { codigo: celda, fila: j + 2 };
  }
  return { codigo: null, fila: -1 };
}

// "Por completar" -> "Usado" del pago con esa referencia completa (la fila más reciente)
function marcarPagoUsado(hojaPagos, referencia) {
  var ultima = hojaPagos.getLastRow();
  var refs = ultima > 1 ? hojaPagos.getRange(2, 3, ultima - 1, 1).getValues() : [];
  for (var i = refs.length - 1; i >= 0; i--) {
    if (String(refs[i][0]).replace(/\s+/g, "") === referencia) {
      hojaPagos.getRange(i + 2, 5).setValue("Usado");
      return;
    }
  }
}

function hojaPorCompletar() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(HOJA_POR_COMPLETAR);
  if (!hoja) {
    hoja = libro.insertSheet(HOJA_POR_COMPLETAR, 0);
    hoja.appendRow(COLUMNAS_POR_COMPLETAR);
    hoja.getRange(1, 1, 1, COLUMNAS_POR_COMPLETAR.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  asegurarTituloWhatsapp(hoja, COLUMNAS_POR_COMPLETAR.length);
  return hoja;
}

// WhatsApp del cliente (opcional; Vercel manda "+58…" ya validado o ""). En la hoja queda como enlace
// https://wa.me/58… : un toque abre el chat con el cliente. Cualquier otra cosa queda vacía.
function enlaceWhatsapp(telefono) {
  var digitos = String(telefono || "").replace(/\D/g, "");
  return /^584\d{9}$/.test(digitos) ? "https://wa.me/" + digitos : "";
}

// Pestaña creada antes de la columna "WhatsApp" (siempre la última): se agrega su título
// (y la columna, si se habían borrado las columnas vacías)
function asegurarTituloWhatsapp(hoja, columna) {
  if (hoja.getMaxColumns() < columna) hoja.insertColumnsAfter(hoja.getMaxColumns(), columna - hoja.getMaxColumns());
  var celda = hoja.getRange(1, columna);
  if (!String(celda.getValue() || "").trim()) celda.setValue("WhatsApp").setFontWeight("bold");
}

// Fila (la más reciente) de "por_completar" con ese valor exacto en esa columna (14 = huella de la clave)
function buscarFilaPorCompletar(columna, valor) {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_POR_COMPLETAR);
  if (!valor || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(valor)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
}

// Fecha y hora de Venezuela con el formato de las pestañas
function ahora() {
  return Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
}

function redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Quita la celda del código entregado y sube los de abajo (la columna queda sin huecos).
// Se vuelve a leer la columna: solo se borra si la celda todavía tiene la marca de usado.
function quitarCodigoDeLaColumna(hoja, col, fila) {
  var ultimaFila = hoja.getLastRow();
  if (fila > ultimaFila) return;
  if (String(hoja.getRange(fila, col).getValue()).indexOf(PREFIJO_USADO) !== 0) return;
  if (fila < ultimaFila) {
    var abajo = hoja.getRange(fila + 1, col, ultimaFila - fila, 1).getValues();
    hoja.getRange(fila, col, abajo.length, 1).setValues(abajo);
  }
  hoja.getRange(ultimaFila, col).clearContent();
}

// Un código se puede entregar si la celda tiene texto y no lleva la marca de usado
function codigoLibre(celda) {
  return Boolean(celda) && celda.indexOf(PREFIJO_USADO) !== 0;
}

// Columna (1, 2...) del paquete en "Codigos" según la clave del título (números + región). -1 si no está.
function columnaDePaquete(hojaCodigos, numeroPaquete) {
  if (!hojaCodigos) return -1;
  var ultimaColumna = hojaCodigos.getLastColumn();
  if (ultimaColumna < 1) return -1;
  var titulos = hojaCodigos.getRange(1, 1, 1, ultimaColumna).getValues()[0];
  for (var h = 0; h < titulos.length; h++) {
    if (claveDePaquete(titulos[h]) === numeroPaquete) return h + 1;
  }
  return -1;
}

// Precio (número) del paquete en "PreciosRoblox": fila 1 nombres, fila 2 precios. 0 si no está.
function precioDePaquete(libro, numeroPaquete) {
  var hoja = libro.getSheetByName(sheetNamePreciosRoblox);
  if (!hoja || !numeroPaquete) return 0;
  var ultimaColumna = hoja.getLastColumn();
  if (ultimaColumna < 1) return 0;
  var filas = hoja.getRange(1, 1, 2, ultimaColumna).getValues();
  for (var p = 0; p < filas[0].length; p++) {
    if (claveDePaquete(filas[0][p]) === numeroPaquete) return limpiarMontoVES(filas[1][p]);
  }
  return 0;
}

// Sin candado: solo lectura. Precios { "800 Robux": 1700, ... }, códigos libres por paquete
// { "800 Robux": 4, ... } (Vercel convierte la cantidad en disponible / últimos / agotado) y el
// product_id de Central One de cada paquete que lo tenga (Vercel nunca lo manda al navegador).
// Un paquete sin precio mayor que 0 no se muestra (p. ej. falta el dólar en "tasa_dolar").
function obtenerPrecios() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(sheetNamePreciosRoblox);
  if (!hoja) return responder({ status: "error", message: "Hoja de precios no encontrada." });
  var ultimaColumna = hoja.getLastColumn();
  var precios = {};
  var stock = {};
  var productos = {};
  var libresPorNumero = contarCodigosLibres(libro.getSheetByName(sheetNameCodigos));
  if (ultimaColumna > 0) {
    var filas = hoja.getRange(1, 1, FILA_PRODUCTO, ultimaColumna).getValues();
    for (var i = 0; i < filas[0].length; i++) {
      var titulo = String(filas[0][i]).trim();
      if (!titulo || !(limpiarMontoVES(filas[1][i]) > 0)) continue;
      precios[titulo] = filas[1][i];
      stock[titulo] = libresPorNumero[claveDePaquete(titulo)] || 0;
      var producto = String(filas[FILA_PRODUCTO - 1][i]).trim();
      if (PRODUCTO_VALIDO.test(producto)) productos[titulo] = producto;
    }
  }
  return responder({ status: "success", precios: precios, stock: stock, productos: productos });
}

// { "800": 4, "800-EEUU": 2, ... }: códigos libres de cada columna de "Codigos", por la clave del título
function contarCodigosLibres(hojaCodigos) {
  var conteo = {};
  if (!hojaCodigos) return conteo;
  var ultimaFila = hojaCodigos.getLastRow();
  var ultimaColumna = hojaCodigos.getLastColumn();
  if (ultimaFila < 1 || ultimaColumna < 1) return conteo;
  var valores = hojaCodigos.getRange(1, 1, ultimaFila, ultimaColumna).getValues();
  for (var c = 0; c < ultimaColumna; c++) {
    var numero = claveDePaquete(valores[0][c]);
    if (!numero) continue;
    var libres = 0;
    for (var f = 1; f < valores.length; f++) if (codigoLibre(String(valores[f][c]).trim())) libres++;
    conteo[numero] = (conteo[numero] || 0) + libres;
  }
  return conteo;
}

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Compara dos textos sin cortar en la primera diferencia (no revela por tiempos cuánto acertó)
function mismoTexto(a, b) {
  if (a.length !== b.length) return false;
  var diferencia = 0;
  for (var i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

// Texto que se escribe en la hoja: si empieza como fórmula (= + - @) se guarda como texto
function textoSeguro(valor) {
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 3000);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}

// 1700 -> "1.700,00 Bs"
function formatoBs(n) {
  var partes = (Math.round(Number(n) * 100) / 100).toFixed(2).split(".");
  return partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + partes[1] + " Bs";
}

// Montos en Bs: "1.234,56", "1234.56", "1.234" o número -> número (igual que recargas.gs).
function limpiarMontoVES(valor) {
  if (typeof valor === "number") return valor;
  if (!valor) return 0;
  var m = String(valor).trim().replace(/[^0-9.,]/g, "");
  if (!m) return 0;
  if (m.indexOf(",") !== -1 && m.indexOf(".") !== -1) {
    if (m.lastIndexOf(",") > m.lastIndexOf(".")) { m = m.replace(/\./g, "").replace(",", "."); }
    else { m = m.replace(/,/g, ""); }
  } else if (m.indexOf(".") !== -1) {
    var partes = m.split(".");
    if (partes.length > 2 || (partes.length === 2 && partes[1].length === 3)) { m = m.replace(/\./g, ""); }
  } else if (m.indexOf(",") !== -1) {
    m = m.replace(",", ".");
  }
  return parseFloat(m) || 0;
}


// =====================================================================
// MENÚ 🎮 ROBLOX: PRODUCTOS DE CENTRAL ONE EN "PreciosRoblox"
//   🔑 guarda la llave (propiedad del script, nunca en la hoja; basta con catalog:read) · 🔄 trae las
//   tarjetas de Roblox de tu catálogo y les pone el precio en Bs con el dólar y la ganancia de la pestaña
//   "tasa_dolar" (cambias el dólar y todos los precios cambian). Reemplaza toda la pestaña: solo quedan las
//   tarjetas de Robux GLOBAL y de EE. UU. (REGIONES_ROBLOX) que Central One tiene en stock (las agotadas y las de
//   saldo en USD no se traen). La tienda las muestra en dos secciones según el nombre (las de EE. UU. terminan en SUFIJO_EEUU).
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu("🎮 Roblox")
    .addItem("🔄 Traer productos de Central One", "traerProductosCentralOne")
    .addItem("🔑 Guardar llave de Central One", "guardarLlaveCentralOne")
    .addToUi();
}

function guardarLlaveCentralOne() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt("Llave de Central One",
    "Pega la llave (empieza por co_live_). Basta con el permiso catalog:read: la que compra va en Vercel (roblox_nuevo). Se guarda en las propiedades del script, no en la hoja.",
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var llave = r.getResponseText().trim();
  if (!/^co_live_[A-Za-z0-9_-]{8,200}$/.test(llave)) {
    ui.alert("Esa no parece una llave de Central One (empieza por co_live_). No se guardó nada.");
    return;
  }
  PropertiesService.getScriptProperties().setProperty(PROPIEDAD_LLAVE_CENTRALONE, llave);
  ui.alert("✅ Llave guardada. Ahora: menú 🎮 Roblox → 🔄 Traer productos de Central One.");
}

function traerProductosCentralOne() {
  var ui = SpreadsheetApp.getUi();
  var llave = PropertiesService.getScriptProperties().getProperty(PROPIEDAD_LLAVE_CENTRALONE);
  if (!llave) {
    ui.alert("Primero guarda la llave: menú 🎮 Roblox → 🔑 Guardar llave de Central One.");
    return;
  }
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(sheetNamePreciosRoblox) || libro.insertSheet(sheetNamePreciosRoblox);

  var respuesta = UrlFetchApp.fetch(URL_CENTRALONE + "/catalog", {
    headers: { Authorization: "Bearer " + llave }, muteHttpExceptions: true
  });
  var codigo = respuesta.getResponseCode();
  if (codigo !== 200) {
    var porque = codigo === 401 ? " (llave inválida, revocada o cuenta inactiva)" : codigo === 403 ? " (la llave no tiene el permiso catalog:read)" : codigo === 429 ? " (demasiadas consultas: espera un minuto)" : "";
    ui.alert("Central One respondió HTTP " + codigo + porque + ". No se cambió nada.");
    return;
  }
  // Solo tarjetas (códigos): un producto que pide datos del jugador no se puede vender como código
  var deRoblox = (JSON.parse(respuesta.getContentText()).items || []).filter(function (p) {
    return String(p.product_family_name + " " + p.name).toLowerCase().replace(/[^a-z0-9]/g, "").indexOf("roblox") !== -1 && !p.requires_target;
  });
  if (!deRoblox.length) {
    ui.alert("Tu catálogo de Central One no tiene tarjetas de Roblox habilitadas. No se cambió nada.");
    return;
  }
  var regionDe = function (p) { return String(p.region || "").trim().toUpperCase(); };
  // Solo las de Robux (el monto en Robux en el nombre): las tarjetas de saldo en USD no se venden
  var productos = deRoblox.filter(function (p) {
    return REGIONES_ROBLOX.indexOf(regionDe(p)) !== -1 && esDeRobux(p.name);
  });
  if (!productos.length) {
    var regiones = deRoblox.map(function (p) { return regionDe(p) || "sin región"; })
      .filter(function (r, i, lista) { return lista.indexOf(r) === i; });
    ui.alert("Hay " + deRoblox.length + " tarjeta(s) de Roblox, pero ninguna de Robux de las regiones " + REGIONES_ROBLOX.join(", ") +
      " (regiones que hay: " + regiones.join(", ") + "; ejemplos: " + deRoblox.slice(0, 5).map(function (p) { return p.name; }).join(" | ") +
      "). No se cambió nada.");
    return;
  }
  // Solo los que Central One tiene en stock: un paquete agotado no se muestra en la tienda
  var sinStock = productos.filter(function (p) { return p.in_stock === false; });
  productos = productos.filter(function (p) { return p.in_stock !== false; });
  if (!productos.length) {
    ui.alert("Central One no tiene stock de ninguna tarjeta de Robux " + REGIONES_ROBLOX.join(", ") + " en este momento (" +
      sinStock.length + " sin stock). No se cambió nada: inténtalo más tarde.");
    return;
  }
  productos.sort(function (a, b) { return Number(a.reseller_price) - Number(b.reseller_price); });

  // Uno por monto de Robux y región (GLOBAL / EE. UU.): el más barato de cada uno
  var elegido = {}, repetidos = [];
  productos.forEach(function (p) {
    var n = claveDePaquete(nombreConRegion(p));
    var actual = elegido[n];
    if (!actual) { elegido[n] = p; return; }
    var mejor = REGIONES_ROBLOX.indexOf(regionDe(p)) < REGIONES_ROBLOX.indexOf(regionDe(actual)) ? p : actual;
    repetidos.push(mejor === p ? actual : p);
    elegido[n] = mejor;
  });
  // Primero las GLOBAL y luego las de EE. UU., cada una de menor a mayor
  var esClaveEEUU = function (k) { return k.indexOf("-EEUU") !== -1 ? 1 : 0; };
  var montos = Object.keys(elegido).sort(function (a, b) {
    return esClaveEEUU(a) - esClaveEEUU(b) || parseInt(a, 10) - parseInt(b, 10);
  });
  var cuantosEEUU = montos.filter(esClaveEEUU).length;

  var hojaTasa = hojaDeTasa();
  var dolar = limpiarMontoVES(hojaTasa.getRange("B1").getValue());
  var seguir = ui.alert("Traer productos de Central One",
    "Se reemplaza TODA la pestaña \"" + sheetNamePreciosRoblox + "\" con " + montos.length + " paquete(s) de Robux (" +
    (montos.length - cuantosEEUU) + " GLOBAL y " + cuantosEEUU + " de EE. UU.) que Central One tiene en stock" +
    (sinStock.length ? " (" + sinStock.length + " sin stock no se traen)" : "") + ". Los demás paquetes se eliminan.\n\n" +
    "El precio en Bs se calcula solo: costo en USD × dólar (pestaña \"" + HOJA_TASA + "\", B1) + la ganancia (B2).\n\n¿Seguir?",
    ui.ButtonSet.YES_NO);
  if (seguir !== ui.Button.YES) return;

  // Fila 2: fórmula en notación R1C1 (Apps Script las escribe en inglés, con comas, sea cual sea el idioma
  // de la hoja). R[2]C = la celda del costo, 2 filas más abajo en la misma columna. Sin dólar o sin costo, vacía.
  var tasa = "'" + HOJA_TASA + "'!R1C2", ganancia = "'" + HOJA_TASA + "'!R2C2", costo = "R[" + (FILA_COSTO - 2) + "]C";
  var formula = "=IF(OR(" + tasa + "=\"\"," + costo + "=\"\"),\"\",ROUND(" + costo + "*" + tasa + "*(1+" + ganancia + "/100),2))";
  var valores = [[], [], [], [], []];
  var formulas = [];
  montos.forEach(function (n) {
    var p = elegido[n];
    valores[0].push(textoSeguro(nombreConRegion(p)));
    valores[1].push("");
    valores[2].push(textoSeguro(p.product_id));
    valores[3].push(Number(p.reseller_price) || "");
    valores[4].push(textoSeguro("con stock" + (p.region ? " · " + p.region : "")));
    formulas.push(formula);
  });
  var total = montos.length;
  hoja.clearContents();
  hoja.getRange(1, 1, 5, total).setValues(valores);
  hoja.getRange(2, 1, 1, total).setFormulasR1C1([formulas]);
  hoja.getRange(1, 1, 1, total).setFontWeight("bold");
  hoja.getRange(2, 1, 1, total).setNumberFormat("#,##0.00");
  hoja.getRange(FILA_COSTO, 1, 1, total).setNumberFormat("0.0000\" USD\"");
  hoja.getRange(FILA_PRODUCTO, 1, 3, total).setFontColor("#888888");
  hoja.getRange(2, 1).setNote("Fila 2: precio en Bs = costo (fila 4) × dólar × (1 + ganancia %). El dólar y la ganancia " +
    "se cambian en la pestaña \"" + HOJA_TASA + "\". Si escribes un número encima, ese paquete queda con precio fijo hasta el próximo 🔄.");
  hoja.getRange(FILA_PRODUCTO, 1).setNote("Fila 3: product_id de Central One, NO la toques (con él se compra el código). " +
    "Fila 4: costo en USD · fila 5: stock (del momento del 🔄). La fila 1 se puede renombrar, pero con el mismo número de Robux " +
    "y, si es de Estados Unidos, terminando en \"" + SUFIJO_EEUU + "\" (en \"Codigos\" igual: \"800 Robux\" = GLOBAL, \"800 Robux " + SUFIJO_EEUU + "\" = EE. UU.).");
  SpreadsheetApp.flush();
  ui.alert("✅ Listo: " + total + " paquete(s) de Robux con stock (" + (total - cuantosEEUU) + " GLOBAL y " + cuantosEEUU + " de EE. UU.)." +
    (sinStock.length ? " No se trajeron " + sinStock.length + " sin stock." : "") +
    (repetidos.length ? " Se quitaron " + repetidos.length + " repetido(s)." : "") +
    (dolar > 0
      ? " Precios calculados con el dólar a " + formatoBs(dolar) + " y " + hojaTasa.getRange("B2").getValue() + " % de ganancia."
      : " ⚠️ Falta el precio del dólar: escríbelo en la pestaña \"" + HOJA_TASA + "\", celda B1. Hasta entonces no se vende nada.") +
    " La tienda tarda hasta ~2 minutos en mostrar los cambios. Vuelve a usar 🔄 cuando quieras actualizar stock y costos.");
}

// Pestaña "tasa_dolar" (se crea la primera vez): B1 = dólar en Bs (lo escribes tú) · B2 = ganancia en %
function hojaDeTasa() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(HOJA_TASA);
  if (!hoja) {
    hoja = libro.insertSheet(HOJA_TASA);
    hoja.getRange("A1:B3").setValues([
      ["Precio del dólar (Bs)", ""],
      ["Ganancia (%)", GANANCIA_INICIAL],
      ["Cambia B1 o B2 y todos los precios de " + sheetNamePreciosRoblox + " se recalculan solos.", ""]
    ]);
    hoja.getRange("A1:A2").setFontWeight("bold");
    hoja.getRange("B1").setNumberFormat("#,##0.00").setBackground("#fff2cc");
    hoja.getRange("B2").setBackground("#fff2cc");
    hoja.getRange("A3").setFontColor("#888888");
    hoja.setColumnWidth(1, 200);
  }
  return hoja;
}

// Nombre corto de una tarjeta de Central One: "Roblox Gift Card 800 Robux (US)" -> "800 Robux",
// "Roblox $10 USD" -> "10 USD". Tiene UN solo número: con la región, es la clave del paquete (ver claveDePaquete).
function nombreCortoRoblox(nombre) {
  var t = String(nombre || "");
  var robux = t.match(/(\d[\d.,]*)\s*robux/i);
  if (robux) return robux[1].replace(/[.,]/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " Robux";
  var usd = t.match(/(?:\$|usd)\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:\$|usd|dollars?|d[oó]lares)/i);
  if (usd) return String(Number(String(usd[1] || usd[2]).replace(",", "."))) + " USD";
  return t.trim().slice(0, 60);
}

// Tarjeta de Robux (el monto en Robux en el nombre)
function esDeRobux(nombre) {
  return /\d[\d.,]*\s*robux/i.test(String(nombre || ""));
}

// Región de Estados Unidos: en el nombre del paquete ("800 Robux EE. UU.") o en la región de Central One ("US")
function esDeEEUU(texto) {
  return /EE\.?\s*UU|ESTADOS\s+UNIDOS|UNITED\s+STATES|\bUSA?\b/i.test(String(texto || ""));
}

// Nombre del paquete en la tienda: "800 Robux" (GLOBAL) o "800 Robux EE. UU."
function nombreConRegion(p) {
  return nombreCortoRoblox(p.name) + (esDeEEUU(p.region) ? " " + SUFIJO_EEUU : "");
}

// Clave de un paquete, igual en "PreciosRoblox" y en "Codigos": los números de su nombre y, si es de
// EE. UU., "-EEUU" ("1.000 Robux" -> "1000", "1.000 Robux EE. UU." -> "1000-EEUU"). "" sin números.
function claveDePaquete(nombre) {
  var numero = String(nombre || "").replace(/[^0-9]/g, "");
  if (!numero) return "";
  return esDeEEUU(nombre) ? numero + "-EEUU" : numero;
}
