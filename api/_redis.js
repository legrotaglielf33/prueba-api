// ===================================================================
//  Acceso a Upstash Redis (por su API REST) para las funciones de Vercel.
//  Vercel no deja escribir archivos, así que los datos compartidos se
//  guardan acá en lugar de datos/guardados.json.
//  Las variables las crea Vercel al conectar Upstash desde Storage.
// ===================================================================

const URL_REDIS = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Las únicas claves que la página puede guardar
const CLAVES = ["usuarios", "ratings", "comentarios", "tags_admin", "catalogo", "vistos", "resenas", "amigos", "discos", "tags_musica"];
const PREFIJO = "santi:";

async function redis(...comando) {
  if (!URL_REDIS || !TOKEN) throw new Error("Falta configurar Upstash Redis en Vercel");
  const resp = await fetch(URL_REDIS, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(comando),
  });
  const respuesta = await resp.json();
  if (!resp.ok || respuesta.error) throw new Error(respuesta.error || `Redis respondió ${resp.status}`);
  return respuesta.result;
}

async function leerDatos() {
  const valores = await redis("MGET", ...CLAVES.map((clave) => PREFIJO + clave));
  const datos = {};
  CLAVES.forEach((clave, i) => {
    if (valores[i] !== null) datos[clave] = JSON.parse(valores[i]);
  });
  return datos;
}

async function guardarClave(clave, valor) {
  if (valor === null) await redis("DEL", PREFIJO + clave);
  else await redis("SET", PREFIJO + clave, JSON.stringify(valor));
}

module.exports = { CLAVES, leerDatos, guardarClave };
