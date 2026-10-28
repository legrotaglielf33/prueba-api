// ===================================================================
//  Servidor de El "Santi"-Grial: sirve la página y guarda los datos
//  compartidos (usuarios, ratings, comentarios, tags y catálogo) en
//  datos/guardados.json. Se inicia con:  node servidor.js
// ===================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

const PUERTO = process.env.PORT || 3000;
const RAIZ = __dirname;
const ARCHIVO = path.join(RAIZ, "datos", "guardados.json");

// Las únicas claves que la página puede guardar
const CLAVES = ["usuarios", "ratings", "comentarios", "tags_admin", "catalogo", "vistos"];

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function leerDatos() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
  } catch {
    return {};
  }
}

function guardarDatos(datos) {
  // Se escribe a un temporal y se renombra, para no dejar el archivo a medias
  const temporal = ARCHIVO + ".tmp";
  fs.writeFileSync(temporal, JSON.stringify(datos, null, 2));
  fs.renameSync(temporal, ARCHIVO);
}

function responder(res, estado, cuerpo, tipo = "application/json; charset=utf-8") {
  res.writeHead(estado, { "Content-Type": tipo, "Cache-Control": "no-store" });
  res.end(typeof cuerpo === "string" || Buffer.isBuffer(cuerpo) ? cuerpo : JSON.stringify(cuerpo));
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let cuerpo = "";
    req.on("data", (parte) => {
      cuerpo += parte;
      if (cuerpo.length > 5_000_000) reject(new Error("Cuerpo demasiado grande"));
    });
    req.on("end", () => resolve(cuerpo));
    req.on("error", reject);
  });
}

async function api(req, res, ruta) {
  if (req.method === "GET" && ruta === "/api/datos") {
    return responder(res, 200, leerDatos());
  }

  const clave = ruta.match(/^\/api\/datos\/([a-z_]+)$/)?.[1];
  if (req.method === "PUT" && CLAVES.includes(clave)) {
    const valor = JSON.parse(await leerCuerpo(req));
    const datos = leerDatos();
    if (valor === null) delete datos[clave];
    else datos[clave] = valor;
    guardarDatos(datos);
    return responder(res, 200, { ok: true });
  }

  responder(res, 404, { error: "No existe" });
}

function archivoEstatico(res, ruta) {
  const archivo = path.normalize(path.join(RAIZ, ruta === "/" ? "index.html" : ruta));
  // No se sirve nada fuera de la carpeta ni los datos guardados (tienen las contraseñas)
  if (!archivo.startsWith(RAIZ) || archivo === ARCHIVO || archivo.includes(`${path.sep}.`)) {
    return responder(res, 404, "No encontrado", "text/plain; charset=utf-8");
  }
  fs.readFile(archivo, (err, contenido) => {
    if (err) return responder(res, 404, "No encontrado", "text/plain; charset=utf-8");
    responder(res, 200, contenido, TIPOS[path.extname(archivo)] ?? "application/octet-stream");
  });
}

http.createServer(async (req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  try {
    if (ruta.startsWith("/api/")) await api(req, res, ruta);
    else archivoEstatico(res, ruta);
  } catch (err) {
    console.error(err);
    responder(res, 400, { error: err.message });
  }
}).listen(PUERTO, () => {
  console.log(`El "Santi"-Grial en http://localhost:${PUERTO}`);
});
