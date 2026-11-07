// =========================================================================
// MERCADO DE CUENTAS: configuración y utilidades compartidas por cuentas.html y admin-cuentas.html.
// Necesita supabase-js (UMD) cargado antes. La URL y la publishable key NO son secretas: lo que cada
// quien puede ver o cambiar lo decide supabase/cuentas.sql (RLS + funciones), no el navegador.
// Todo dato de un usuario se pinta con textContent / atributos, nunca con innerHTML.
// =========================================================================
(function () {
  const SUPABASE_URL = 'https://qaxgvfzpzywfgcwnalfr.supabase.co';
  const SUPABASE_PUBLICABLE = 'sb_publishable_iWFflYD8yK3tQIWcORNz7g_OPfvmvng';
  const BUCKET = 'cuentas-fotos';

  // Códigos que lanzan las funciones de supabase/cuentas.sql → texto para el cliente
  const ERRORES = {
    LIMITE_PUBLICACIONES: 'Ya tienes 10 cuentas activas. Elimina alguna para publicar otra.',
    FOTO_INVALIDA: 'Hubo un problema con las fotos. Vuelve a elegirlas.',
    NO_EDITABLE: 'Esa publicación ya no se puede cambiar.',
    NO_PERMITIDO: 'No se puede hacer ese cambio.',
    SIN_SESION: 'Tu sesión venció. Vuelve a entrar.',
    NO_DISPONIBLE: 'Esa cuenta ya no está disponible: alguien más la está comprando o el vendedor la retiró.',
    ES_TUYA: 'No puedes comprar tu propia cuenta.',
    DEMASIADAS_PENDIENTES: 'Ya tienes 2 compras esperando pago. Págalas o cancélalas antes de abrir otra.',
    ESTADO_INVALIDO: 'El trato cambió de estado. Actualizamos la pantalla.',
    DATO_INVALIDO: 'Revisa los datos que escribiste.',
    FUERA_DE_PLAZO: 'Ya pasó el plazo para reclamar.',
    VIDEO_REQUERIDO: 'Sin video no hay reclamo: pega el enlace de tu grabación (Drive, YouTube oculto, etc.).',
    RETIRO_MINIMO: 'El monto es menor que el retiro mínimo.',
    RETIRO_PENDIENTE: 'Ya tienes un retiro pendiente. Espera a que lo paguemos.',
    SALDO_INSUFICIENTE: 'No tienes saldo suficiente para ese retiro.',
    CHAT_CERRADO: 'Este trato ya terminó: el chat está cerrado.',
    DEMASIADOS_MENSAJES: 'Estás enviando mensajes muy rápido. Espera un momento.',
    SOLO_ADMIN: 'Solo un administrador puede hacer eso.',
  };

  const TEXTO_ESTADO_CUENTA = {
    revision: 'En revisión', publicada: 'Publicada', pausada: 'Pausada', reservada: 'Reservada (en un trato)',
    vendida: 'Vendida', rechazada: 'Rechazada',
  };
  const TEXTO_ESTADO_TRATO = {
    pendiente_pago: 'Esperando pago', pagada: 'Pago retenido · esperando entrega', entregada: 'Datos entregados · en revisión',
    en_reclamo: 'En reclamo', cerrada: 'Cerrado', cancelada: 'Cancelado',
  };
  const TEXTO_ROL = { comprador: 'Comprador', vendedor: 'Vendedor', admin: 'Level Up', sistema: 'Level Up · Sistema' };

  let cliente = null;

  const Mercado = {
    SUPABASE_URL,
    BUCKET,
    WHATSAPP: '584228887089',
    METODOS: ['Pago Móvil', 'Binance', 'Zinli', 'Otro'],
    TEXTO_ESTADO_CUENTA,
    TEXTO_ESTADO_TRATO,
    TEXTO_ROL,

    cliente() {
      if (!cliente && window.supabase?.createClient) {
        cliente = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLICABLE, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
      }
      return cliente;
    },

    crear(etiqueta, clase, texto) {
      const el = document.createElement(etiqueta);
      if (clase) el.className = clase;
      if (texto != null) el.textContent = texto;
      return el;
    },

    codigoCuenta: (id) => `FF-${id}`,
    codigoTrato: (id) => `T-${id}`,
    codigoRetiro: (id) => `R-${id}`,
    urlFoto: (ruta) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${String(ruta).split('/').map(encodeURIComponent).join('/')}`,
    usd: (n) => `${Number(n).toLocaleString('es-VE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USD`,
    bs: (n) => `${Number(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs`,
    fecha: (iso) => new Date(iso).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),

    textoError(error, porDefecto) {
      const texto = String(error?.message || '');
      const clave = Object.keys(ERRORES).find((k) => texto.includes(k));
      return clave ? ERRORES[clave] : porDefecto;
    },

    // Llama a una función de supabase/cuentas.sql y lanza un Error con el texto para el cliente
    async rpc(nombre, parametros, porDefecto = 'No pudimos completar la acción. Intenta de nuevo.') {
      const { data, error } = await Mercado.cliente().rpc(nombre, parametros);
      if (error) {
        console.error(nombre, error);
        const e = new Error(Mercado.textoError(error, porDefecto));
        e.estadoCambiado = String(error.message || '').includes('ESTADO_INVALIDO');
        throw e;
      }
      return data;
    },

    // mercado_config → { comision_retiro: 4, retiro_minimo: 5, ..., instrucciones_pago: '...' }
    async config() {
      const valores = { comision_retiro: 4, retiro_minimo: 5, garantia_usd: 1, horas_pago: 2, horas_revision: 24, tasa_bs: 0, instrucciones_pago: '' };
      const { data, error } = await Mercado.cliente().from('mercado_config').select('clave,valor');
      if (!error) {
        for (const { clave, valor } of data) {
          valores[clave] = clave === 'instrucciones_pago' ? valor : (Number(valor) || 0);
        }
      }
      return valores;
    },

    mensaje(el, texto, tipo = 'error') {
      el.className = `panel-mensaje ${tipo}`;
      el.textContent = texto;
    },

    // Chat de un trato: trae los mensajes nuevos cada 5 s mientras está abierto (y la pestaña visible).
    // alNuevo(mensajes) avisa cuando llegan mensajes (los del sistema = el trato cambió de estado).
    crearChat({ lista, form, input, boton, aviso, yo, alNuevo }) {
      let venta = null;
      let ultimo = 0;
      let temporizador = null;
      let ocupado = false;

      function burbuja(m) {
        const propio = m.autor && m.autor === yo();
        const div = Mercado.crear('div', `msg msg-${m.rol}${propio ? ' msg-mio' : ''}`);
        const cabecera = Mercado.crear('span', 'msg-autor', `${propio ? 'Tú' : TEXTO_ROL[m.rol] || m.rol} · ${Mercado.fecha(m.creado)}`);
        div.append(cabecera, Mercado.crear('p', 'msg-texto', m.texto));
        return div;
      }

      async function traer() {
        if (!venta || ocupado) return;
        ocupado = true;
        const pedido = venta;
        const { data, error } = await Mercado.cliente().from('mensajes_venta')
          .select('id,autor,rol,texto,creado').eq('venta', pedido).gt('id', ultimo).order('id').limit(200);
        ocupado = false;
        if (error || pedido !== venta || !data.length) return;
        const alFinal = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 80 || ultimo === 0;
        for (const m of data) lista.append(burbuja(m));
        ultimo = data[data.length - 1].id;
        if (alFinal) lista.scrollTop = lista.scrollHeight;
        alNuevo?.(data);
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const texto = input.value.trim();
        if (!texto || !venta) return;
        boton.disabled = true;
        try {
          await Mercado.rpc('mensaje_enviar', { p_venta: venta, p_texto: texto.slice(0, 1000) }, 'No se pudo enviar el mensaje.');
          input.value = '';
          aviso.textContent = '';
          await traer();
          lista.scrollTop = lista.scrollHeight;
        } catch (error) {
          Mercado.mensaje(aviso, error.message);
        } finally {
          boton.disabled = false;
        }
      });

      return {
        abrir(id) {
          clearInterval(temporizador);
          venta = id;
          ultimo = 0;
          lista.replaceChildren();
          aviso.textContent = '';
          traer();
          temporizador = setInterval(() => { if (!document.hidden) traer(); }, 5000);
        },
        cerrar() {
          clearInterval(temporizador);
          venta = null;
        },
        habilitar(si) {
          input.disabled = !si;
          boton.disabled = !si;
          input.placeholder = si ? 'Escribe un mensaje…' : 'El chat de este trato está cerrado';
        },
        traer,
      };
    },
  };

  window.Mercado = Mercado;
})();
