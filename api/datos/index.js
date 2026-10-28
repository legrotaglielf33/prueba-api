// GET /api/datos: devuelve todos los datos compartidos
const { leerDatos } = require("../_redis");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(404).json({ error: "No existe" });
  try {
    res.status(200).json(await leerDatos());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
