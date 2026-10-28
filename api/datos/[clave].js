// PUT /api/datos/:clave: guarda (o borra, si el cuerpo es null) una clave
const { CLAVES, guardarClave } = require("../_redis");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { clave } = req.query;
  if (req.method !== "PUT" || !CLAVES.includes(clave)) {
    return res.status(404).json({ error: "No existe" });
  }
  try {
    const valor = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? null);
    await guardarClave(clave, valor);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
};
