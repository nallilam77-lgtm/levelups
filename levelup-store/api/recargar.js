export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { id, paquete, monto, referencia, codigoTxn } = req.body;
    const payload = {
      tokenSecreto: "LevelUpMaster2026_Key",
      id,
      paquete,
      monto,
      referencia,
      codigoTxn
    };

    const response = await fetch(process.env.SCRIPT_RECARGAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const resultado = await response.json();
    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({ status: "error", message: "Error al procesar la recarga" });
  }
}