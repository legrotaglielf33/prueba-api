// ===================================================================
//  El "Santi"-Grial — SPA con la API de TMDB (películas y series), login,
//  ratings, comentarios, tags y episodios vistos
// ===================================================================

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";

// Los tags, las películas y los usuarios están en la carpeta datos/.

const app = document.getElementById("app");

// ---------------------------------------------------------------
//  Utilidades
// ---------------------------------------------------------------
function escapar(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function anio(fecha) {
  return fecha ? fecha.slice(0, 4) : "s/f";
}

function formatearFecha(iso) {
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" });
}

// Para fechas sin hora de TMDB ("2024-05-31")
function formatearDia(fecha) {
  return new Date(`${fecha}T00:00`).toLocaleDateString("es-AR", { dateStyle: "medium" });
}

function yaSalio(fecha) {
  return Boolean(fecha) && new Date(`${fecha}T00:00`) <= new Date();
}

// Estas claves se guardan en el servidor (datos/guardados.json) y las ven todos.
// El resto (sesión, búsquedas en caché, preferencias) queda en este navegador.
const COMPARTIDAS = ["usuarios", "ratings", "comentarios", "tags_admin", "catalogo", "vistos", "resenas", "amigos", "discos"];
let datosServidor = {};

const store = {
  // Trae los datos del servidor. Se llama una vez, antes de mostrar la página.
  async cargar() {
    const resp = await fetch("/api/datos");
    if (!resp.ok) {
      const { error } = await resp.json().catch(() => ({}));
      throw new Error(error || `El servidor respondió ${resp.status}`);
    }
    datosServidor = await resp.json();

    // Lo que se había guardado en este navegador antes de usar el servidor se sube una vez
    for (const clave of COMPARTIDAS) {
      const local = localStorage.getItem(clave);
      if (local === null) continue;
      if (!(clave in datosServidor)) this.guardar(clave, JSON.parse(local));
      localStorage.removeItem(clave);
    }
  },
  leer(clave, porDefecto) {
    if (COMPARTIDAS.includes(clave)) {
      return clave in datosServidor ? structuredClone(datosServidor[clave]) : porDefecto;
    }
    try {
      const valor = localStorage.getItem(clave);
      return valor ? JSON.parse(valor) : porDefecto;
    } catch {
      return porDefecto;
    }
  },
  guardar(clave, valor) {
    if (!COMPARTIDAS.includes(clave)) {
      localStorage.setItem(clave, JSON.stringify(valor));
      return;
    }
    datosServidor[clave] = structuredClone(valor);
    fetch(`/api/datos/${clave}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(valor),
    }).then((resp) => {
      if (!resp.ok) throw new Error(`El servidor respondió ${resp.status}`);
    }).catch((err) => {
      console.error(err);
      alert("No se pudo guardar el cambio en el servidor.");
    });
  },
  borrar(clave) {
    if (!COMPARTIDAS.includes(clave)) {
      localStorage.removeItem(clave);
      return;
    }
    delete datosServidor[clave];
    fetch(`/api/datos/${clave}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "null" })
      .catch((err) => console.error(err));
  },
};

// ---------------------------------------------------------------
//  API de TMDB
// ---------------------------------------------------------------
function hayCredenciales() {
  return Boolean(CONFIG.TMDB_TOKEN || CONFIG.TMDB_API_KEY);
}

async function tmdb(ruta, params = {}) {
  const url = new URL(API + ruta);
  url.searchParams.set("language", CONFIG.IDIOMA);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const opciones = { headers: { accept: "application/json" } };
  if (CONFIG.TMDB_TOKEN) {
    opciones.headers.Authorization = `Bearer ${CONFIG.TMDB_TOKEN}`;
  } else {
    url.searchParams.set("api_key", CONFIG.TMDB_API_KEY);
  }

  const resp = await fetch(url, opciones);
  if (!resp.ok) throw new Error(`TMDB respondió ${resp.status}`);
  return resp.json();
}

function claveBusqueda(entrada) {
  return `${entrada.tipo === "serie" ? "serie|" : ""}${entrada.buscar}|${entrada.anio ?? ""}`;
}

// Convierte una entrada de PELICULAS (película o serie) en un id de TMDB.
async function resolverId(entrada) {
  if (entrada.id) return entrada.id;

  const cache = store.leer("cache_busquedas", {});
  const clave = claveBusqueda(entrada);
  if (cache[clave]) return cache[clave];

  const serie = entrada.tipo === "serie";
  const params = { query: entrada.buscar };
  if (entrada.anio) params[serie ? "first_air_date_year" : "primary_release_year"] = entrada.anio;
  const { results } = await tmdb(serie ? "/search/tv" : "/search/movie", params);
  if (!results.length) return null;

  cache[clave] = results[0].id;
  store.guardar("cache_busquedas", cache);
  return results[0].id;
}

// ---------------------------------------------------------------
//  Wikipedia y Wikidata (biografías y premios de las personas).
//  TMDB da el id de Wikidata de cada persona; Wikidata dice cuál es
//  su artículo de Wikipedia y qué premios recibió.
// ---------------------------------------------------------------
const WIKIDATA = "https://www.wikidata.org/w/api.php";

async function apiWiki(base, params) {
  const url = new URL(base);
  // origin=* habilita CORS en las APIs de Wikimedia
  for (const [k, v] of Object.entries({ format: "json", origin: "*", ...params })) url.searchParams.set(k, v);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Wikipedia respondió ${resp.status}`);
  return resp.json();
}

// { [id]: entidad }. Wikidata acepta hasta 50 ids por pedido.
async function entidadesWikidata(ids, props) {
  const partes = [];
  for (let i = 0; i < ids.length; i += 50) partes.push(ids.slice(i, i + 50));
  const respuestas = await Promise.all(partes.map((p) =>
    apiWiki(WIKIDATA, { action: "wbgetentities", ids: p.join("|"), props, languages: "es|en" })));
  return Object.assign({}, ...respuestas.map((r) => r.entities));
}

function nombreWikidata(entidad) {
  const nombre = entidad?.labels?.es?.value ?? entidad?.labels?.en?.value ?? null;
  // Algunos nombres en español son los de artículos de listas ("Anexo:Óscar al mejor actor")
  return nombre?.replace(/^Anexo:/, "") ?? null;
}

// Secciones del artículo que no son parte de la biografía
const SECCIONES_DESCARTADAS = /filmograf|premio|logro|reconocimiento|galard|distincion|nominaci|véase|notas|referencias|bibliograf|enlaces|discograf|obras|trabajos|teatro|televisi|filmography|award|accolade|see also|notes|references|external|works|further reading/i;

// [{ titulo, nivel, parrafos }] — el primer bloque (sin título) es la introducción
async function biografiaWikipedia(idioma, titulo) {
  const datos = await apiWiki(`https://${idioma}.wikipedia.org/w/api.php`, {
    action: "query", prop: "extracts", explaintext: 1, exsectionformat: "wiki", titles: titulo, redirects: 1,
  });
  const texto = Object.values(datos.query.pages)[0]?.extract ?? "";

  const secciones = [{ titulo: null, nivel: 1, parrafos: [] }];
  for (const linea of texto.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const encabezado = linea.match(/^(==+)\s*(.+?)\s*==+$/);
    if (encabezado) secciones.push({ titulo: encabezado[2], nivel: encabezado[1].length, parrafos: [] });
    else secciones.at(-1).parrafos.push(linea);
  }

  // Se descarta cada sección de nivel 2 que no es biografía (con sus subsecciones) y las que no tienen texto
  let descartando = false;
  return secciones.filter((s) => {
    if (s.nivel <= 2) descartando = Boolean(s.titulo) && SECCIONES_DESCARTADAS.test(s.titulo);
    return !descartando && s.parrafos.length;
  });
}

// Premios ganados (P166) y nominaciones (P1411), con año (P585), obra (P1686) y ceremonia (P805)
async function premiosWikidata(entidad) {
  const leer = (propiedad) => (entidad.claims?.[propiedad] ?? [])
    .filter((c) => c.mainsnak.datavalue)
    .map((c) => {
      const calificador = (p) => c.qualifiers?.[p]?.[0]?.datavalue?.value;
      return {
        premio: c.mainsnak.datavalue.value.id,
        anio: calificador("P585")?.time?.slice(1, 5) ?? null,
        obra: calificador("P1686")?.id ?? null,
        ceremonia: calificador("P805")?.id ?? null,
      };
    });
  const ganados = leer("P166");
  const nominaciones = leer("P1411");

  const ids = [...new Set([...ganados, ...nominaciones].flatMap((p) => [p.premio, p.obra, p.ceremonia]).filter(Boolean))];
  const entidades = ids.length ? await entidadesWikidata(ids, "labels") : {};
  const conNombres = (lista) => lista
    .map((p) => ({
      premio: nombreWikidata(entidades[p.premio]),
      obra: nombreWikidata(entidades[p.obra]),
      ceremonia: nombreWikidata(entidades[p.ceremonia]),
      // Si no hay año, a veces está en el nombre de la ceremonia ("Premios Óscar de 1998")
      anio: p.anio ?? nombreWikidata(entidades[p.ceremonia])?.match(/\b(19|20)\d\d\b/)?.[0] ?? null,
    }))
    .filter((p) => p.premio)
    .sort((a, b) => (b.anio ?? "").localeCompare(a.anio ?? ""));

  return { ganados: conNombres(ganados), nominaciones: conNombres(nominaciones) };
}

// Biografía y premios de una persona a partir de su id de Wikidata ("Q175535")
async function datosWiki(wikidataId) {
  const entidad = (await entidadesWikidata([wikidataId], "sitelinks|claims"))[wikidataId];
  if (!entidad) return null;
  // Se prefiere el artículo en español; si no hay, el de inglés
  const idioma = entidad.sitelinks?.eswiki ? "es" : entidad.sitelinks?.enwiki ? "en" : null;
  const articulo = idioma ? entidad.sitelinks[`${idioma}wiki`].title : null;

  const [biografia, premios] = await Promise.all([
    articulo ? biografiaWikipedia(idioma, articulo).catch(() => null) : null,
    premiosWikidata(entidad).catch(() => ({ ganados: [], nominaciones: [] })),
  ]);
  // Foto (P18): un archivo de Wikimedia Commons
  const foto = entidad.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return {
    idioma,
    url: articulo ? `https://${idioma}.wikipedia.org/wiki/${encodeURIComponent(articulo.replace(/ /g, "_"))}` : null,
    biografia,
    premios,
    imagen: foto ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(foto)}?width=500` : null,
  };
}

// ---------------------------------------------------------------
//  MusicBrainz (artistas y discos) y Cover Art Archive (tapas).
//  MusicBrainz permite un pedido por segundo: los pedidos hacen fila
//  y las respuestas se guardan mientras la página esté abierta.
// ---------------------------------------------------------------
const MUSICBRAINZ = "https://musicbrainz.org/ws/2";
const cacheMusicbrainz = new Map();
let filaMusicbrainz = Promise.resolve();
let ultimoPedidoMusicbrainz = 0;

async function musicbrainz(ruta, params = {}) {
  const url = new URL(MUSICBRAINZ + ruta);
  for (const [k, v] of Object.entries({ ...params, fmt: "json" })) url.searchParams.set(k, v);
  if (cacheMusicbrainz.has(url.href)) return cacheMusicbrainz.get(url.href);

  const turno = filaMusicbrainz.then(async () => {
    const espera = ultimoPedidoMusicbrainz + 1100 - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimoPedidoMusicbrainz = Date.now();
  });
  filaMusicbrainz = turno;
  await turno;

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  // 503: se pasó el límite de pedidos; se reintenta una vez
  if (resp.status === 503 && !params._reintento) return musicbrainz(ruta, { ...params, _reintento: 1 });
  if (!resp.ok) throw new Error(`MusicBrainz respondió ${resp.status}`);
  const datos = await resp.json();
  cacheMusicbrainz.set(url.href, datos);
  return datos;
}

function tapaDe(mbid, tamanio = 250) {
  return `https://coverartarchive.org/release-group/${mbid}/front-${tamanio}`;
}

// "Soda Stereo" o "Charly García & Pedro Aznar", con links a cada artista
function creditoArtistas(credito, conLinks = true) {
  return (credito ?? []).map((c) => (conLinks
    ? `<a class="link-persona" href="#/artista/${c.artist.id}">${escapar(c.name)}</a>`
    : escapar(c.name)) + escapar(c.joinphrase ?? "")).join("");
}

function claveDisco(mbid) {
  return `album-${mbid}`;
}

const TIPOS_DISCO = {
  Album: "Álbum",
  EP: "EP",
  Single: "Simple",
  Live: "En vivo",
  Compilation: "Compilado",
  Soundtrack: "Banda sonora",
  Remix: "Remixes",
  Demo: "Demo",
  "DJ-mix": "DJ mix",
  "Mixtape/Street": "Mixtape",
  Interview: "Entrevistas",
  Spokenword: "Hablado",
  Audiobook: "Audiolibro",
  Other: "Otro",
};

function tipoDisco(rg) {
  const tipos = [rg["primary-type"], ...(rg["secondary-types"] ?? [])].filter(Boolean);
  return tipos.map((t) => TIPOS_DISCO[t] ?? t).join(" · ") || "Otro";
}

// Datos básicos de los discos que alguien visitó, guardados en el servidor para no
// volver a pedírselos a MusicBrainz (perfiles, charts): { [mbid]: { titulo, artistas, anio, tipo } }
const discos = {
  todos() {
    return store.leer("discos", {});
  },
  de(mbid) {
    return this.todos()[mbid] ?? null;
  },
  recordar(rg) {
    if (this.de(rg.id)) return;
    const todos = this.todos();
    todos[rg.id] = {
      titulo: rg.title,
      artistas: (rg["artist-credit"] ?? []).map((c) => ({ id: c.artist.id, nombre: c.name, union: c.joinphrase ?? "" })),
      anio: rg["first-release-date"]?.slice(0, 4) ?? null,
      tipo: tipoDisco(rg),
    };
    store.guardar("discos", todos);
  },
};

function nombreArtistas(disco) {
  return disco.artistas.map((a) => a.nombre + a.union).join("");
}

// Tapa con el título detrás: si Cover Art Archive no tiene la imagen, queda el título
function tapa(mbid, titulo, tamanio = 250) {
  return `
    <div class="tapa">
      <span>${escapar(titulo)}</span>
      <img src="${tapaDe(mbid, tamanio)}" alt="${escapar(titulo)}" loading="lazy" onerror="this.remove()">
    </div>`;
}

function tarjetaDisco(mbid, { titulo, artistas = "", anio = null, tipo = "" }) {
  const local = ratings.promedio(claveDisco(mbid));
  return `
    <a class="tarjeta disco" href="#/album/${mbid}">
      ${tapa(mbid, titulo)}
      <div class="info">
        <h3>${escapar(titulo)}</h3>
        ${artistas ? `<div class="artista">${escapar(artistas)}</div>` : ""}
        <div class="meta">
          <span>${anio ?? "s/f"}${tipo ? ` · ${escapar(tipo)}` : ""}</span>
          ${local ? `<span>${local.valor.toFixed(1)}/5</span>` : ""}
        </div>
      </div>
    </a>`;
}

function duracion(ms) {
  if (!ms) return "";
  const segundos = Math.round(ms / 1000);
  return `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------
//  Usuarios (guardados en el servidor) y sesión (en este navegador)
// ---------------------------------------------------------------
// Cuentas creadas desde "Crear cuenta" (las de versiones viejas no eran una lista y se descartan)
function usuariosLocales() {
  const lista = store.leer("usuarios", []);
  return Array.isArray(lista) ? lista : [];
}

function buscarUsuario(nombre) {
  const todos = [...USUARIOS, ...usuariosLocales()];
  return todos.find((u) => u.usuario.toLowerCase() === nombre.toLowerCase());
}

const auth = {
  usuarioActual() {
    return store.leer("sesion", null);
  },
  esAdmin() {
    const usuario = this.usuarioActual();
    // Sólo los de datos/usuarios.js pueden ser admin (las cuentas creadas nunca lo son)
    return Boolean(usuario) && USUARIOS.some((u) => u.usuario === usuario && u.rol === "admin");
  },
  registrar(usuario, clave) {
    if (buscarUsuario(usuario)) throw new Error("Ese usuario ya existe.");
    store.guardar("usuarios", [...usuariosLocales(), { usuario, clave }]);
    store.guardar("sesion", usuario);
  },
  ingresar(usuario, clave) {
    const registro = buscarUsuario(usuario);
    if (!registro || registro.clave !== clave) throw new Error("Usuario o contraseña incorrectos.");
    store.guardar("sesion", registro.usuario);
  },
  salir() {
    localStorage.removeItem("sesion");
  },
};

// ---------------------------------------------------------------
//  Ratings y comentarios
//  Las películas usan su id de TMDB como clave; las series y los
//  episodios, las de claveSerie() y claveEpisodio() (los ids de TMDB
//  de películas y series se pueden repetir).
// ---------------------------------------------------------------
function claveSerie(id) {
  return `serie-${id}`;
}

function claveEpisodio(id, temporada, episodio) {
  return `serie-${id}-${temporada}x${episodio}`;
}

const ratings = {
  // { [clave]: { [usuario]: 1..5 } }
  dePelicula(id) {
    return store.leer("ratings", {})[id] ?? {};
  },
  poner(id, usuario, valor) {
    const todos = store.leer("ratings", {});
    todos[id] = { ...(todos[id] ?? {}), [usuario]: valor };
    store.guardar("ratings", todos);
  },
  quitar(id, usuario) {
    const todos = store.leer("ratings", {});
    if (todos[id]) delete todos[id][usuario];
    store.guardar("ratings", todos);
  },
  promedio(id) {
    const valores = Object.values(this.dePelicula(id));
    if (!valores.length) return null;
    return { valor: valores.reduce((a, b) => a + b, 0) / valores.length, cantidad: valores.length };
  },
};

const comentarios = {
  // { [clave]: [{ id, autor, texto, fecha }] }
  dePelicula(id) {
    return store.leer("comentarios", {})[id] ?? [];
  },
  agregar(id, autor, texto) {
    const todos = store.leer("comentarios", {});
    const nuevo = { id: Date.now().toString(36), autor, texto, fecha: new Date().toISOString() };
    todos[id] = [nuevo, ...(todos[id] ?? [])];
    store.guardar("comentarios", todos);
  },
  borrar(id, comentarioId) {
    const todos = store.leer("comentarios", {});
    todos[id] = (todos[id] ?? []).filter((c) => c.id !== comentarioId);
    store.guardar("comentarios", todos);
  },
};

// ---------------------------------------------------------------
//  Reseñas: una por usuario y por película, serie o episodio.
//  El puntaje de la reseña es el mismo que el de ratings (se mantienen iguales).
// ---------------------------------------------------------------
const resenas = {
  // { [clave]: { [usuario]: { texto, puntaje, spoiler, fecha, editada, likes: [usuarios] } } }
  deObra(clave) {
    return store.leer("resenas", {})[clave] ?? {};
  },
  de(clave, usuario) {
    return this.deObra(clave)[usuario] ?? null;
  },
  guardar(clave, usuario, { texto, puntaje, spoiler }) {
    const todas = store.leer("resenas", {});
    const previa = todas[clave]?.[usuario];
    const ahora = new Date().toISOString();
    todas[clave] = {
      ...(todas[clave] ?? {}),
      [usuario]: {
        texto, puntaje, spoiler,
        fecha: previa?.fecha ?? ahora,
        editada: previa ? ahora : null,
        likes: previa?.likes ?? [],
      },
    };
    store.guardar("resenas", todas);
    ratings.poner(clave, usuario, puntaje);
  },
  // Cuando el usuario cambia las estrellas de arriba, su reseña acompaña
  actualizarPuntaje(clave, usuario, puntaje) {
    const todas = store.leer("resenas", {});
    if (!todas[clave]?.[usuario]) return;
    todas[clave][usuario].puntaje = puntaje;
    store.guardar("resenas", todas);
  },
  borrar(clave, usuario) {
    const todas = store.leer("resenas", {});
    if (todas[clave]) delete todas[clave][usuario];
    store.guardar("resenas", todas);
  },
  alternarLike(clave, autor, usuario) {
    const todas = store.leer("resenas", {});
    const resena = todas[clave]?.[autor];
    if (!resena) return;
    resena.likes = resena.likes.includes(usuario)
      ? resena.likes.filter((u) => u !== usuario)
      : [...resena.likes, usuario];
    store.guardar("resenas", todas);
  },
  // Todas, como lista: [{ clave, autor, texto, puntaje, ... }], las más nuevas primero
  todas() {
    return Object.entries(store.leer("resenas", {}))
      .flatMap(([clave, porUsuario]) => Object.entries(porUsuario).map(([autor, r]) => ({ clave, autor, ...r })))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  },
  deUsuario(usuario) {
    return this.todas().filter((r) => r.autor === usuario);
  },
};

// ---------------------------------------------------------------
//  Amigos: uno manda la solicitud y el otro la acepta
// ---------------------------------------------------------------
const amigos = {
  // { [usuario]: { [otro]: "amigos" | "enviada" | "recibida" } }
  estado(usuario, otro) {
    return store.leer("amigos", {})[usuario]?.[otro] ?? null;
  },
  de(usuario) {
    return Object.entries(store.leer("amigos", {})[usuario] ?? {})
      .filter(([, estado]) => estado === "amigos").map(([otro]) => otro).sort();
  },
  recibidas(usuario) {
    return Object.entries(store.leer("amigos", {})[usuario] ?? {})
      .filter(([, estado]) => estado === "recibida").map(([otro]) => otro);
  },
  enviadas(usuario) {
    return Object.entries(store.leer("amigos", {})[usuario] ?? {})
      .filter(([, estado]) => estado === "enviada").map(([otro]) => otro);
  },
  cambiar(usuario, otro, suyo, delOtro) {
    const todos = store.leer("amigos", {});
    todos[usuario] = { ...(todos[usuario] ?? {}) };
    todos[otro] = { ...(todos[otro] ?? {}) };
    if (suyo) todos[usuario][otro] = suyo; else delete todos[usuario][otro];
    if (delOtro) todos[otro][usuario] = delOtro; else delete todos[otro][usuario];
    store.guardar("amigos", todos);
  },
  pedir(usuario, otro) {
    // Si el otro ya le había mandado una solicitud, pedir es aceptarla
    if (this.estado(usuario, otro) === "recibida") this.aceptar(usuario, otro);
    else this.cambiar(usuario, otro, "enviada", "recibida");
  },
  aceptar(usuario, otro) {
    this.cambiar(usuario, otro, "amigos", "amigos");
  },
  // Sirve para rechazar, cancelar una solicitud o dejar de ser amigos
  quitar(usuario, otro) {
    this.cambiar(usuario, otro, null, null);
  },
};

// Nombres de todas las cuentas (las de datos/usuarios.js y las creadas)
function todosLosUsuarios() {
  return [...new Set([...USUARIOS, ...usuariosLocales()].map((u) => u.usuario))]
    .sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------
//  Episodios vistos (cada episodio es "temporada x episodio": "1x5")
// ---------------------------------------------------------------
function codigoEpisodio(temporada, episodio) {
  return `${temporada}x${String(episodio).padStart(2, "0")}`;
}

const vistos = {
  // { [usuario]: { [serieId]: ["1x1", "1x2", ...] } }
  deSerie(serieId, usuario) {
    return new Set(store.leer("vistos", {})[usuario]?.[serieId] ?? []);
  },
  marcar(serieId, usuario, episodios, visto) {
    const todos = store.leer("vistos", {});
    const lista = new Set(todos[usuario]?.[serieId] ?? []);
    episodios.forEach((ep) => (visto ? lista.add(ep) : lista.delete(ep)));
    todos[usuario] = { ...(todos[usuario] ?? {}), [serieId]: [...lista] };
    if (!lista.size) delete todos[usuario][serieId];
    store.guardar("vistos", todos);
  },
  seriesDe(usuario) {
    return Object.keys(store.leer("vistos", {})[usuario] ?? {}).map(Number);
  },
};

// Primer episodio emitido que el usuario no vio (sin contar los especiales)
function proximoEpisodio(serie, visto) {
  const ultimo = serie.last_episode_to_air;
  if (!ultimo) return null;
  const temporadas = serie.seasons.filter((s) => s.season_number > 0)
    .sort((a, b) => a.season_number - b.season_number);
  for (const s of temporadas) {
    for (let e = 1; e <= s.episode_count; e++) {
      const t = s.season_number;
      if (t > ultimo.season_number || (t === ultimo.season_number && e > ultimo.episode_number)) return null;
      if (!visto.has(`${t}x${e}`)) return { temporada: t, episodio: e };
    }
  }
  return null;
}

function cantidadVistos(visto, temporada = null) {
  return [...visto].filter((ep) => temporada === null
    ? !ep.startsWith("0x")
    : ep.startsWith(`${temporada}x`)).length;
}

function barraProgreso(cantidad, total) {
  const porcentaje = total ? Math.min(100, Math.round((cantidad / total) * 100)) : 0;
  return `
    <div class="progreso" title="${cantidad} de ${total} episodios vistos">
      <div class="relleno" style="width:${porcentaje}%"></div>
    </div>`;
}

// ---------------------------------------------------------------
//  Catálogo y tags: lo de datos/ + los cambios de los administradores
//  (los cambios se guardan en el servidor; se pueden exportar desde #/admin)
// ---------------------------------------------------------------
function normalizarTag(texto) {
  return String(texto ?? "").trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
}

const etiquetas = {
  // { [nombre]: { descripcion } } — los borrados quedan como { borrado: true }
  todas() {
    const todas = { ...TAGS, ...store.leer("tags_admin", {}) };
    return Object.fromEntries(Object.entries(todas).filter(([, t]) => !t.borrado));
  },
  crear(nombre, descripcion = "") {
    const locales = store.leer("tags_admin", {});
    locales[nombre] = { descripcion };
    store.guardar("tags_admin", locales);
  },
  asegurar(nombres) {
    const existentes = this.todas();
    nombres.filter((n) => !existentes[n]).forEach((n) => this.crear(n));
  },
  async borrar(nombre) {
    const locales = store.leer("tags_admin", {});
    locales[nombre] = { borrado: true };
    store.guardar("tags_admin", locales);
    for (const obra of await catalogo.todas()) {
      if (obra.tags.includes(nombre)) await catalogo.quitarTag(obra.clave, nombre);
    }
  },
};

// Las películas del catálogo se guardan con su id ("27205") y las series con claveSerie() ("serie-1399")
function claveCatalogo(tipo, id) {
  return tipo === "serie" ? claveSerie(id) : String(id);
}

function desdeClaveCatalogo(clave) {
  const serie = clave.match(/^serie-(\d+)$/);
  return serie ? { tipo: "serie", id: Number(serie[1]) } : { tipo: "pelicula", id: Number(clave) };
}

function rutaObra(tipo, id) {
  return tipo === "serie" ? `#/serie/${id}` : `#/pelicula/${id}`;
}

const catalogo = {
  // Cambios de los admins: { [clave]: { titulo, tags, quitada } }
  cambios() {
    return store.leer("catalogo", {});
  },
  guardarCambio(clave, cambio) {
    const todos = this.cambios();
    todos[clave] = { ...(todos[clave] ?? {}), ...cambio };
    store.guardar("catalogo", todos);
  },
  // [{ clave, tipo, id, titulo, tags }]
  async todas() {
    const ids = await Promise.all(PELICULAS.map((p) => resolverId(p).catch(() => null)));
    const lista = new Map();
    PELICULAS.forEach((p, i) => {
      if (!ids[i]) return;
      const tipo = p.tipo === "serie" ? "serie" : "pelicula";
      const clave = claveCatalogo(tipo, ids[i]);
      lista.set(clave, { clave, tipo, id: ids[i], titulo: p.titulo, tags: p.tags ?? [] });
    });
    for (const [clave, cambio] of Object.entries(this.cambios())) {
      const previa = lista.get(clave) ?? { clave, ...desdeClaveCatalogo(clave), tags: [] };
      lista.set(clave, { ...previa, ...cambio });
    }
    return [...lista.values()].filter((o) => !o.quitada);
  },
  async buscar(clave) {
    return (await this.todas()).find((o) => o.clave === clave) ?? null;
  },
  async deTag(tag) {
    return (await this.todas()).filter((o) => o.tags.includes(tag));
  },
  agregar(clave, titulo, tags = []) {
    etiquetas.asegurar(tags);
    this.guardarCambio(clave, { titulo, tags, quitada: false });
  },
  async agregarTag(clave, titulo, tag) {
    const obra = await this.buscar(clave);
    etiquetas.asegurar([tag]);
    this.guardarCambio(clave, {
      titulo: obra?.titulo ?? titulo,
      tags: [...new Set([...(obra?.tags ?? []), tag])],
      quitada: false,
    });
  },
  async quitarTag(clave, tag) {
    const obra = await this.buscar(clave);
    if (obra) this.guardarCambio(clave, { tags: obra.tags.filter((t) => t !== tag) });
  },
  quitar(clave) {
    this.guardarCambio(clave, { quitada: true });
  },
};

function descargar(nombre, contenido) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([contenido], { type: "text/javascript" }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportarPeliculas() {
  const lineas = (await catalogo.todas()).map((o) =>
    `  { id: ${o.id}, ${o.tipo === "serie" ? `tipo: "serie", ` : ""}titulo: ${JSON.stringify(o.titulo ?? "")}, tags: ${JSON.stringify(o.tags)} },`);
  descargar("peliculas.js", `// Películas y series del catálogo, con sus tags.
// - id: el id en TMDB (aparece en la URL de themoviedb.org/movie/<id> o themoviedb.org/tv/<id>).
// - tipo: "serie" para las series; si no está, es una película.
// - Si no sabés el id, usá "buscar" (título) y "anio": la app la busca en TMDB y recuerda el resultado.
// - titulo: sólo de referencia, la app muestra el título que devuelve TMDB.
const PELICULAS = [
${lineas.join("\n")}
];
`);
}

function exportarTags() {
  descargar("tags.js", `// Tags predefinidos. La clave es el nombre del tag (lo que va después del #).
// Para asignarle un tag a una película o serie, agregalo en datos/peliculas.js.
const TAGS = ${JSON.stringify(etiquetas.todas(), null, 2)};
`);
}

// ---------------------------------------------------------------
//  Componentes de HTML
// ---------------------------------------------------------------
// TMDB llama "title" a las películas y "name" a las series
function esSerie(obra) {
  return obra.media_type === "tv" || (obra.title === undefined && obra.name !== undefined);
}

function tituloDe(obra) {
  return (esSerie(obra) ? obra.name : obra.title) ?? "";
}

function fechaDe(obra) {
  return esSerie(obra) ? obra.first_air_date : obra.release_date;
}

// Tarjeta de una película o una serie (href permite apuntar a otro lado, por ej. a un episodio)
function tarjeta(obra, href = null) {
  const serie = esSerie(obra);
  const titulo = serie ? obra.name : obra.title;
  const poster = obra.poster_path
    ? `<img class="poster" src="${IMG}w342${obra.poster_path}" alt="${escapar(titulo)}" loading="lazy">`
    : `<div class="sin-poster">${escapar(titulo)}</div>`;
  const local = ratings.promedio(serie ? claveSerie(obra.id) : obra.id);
  return `
    <a class="tarjeta" href="${href ?? (serie ? `#/serie/${obra.id}` : `#/pelicula/${obra.id}`)}">
      ${poster}
      <div class="info">
        <h3>${escapar(titulo)}</h3>
        <div class="meta">
          <span>${anio(serie ? obra.first_air_date : obra.release_date)}${serie ? " · Serie" : ""}</span>
          <span>★ ${obra.vote_average ? obra.vote_average.toFixed(1) : "–"}${local ? ` · ${local.valor.toFixed(1)}/5` : ""}</span>
        </div>
      </div>
    </a>`;
}

function tarjetaPersona(persona) {
  return `
    <a class="tarjeta" href="#/persona/${persona.id}">
      ${persona.profile_path
        ? `<img class="poster" src="${IMG}w342${persona.profile_path}" alt="${escapar(persona.name)}" loading="lazy">`
        : `<div class="sin-poster">${escapar(persona.name)}</div>`}
      <div class="info">
        <h3>${escapar(persona.name)}</h3>
        <div class="meta"><span>${escapar(DEPARTAMENTOS[persona.known_for_department] ?? persona.known_for_department ?? "")}</span></div>
      </div>
    </a>`;
}

// Puntaje de TMDB, promedio del sitio y las estrellas del usuario
// fuente: de dónde sale el puntaje externo (TMDB puntúa sobre 10, MusicBrainz sobre 5)
function bloquePuntajes(clave, votoExterno, votosExternos, fuente = { nombre: "TMDB", maximo: 10 }) {
  const usuario = auth.usuarioActual();
  const miRating = usuario ? ratings.dePelicula(clave)[usuario] ?? 0 : 0;
  const promedio = ratings.promedio(clave);
  return `
    <div class="puntajes">
      <div class="puntaje">
        <div class="valor">${votoExterno ? votoExterno.toFixed(1) : "–"}<small>/${fuente.maximo}</small></div>
        <div class="etiqueta">${fuente.nombre} · ${(votosExternos ?? 0).toLocaleString("es-AR")} votos</div>
      </div>
      <div class="puntaje">
        <div class="valor">${promedio ? promedio.valor.toFixed(1) : "–"}<small>/5</small></div>
        <div class="etiqueta">El "Santi"-Grial · ${promedio ? promedio.cantidad : 0} votos</div>
      </div>
      <div class="puntaje">
        ${usuario
          ? `<div id="mi-rating">${estrellas(miRating, true)}</div>
             <div class="etiqueta">Tu puntuación ${miRating ? `· <button class="btn-link" id="btn-quitar-rating">quitar</button>` : ""}</div>`
          : `<div class="etiqueta"><a href="#/login" class="btn chico">Ingresá para puntuar</a></div>`}
      </div>
    </div>`;
}

// ---------- Usuarios, reseñas y amigos ----------
// Círculo con la inicial; el color sale del nombre, así cada usuario tiene siempre el mismo
function avatar(nombre, grande = false) {
  const tono = [...nombre].reduce((suma, c) => suma + c.charCodeAt(0) * 7, 0) % 360;
  return `<span class="avatar ${grande ? "grande" : ""}" style="--tono:${tono}">${escapar(nombre[0].toUpperCase())}</span>`;
}

function linkUsuario(nombre) {
  return `<a class="link-usuario" href="#/usuario/${encodeURIComponent(nombre)}">${avatar(nombre)}${escapar(nombre)}</a>`;
}

// Una reseña. En los perfiles y en Comunidad se muestra de qué película o serie es (obra);
// en los perfiles no hace falta repetir el autor (autor: false).
function tarjetaResena(r, { obra = null, autor = true } = {}) {
  const usuario = auth.usuarioActual();
  const propia = r.autor === usuario;
  const esAmigo = usuario && !propia && amigos.estado(usuario, r.autor) === "amigos";
  const texto = `<p>${escapar(r.texto)}</p>`;
  return `
    <article class="resena ${propia ? "propia" : ""}" data-clave="${escapar(r.clave)}" data-autor="${escapar(r.autor)}">
      ${obra ? `
        <a href="${obra.href}">
          ${obra.imagen ? `<img class="mini" src="${obra.imagen}" alt="" loading="lazy">` : `<div class="mini sin-poster"></div>`}
        </a>` : ""}
      <div class="cuerpo">
        <div class="cabecera">
          <div class="quien">
            ${obra ? `<a class="autor" href="${obra.href}">${escapar(obra.titulo)}</a>` : ""}
            ${autor ? linkUsuario(r.autor) : ""}
            ${esAmigo ? `<span class="insignia">amigo</span>` : ""}
            ${estrellas(r.puntaje, false)}
          </div>
          <span class="fecha">${formatearFecha(r.fecha)}${r.editada ? " · editada" : ""}</span>
        </div>
        ${r.spoiler ? `
          <details class="spoiler">
            <summary>⚠ Esta reseña tiene spoilers. Mostrar</summary>
            ${texto}
          </details>` : texto}
        <div class="acciones">
          ${usuario && !propia
            ? `<button class="btn-like ${r.likes.includes(usuario) ? "activo" : ""}" data-like title="Me gusta">♥ ${r.likes.length}</button>`
            : `<span class="suave" title="Me gusta">♥ ${r.likes.length}</span>`}
          ${propia && !obra ? `
            <button class="btn-link editar" data-editar-resena>Editar</button>
            <button class="btn-link" data-borrar-resena>Borrar</button>` : ""}
        </div>
      </div>
    </article>`;
}

// Si se está editando la propia reseña (se vuelve a false al cambiar de página)
let editandoResena = false;

const ORDENES_RESENAS = {
  relevantes: "Más relevantes",
  recientes: "Más recientes",
  mejores: "Mejor puntuadas",
  peores: "Peor puntuadas",
};

function formResena(titulo, previa) {
  const editando = Boolean(previa.texto);
  return `
    <form class="form-resena" id="form-resena">
      <div class="fila-puntaje">
        <span>Tu puntuación</span>
        <div id="estrellas-resena">${estrellas(previa.puntaje ?? 0, true)}</div>
        <input type="hidden" name="puntaje" value="${previa.puntaje ?? 0}">
      </div>
      <textarea name="texto" placeholder="Escribí tu reseña de ${escapar(titulo)}…" maxlength="3000" required>${escapar(previa.texto ?? "")}</textarea>
      <div class="fila-form">
        <label class="check-visto"><input type="checkbox" name="spoiler" ${previa.spoiler ? "checked" : ""}> Contiene spoilers</label>
        <p class="mensaje-error crece" id="error-resena"></p>
        ${editando ? `<button type="button" class="btn secundario" id="cancelar-resena">Cancelar</button>` : ""}
        <button class="btn">${editando ? "Guardar cambios" : "Publicar reseña"}</button>
      </div>
    </form>`;
}

function seccionResenas(clave, titulo) {
  const usuario = auth.usuarioActual();
  const mia = usuario ? resenas.de(clave, usuario) : null;
  const orden = store.leer("orden_resenas", "relevantes");
  const misAmigos = new Set(usuario ? amigos.de(usuario) : []);
  const lista = Object.entries(resenas.deObra(clave)).map(([autor, r]) => ({ clave, autor, ...r }));
  const porFecha = (a, b) => b.fecha.localeCompare(a.fecha);
  const comparar = {
    // Primero la propia, después las de amigos y después las que más gustaron
    relevantes: (a, b) => (b.autor === usuario) - (a.autor === usuario)
      || misAmigos.has(b.autor) - misAmigos.has(a.autor)
      || b.likes.length - a.likes.length
      || porFecha(a, b),
    recientes: porFecha,
    mejores: (a, b) => b.puntaje - a.puntaje || porFecha(a, b),
    peores: (a, b) => a.puntaje - b.puntaje || porFecha(a, b),
  }[orden] ?? porFecha;
  const visibles = lista.filter((r) => !(editandoResena && r.autor === usuario)).sort(comparar);
  const viejos = comentarios.dePelicula(clave);

  return `
    <section class="seccion" id="resenas">
      <h2>Reseñas (${lista.length})</h2>
      ${!usuario
        ? `<p class="aviso"><a href="#/login" style="color:var(--acento)">Ingresá</a> para escribir una reseña.</p>`
        : !mia || editandoResena
          ? formResena(titulo, mia ?? { puntaje: ratings.dePelicula(clave)[usuario] ?? 0 })
          : ""}
      ${lista.length > 1 ? `
        <div class="controles">
          <label>Ordenar por
            <select id="orden-resenas">
              ${Object.entries(ORDENES_RESENAS).map(([valor, texto]) =>
                `<option value="${valor}" ${orden === valor ? "selected" : ""}>${texto}</option>`).join("")}
            </select>
          </label>
        </div>` : ""}
      <div class="resenas">
        ${visibles.map((r) => tarjetaResena(r)).join("")
          || (editandoResena ? "" : `<p class="suave">Todavía no hay reseñas. ¡Escribí la primera!</p>`)}
      </div>
      ${viejos.length ? `
        <details class="desplegable">
          <summary>Comentarios anteriores (${viejos.length})</summary>
          <div class="comentarios">
            ${viejos.map((c) => `
              <div class="comentario">
                <div class="cabecera">
                  ${linkUsuario(c.autor)}
                  <div>
                    <span class="fecha">${formatearFecha(c.fecha)}</span>
                    ${c.autor === usuario ? `<button class="btn-link" data-borrar="${c.id}">Borrar</button>` : ""}
                  </div>
                </div>
                <p>${escapar(c.texto)}</p>
              </div>`).join("")}
          </div>
        </details>` : ""}
    </section>`;
}

// Botones de "me gusta" de las reseñas (en las páginas de obras, perfiles y Comunidad)
function eventosLikes() {
  const usuario = auth.usuarioActual();
  if (!usuario) return;
  document.querySelectorAll("[data-like]").forEach((b) => {
    b.onclick = () => {
      const { clave, autor } = b.closest(".resena").dataset;
      resenas.alternarLike(clave, autor, usuario);
      recargar();
    };
  });
}

// Botón para agregar, aceptar, rechazar o quitar a otro usuario
function botonAmistad(otro) {
  const usuario = auth.usuarioActual();
  if (!usuario || usuario === otro) return "";
  const boton = (accion, texto, clase = "") =>
    `<button class="btn chico ${clase}" data-amistad="${accion}" data-usuario="${escapar(otro)}">${texto}</button>`;
  switch (amigos.estado(usuario, otro)) {
    case "amigos": return boton("quitar", "✓ Amigos", "secundario");
    case "enviada": return boton("cancelar", "Solicitud enviada · cancelar", "secundario");
    case "recibida": return boton("aceptar", "Aceptar solicitud") + boton("rechazar", "Rechazar", "secundario");
    default: return boton("pedir", "+ Agregar amigo");
  }
}

function eventosAmistad() {
  const usuario = auth.usuarioActual();
  document.querySelectorAll("[data-amistad]").forEach((b) => {
    b.onclick = () => {
      const otro = b.dataset.usuario;
      switch (b.dataset.amistad) {
        case "pedir": amigos.pedir(usuario, otro); break;
        case "aceptar": amigos.aceptar(usuario, otro); break;
        case "quitar":
          if (!confirm(`¿Quitar a ${otro} de tus amigos?`)) return;
          amigos.quitar(usuario, otro);
          break;
        default: amigos.quitar(usuario, otro); // cancelar o rechazar
      }
      renderZonaUsuario();
      recargar();
    };
  });
}

// Recomendaciones y "similares" de TMDB juntas, las más conocidas primero
// (la obra se pide con append_to_response: "recommendations,similar")
function seccionSimilares(obra) {
  const todas = [...(obra.recommendations?.results ?? []), ...(obra.similar?.results ?? [])];
  const lista = [...new Map(todas.map((o) => [o.id, o])).values()]
    .filter((o) => o.poster_path && o.id !== obra.id)
    .sort((a, b) => b.vote_count - a.vote_count)
    .slice(0, 15);
  return lista.length ? `
    <section class="seccion" style="margin-top:32px">
      <h2>Similares</h2>
      ${carrusel(lista, lista.length, "")}
    </section>` : "";
}

// Links a las páginas de personas: [{ id, name }] → "Fulano, Mengano" (sin repetir)
function linksPersonas(personas) {
  const unicas = [...new Map(personas.map((p) => [p.id, p])).values()];
  return unicas.map((p) => `<a class="link-persona" href="#/persona/${p.id}">${escapar(p.name)}</a>`).join(", ");
}

// personas: [{ id, name, profile_path, character }]
function seccionReparto(personas, titulo = "Reparto") {
  return `
    <section class="seccion" style="margin-top:32px">
      <h2>${titulo}</h2>
      <div class="reparto">
        ${personas.slice(0, 12).map((a) => `
          <a class="actor" href="#/persona/${a.id}">
            ${a.profile_path
              ? `<img src="${IMG}w185${a.profile_path}" alt="${escapar(a.name)}" loading="lazy">`
              : `<div class="sin-poster">Sin foto</div>`}
            ${escapar(a.name)}
            <span>${escapar(a.character)}</span>
          </a>`).join("") || `<p class="suave">Sin datos de reparto.</p>`}
      </div>
    </section>`;
}

// Si no hay trailer en español, se busca en inglés
async function buscarTrailer(videos, rutaVideos) {
  const esTrailer = (v) => v.site === "YouTube" && v.type === "Trailer";
  if (!videos.some(esTrailer)) videos = (await tmdb(rutaVideos, { language: "en-US" })).results;
  return videos.find(esTrailer);
}

function seccionTrailer(trailer) {
  return trailer ? `
    <section class="seccion" style="margin-top:32px">
      <h2>Tráiler</h2>
      <iframe class="trailer" src="https://www.youtube.com/embed/${trailer.key}" title="Tráiler" allowfullscreen></iframe>
    </section>` : "";
}

function estrellas(valor, editable) {
  let html = `<div class="estrellas ${editable ? "" : "solo-lectura"}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<button type="button" data-valor="${i}" class="${i <= valor ? "activa" : ""}" ${editable ? "" : "disabled"} aria-label="${i} estrellas">★</button>`;
  }
  return html + "</div>";
}

// Listado con orden y filtros por tipo y género (para el catálogo y las páginas de tags).
// Necesita películas y series con detalle completo (que traigan "genres").
let pelisListado = [];

const TIPOS_LISTADO = {
  "": "Todo",
  pelicula: "Películas",
  serie: "Series",
};

const ORDENES = {
  genero: "Género",
  titulo: "Título",
  anio: "Año",
  puntaje: "Puntaje TMDB",
};

function preferenciasListado() {
  return { orden: "genero", genero: "", tipo: "", ...store.leer("listado", {}) };
}

function listado(pelis) {
  pelisListado = pelis;
  const generos = [...new Set(pelis.flatMap((p) => p.genres.map((g) => g.name)))]
    .sort((a, b) => a.localeCompare(b));
  const pref = preferenciasListado();
  if (pref.genero && !generos.includes(pref.genero)) {
    pref.genero = "";
    store.guardar("listado", pref);
  }
  // El filtro de tipo sólo tiene sentido si hay películas y series mezcladas
  const mezclado = pelis.some(esSerie) && !pelis.every(esSerie);

  return `
    <div class="controles">
      ${mezclado ? `
        <label>Mostrar
          <select id="filtro-tipo">
            ${Object.entries(TIPOS_LISTADO).map(([valor, texto]) =>
              `<option value="${valor}" ${pref.tipo === valor ? "selected" : ""}>${texto}</option>`).join("")}
          </select>
        </label>` : ""}
      <label>Ordenar por
        <select id="orden">
          ${Object.entries(ORDENES).map(([valor, texto]) =>
            `<option value="${valor}" ${pref.orden === valor ? "selected" : ""}>${texto}</option>`).join("")}
        </select>
      </label>
      <label>Género
        <select id="filtro-genero">
          <option value="">Todos</option>
          ${generos.map((g) =>
            `<option value="${escapar(g)}" ${pref.genero === g ? "selected" : ""}>${escapar(g)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div id="resultado-listado">${dibujarListado()}</div>`;
}

function dibujarListado() {
  const { orden, genero, tipo } = preferenciasListado();
  const pelis = pelisListado.filter((p) =>
    (!genero || p.genres.some((g) => g.name === genero)) &&
    (!tipo || esSerie(p) === (tipo === "serie")));
  if (!pelis.length) return `<p class="suave">No hay nada para mostrar.</p>`;

  const porAnio = (a, b) => (fechaDe(a) || "").localeCompare(fechaDe(b) || "");

  if (orden === "genero") {
    // Cada película va en su género principal (el primero que da TMDB)
    const grupos = {};
    for (const p of [...pelis].sort(porAnio)) {
      const g = genero || p.genres[0]?.name || "Sin género";
      (grupos[g] ??= []).push(p);
    }
    return Object.keys(grupos).sort((a, b) => a.localeCompare(b)).map((g) => `
      <h3 class="titulo-genero">${escapar(g)} <span class="suave">(${grupos[g].length})</span></h3>
      <div class="grilla">${grupos[g].map((o) => tarjeta(o)).join("")}</div>`).join("");
  }

  const comparar = {
    titulo: (a, b) => tituloDe(a).localeCompare(tituloDe(b)),
    anio: porAnio,
    puntaje: (a, b) => b.vote_average - a.vote_average,
  }[orden] ?? porAnio;
  return `<div class="grilla">${[...pelis].sort(comparar).map((o) => tarjeta(o)).join("")}</div>`;
}

function eventosListado() {
  const orden = document.getElementById("orden");
  const genero = document.getElementById("filtro-genero");
  const tipo = document.getElementById("filtro-tipo");
  if (!orden) return;
  const actualizar = () => {
    store.guardar("listado", { orden: orden.value, genero: genero.value, tipo: tipo?.value ?? "" });
    document.getElementById("resultado-listado").innerHTML = dibujarListado();
  };
  orden.onchange = actualizar;
  genero.onchange = actualizar;
  if (tipo) tipo.onchange = actualizar;
}

// obras: [{ tipo, id }] (como las de catalogo.todas())
async function detallesDe(obras) {
  return (await Promise.all(obras.map((o) =>
    tmdb(o.tipo === "serie" ? `/tv/${o.id}` : `/movie/${o.id}`).catch(() => null)))).filter(Boolean);
}

function avisoSinCredenciales() {
  return `
    <div class="aviso error">
      <strong>Falta la credencial de TMDB.</strong><br>
      Abrí <code>config.js</code> y pegá tu <em>API Read Access Token</em> en <code>TMDB_TOKEN</code>
      (o tu API Key en <code>TMDB_API_KEY</code>). La conseguís en
      <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a>.
    </div>`;
}

function avisoError(error) {
  return `<div class="aviso error">No se pudo cargar la información: ${escapar(error.message)}</div>`;
}

function renderMenu() {
  document.getElementById("menu").innerHTML = `
    <a href="#/">Inicio</a>
    <a href="#/catalogo">Catálogo</a>
    <a href="#/series">Series</a>
    <a href="#/tags">Tags</a>
    <a href="#/musica">Música</a>
    <a href="#/comunidad">Comunidad</a>
    ${auth.esAdmin() ? `<a href="#/admin">⚙ Admin</a>` : ""}`;
}

function renderZonaUsuario() {
  renderMenu();
  const zona = document.getElementById("zona-usuario");
  const usuario = auth.usuarioActual();
  if (usuario) {
    const solicitudes = amigos.recibidas(usuario).length;
    zona.innerHTML = `
      <a class="link-usuario" href="#/usuario/${encodeURIComponent(usuario)}">
        ${avatar(usuario)}${escapar(usuario)}${auth.esAdmin() ? ` <span class="insignia">admin</span>` : ""}
        ${solicitudes ? `<span class="contador" title="Solicitudes de amistad">${solicitudes}</span>` : ""}
      </a>
      <button class="btn secundario chico" id="btn-salir">Salir</button>`;
    document.getElementById("btn-salir").onclick = () => {
      auth.salir();
      renderZonaUsuario();
      router();
    };
  } else {
    zona.innerHTML = `<a class="btn chico" href="#/login">Ingresar</a>`;
  }
}

// ---------------------------------------------------------------
//  Vistas
// ---------------------------------------------------------------
async function vistaInicio() {
  if (!hayCredenciales()) return avisoSinCredenciales();

  const [tendencias, mejores, series, secciones] = await Promise.all([
    tmdb("/trending/movie/week"),
    tmdb("/movie/top_rated"),
    tmdb("/trending/tv/week"),
    Promise.all(Object.keys(etiquetas.todas()).map(async (tag) => {
      const obras = await catalogo.deTag(tag);
      return { tag, total: obras.length, pelis: await detallesDe(obras.slice(0, 6)) };
    })),
  ]);
  const destacada = tendencias.results.find((p) => p.backdrop_path) ?? tendencias.results[0];
  const usuario = auth.usuarioActual();

  return `
    <section class="hero" style="background-image:url('${IMG}original${destacada.backdrop_path}')">
      <div class="contenido">
        <p class="suave">${usuario ? `Hola, ${escapar(usuario)} 👋 · ` : ""}Tendencia de la semana</p>
        <h1>${escapar(destacada.title)}</h1>
        <p>${escapar(destacada.overview.slice(0, 220))}${destacada.overview.length > 220 ? "…" : ""}</p>
        <a class="btn" href="#/pelicula/${destacada.id}">Ver película</a>
      </div>
    </section>

    ${secciones.filter((s) => s.total).map((s) => `
      <section class="seccion">
        <h2>#${escapar(s.tag)} <a href="#/tag/${encodeURIComponent(s.tag)}">Ver todas (${s.total}) →</a></h2>
        <div class="grilla">${s.pelis.map((o) => tarjeta(o)).join("")}</div>
      </section>`).join("")}

    <section class="seccion">
      <h2>Tendencias de la semana</h2>
      <div class="grilla">${tendencias.results.slice(0, 12).map((p) => tarjeta(p)).join("")}</div>
    </section>

    <section class="seccion">
      <h2>Series en tendencia <a href="#/series">Ver series →</a></h2>
      <div class="grilla">${series.results.slice(0, 12).map((s) => tarjeta(s)).join("")}</div>
    </section>

    <section class="seccion">
      <h2>Mejor puntuadas</h2>
      <div class="grilla">${mejores.results.slice(0, 12).map((o) => tarjeta(o)).join("")}</div>
    </section>`;
}

async function vistaPelicula(id) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  id = Number(id);

  const peli = await tmdb(`/movie/${id}`, { append_to_response: "credits,videos,recommendations,similar" });
  const trailer = await buscarTrailer(peli.videos.results, `/movie/${id}/videos`);

  const director = peli.credits.crew.find((c) => c.job === "Director");
  const enCatalogo = await catalogo.buscar(claveCatalogo("pelicula", id));
  obraActual = { clave: claveCatalogo("pelicula", id), titulo: peli.title, tipo: "pelicula" };

  document.title = `${peli.title} · El "Santi"-Grial`;

  return `
    <div class="fondo-peli" style="${peli.backdrop_path ? `background-image:url('${IMG}w1280${peli.backdrop_path}')` : ""}">
      <div class="detalle">
        ${peli.poster_path
          ? `<img class="poster" src="${IMG}w500${peli.poster_path}" alt="${escapar(peli.title)}">`
          : `<div class="sin-poster">Sin póster</div>`}
        <div>
          <h1>${escapar(peli.title)} <span class="suave">(${anio(peli.release_date)})</span></h1>
          ${peli.tagline ? `<p class="eslogan">${escapar(peli.tagline)}</p>` : ""}
          <div class="datos">
            ${peli.runtime ? `<span>⏱ ${Math.floor(peli.runtime / 60)}h ${peli.runtime % 60}m</span>` : ""}
            ${director ? `<span>🎬 ${linksPersonas([director])}</span>` : ""}
            ${peli.original_title !== peli.title ? `<span>Título original: ${escapar(peli.original_title)}</span>` : ""}
          </div>

          <div class="tags">
            ${peli.genres.map((g) => `<span class="tag genero">${escapar(g.name)}</span>`).join("")}
          </div>
          ${bloqueTagsCatalogo(enCatalogo)}

          <p>${escapar(peli.overview || "Sin sinopsis disponible.")}</p>

          ${bloquePuntajes(id, peli.vote_average, peli.vote_count)}
        </div>
      </div>
    </div>

    ${seccionTrailer(trailer)}
    ${seccionReparto(peli.credits.cast)}
    ${seccionSimilares(peli)}
    ${seccionResenas(id, peli.title)}`;
}

// La película o serie que se está viendo: { clave (del catálogo), titulo, tipo }
let obraActual = null;

// Tags del catálogo de una película o serie y, para los admins, el formulario para editarlos
function bloqueTagsCatalogo(enCatalogo) {
  const admin = auth.esAdmin();
  return `
    <div class="tags">
      ${(enCatalogo?.tags ?? []).map((t) => `
        <span class="tag especial">
          <a href="#/tag/${encodeURIComponent(t)}">#${escapar(t)}</a>
          ${admin ? `<button class="quitar-tag" data-quitar-tag="${escapar(t)}" title="Quitar tag">✕</button>` : ""}
        </span>`).join("")}
    </div>
    ${admin ? `
      <form class="fila-form" id="form-tag">
        <input type="text" name="tag" list="lista-tags" placeholder="Agregar tag…" required>
        ${datalistTags()}
        <button class="btn chico">+ Tag</button>
        ${enCatalogo
          ? `<button type="button" class="btn secundario chico" id="btn-quitar-catalogo">Quitar del catálogo</button>`
          : `<button type="button" class="btn secundario chico" id="btn-agregar-catalogo">Agregar al catálogo</button>`}
      </form>` : ""}`;
}

function eventosTagsCatalogo() {
  if (!auth.esAdmin()) return;
  const { clave, titulo, tipo } = obraActual;

  document.getElementById("form-tag").onsubmit = async (e) => {
    e.preventDefault();
    const tag = normalizarTag(e.target.elements.tag.value);
    if (!tag) return;
    await catalogo.agregarTag(clave, titulo, tag);
    renderMenu();
    recargar();
  };

  document.querySelectorAll("[data-quitar-tag]").forEach((b) => {
    b.onclick = async () => {
      await catalogo.quitarTag(clave, b.dataset.quitarTag);
      recargar();
    };
  });

  const agregar = document.getElementById("btn-agregar-catalogo");
  if (agregar) agregar.onclick = () => { catalogo.agregar(clave, titulo); recargar(); };

  const quitar = document.getElementById("btn-quitar-catalogo");
  if (quitar) quitar.onclick = () => {
    if (confirm(`¿Quitar esta ${tipo === "serie" ? "serie" : "película"} del catálogo? Se le borran también los tags.`)) {
      catalogo.quitar(clave);
      recargar();
    }
  };
}

// Estrellas, reseñas y comentarios de una película, serie o episodio (después de renderizar)
function eventosOpiniones(clave) {
  eventosLikes();
  const usuario = auth.usuarioActual();
  if (!usuario) return;

  document.querySelectorAll("#mi-rating button").forEach((b) => {
    b.onclick = () => {
      ratings.poner(clave, usuario, Number(b.dataset.valor));
      resenas.actualizarPuntaje(clave, usuario, Number(b.dataset.valor));
      recargar();
    };
  });

  const quitarRating = document.getElementById("btn-quitar-rating");
  if (quitarRating) quitarRating.onclick = () => {
    // Una reseña no puede quedar sin puntaje
    if (resenas.de(clave, usuario)) {
      if (!confirm("Tu reseña usa esta puntuación. ¿Borrar la puntuación y la reseña?")) return;
      resenas.borrar(clave, usuario);
    }
    ratings.quitar(clave, usuario);
    recargar();
  };

  const form = document.getElementById("form-resena");
  if (form) {
    const error = document.getElementById("error-resena");
    form.querySelectorAll("#estrellas-resena button").forEach((b) => {
      b.onclick = () => {
        form.elements.puntaje.value = b.dataset.valor;
        form.querySelectorAll("#estrellas-resena button").forEach((x) =>
          x.classList.toggle("activa", Number(x.dataset.valor) <= Number(b.dataset.valor)));
        error.textContent = "";
      };
    });

    form.onsubmit = (e) => {
      e.preventDefault();
      const puntaje = Number(form.elements.puntaje.value);
      const texto = form.elements.texto.value.trim();
      if (!puntaje) return (error.textContent = "Elegí una puntuación de 1 a 5 estrellas.");
      if (texto.length < 10) return (error.textContent = "La reseña tiene que tener al menos 10 caracteres.");
      resenas.guardar(clave, usuario, { texto, puntaje, spoiler: form.elements.spoiler.checked });
      editandoResena = false;
      recargar();
    };

    const cancelar = document.getElementById("cancelar-resena");
    if (cancelar) cancelar.onclick = () => { editandoResena = false; recargar(); };
  }

  const editar = document.querySelector("[data-editar-resena]");
  if (editar) editar.onclick = () => { editandoResena = true; recargar(); };

  const borrar = document.querySelector("[data-borrar-resena]");
  if (borrar) borrar.onclick = () => {
    if (!confirm("¿Borrar tu reseña? Tu puntuación se mantiene.")) return;
    resenas.borrar(clave, usuario);
    recargar();
  };

  const orden = document.getElementById("orden-resenas");
  if (orden) orden.onchange = () => { store.guardar("orden_resenas", orden.value); recargar(); };

  // Comentarios de antes de las reseñas
  document.querySelectorAll("[data-borrar]").forEach((b) => {
    b.onclick = () => {
      if (confirm("¿Borrar este comentario?")) {
        comentarios.borrar(clave, b.dataset.borrar);
        recargar();
      }
    };
  });
}

// Eventos de la página de película (se enganchan después de renderizar)
function eventosPelicula(id) {
  eventosOpiniones(Number(id));
  eventosTagsCatalogo();
  eventosCarruseles();
}

function datalistTags() {
  return `<datalist id="lista-tags">
    ${Object.keys(etiquetas.todas()).map((t) => `<option value="${escapar(t)}">`).join("")}
  </datalist>`;
}

// ---------- Índice de tags: una fila con carrusel por cada tag ----------
const CANTIDAD_CARRUSEL = 12;

function carrusel(obras, total, rutaTodas) {
  return `
    <div class="carrusel">
      <button class="flecha anterior" data-mover="-1" aria-label="Anterior">‹</button>
      <div class="pista">
        ${obras.map((o) => tarjeta(o)).join("")}
        ${total > obras.length ? `
          <a class="tarjeta ver-todas" href="${rutaTodas}">
            <span>Ver todas<br><strong>${total}</strong></span>
          </a>` : ""}
      </div>
      <button class="flecha siguiente" data-mover="1" aria-label="Siguiente">›</button>
    </div>`;
}

async function vistaTags() {
  if (!hayCredenciales()) return avisoSinCredenciales();
  const tags = etiquetas.todas();
  const filas = await Promise.all(Object.keys(tags).map(async (tag) => {
    const obras = await catalogo.deTag(tag);
    return { tag, obras, detalles: await detallesDe(obras.slice(0, CANTIDAD_CARRUSEL)) };
  }));
  document.title = `Tags · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>Tags</h2>
      ${filas.map(({ tag, obras, detalles }) => {
        const ruta = `#/tag/${encodeURIComponent(tag)}`;
        return `
          <div class="fila-tag">
            <h3>
              <a class="tag especial grande" href="${ruta}">#${escapar(tag)}</a>
              <span class="suave">${obras.length ? cantidadObras(obras) : ""}</span>
              ${obras.length ? `<a class="ver-tag" href="${ruta}">Ver todas →</a>` : ""}
            </h3>
            ${tags[tag].descripcion ? `<p class="suave">${escapar(tags[tag].descripcion)}</p>` : ""}
            ${detalles.length
              ? carrusel(detalles, obras.length, ruta)
              : `<p class="suave">Todavía no hay películas ni series con este tag.</p>`}
          </div>`;
      }).join("") || `<p class="suave">Todavía no hay tags.</p>`}
    </section>`;
}

// Flechas de los carruseles: corren la pista casi un ancho de pantalla
function eventosCarruseles() {
  document.querySelectorAll(".carrusel").forEach((c) => {
    const pista = c.querySelector(".pista");
    // Con unos píxeles de margen: el scroll-snap puede dejar la pista corrida por el padding
    const actualizar = () => {
      c.querySelector(".anterior").disabled = pista.scrollLeft <= 5;
      c.querySelector(".siguiente").disabled = pista.scrollLeft + pista.clientWidth >= pista.scrollWidth - 5;
    };
    c.querySelectorAll("[data-mover]").forEach((b) => {
      b.onclick = () => pista.scrollBy({ left: Number(b.dataset.mover) * pista.clientWidth * 0.8, behavior: "smooth" });
    });
    pista.onscroll = actualizar;
    actualizar();
  });
}

async function vistaTag(tag) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  tag = normalizarTag(decodeURIComponent(tag));

  const pelis = await detallesDe(await catalogo.deTag(tag));
  const descripcion = etiquetas.todas()[tag]?.descripcion;
  document.title = `#${tag} · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>#${escapar(tag)} <span class="suave" style="font-size:1rem">${cantidadObras(pelis)}</span></h2>
      ${descripcion ? `<p class="suave">${escapar(descripcion)}</p>` : ""}
      ${pelis.length ? listado(pelis) : `<p class="suave">No hay películas ni series con este tag.</p>`}
    </section>`;
}

// "12 películas · 3 series" (sirve con datos de TMDB o con entradas del catálogo, que traen "tipo")
function cantidadObras(obras) {
  const series = obras.filter((o) => (o.tipo ? o.tipo === "serie" : esSerie(o))).length;
  const pelis = obras.length - series;
  const partes = [];
  if (pelis || !series) partes.push(`${pelis} ${pelis === 1 ? "película" : "películas"}`);
  if (series) partes.push(`${series} ${series === 1 ? "serie" : "series"}`);
  return partes.join(" · ");
}

async function vistaCatalogo() {
  if (!hayCredenciales()) return avisoSinCredenciales();
  const pelis = await detallesDe(await catalogo.todas());
  document.title = `Catálogo · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>Catálogo <span class="suave" style="font-size:1rem">${cantidadObras(pelis)}</span></h2>
      ${pelis.length ? listado(pelis) : `<p class="suave">El catálogo está vacío.</p>`}
    </section>`;
}

// ---------- Series ----------
const ESTADOS_SERIE = {
  "Returning Series": "En emisión",
  Ended: "Finalizada",
  Canceled: "Cancelada",
  "In Production": "En producción",
  Planned: "Planeada",
  Pilot: "Piloto",
};

function rutaTemporada(id, temporada) {
  return `#/serie/${id}/temporada/${temporada}`;
}

function rutaEpisodio(id, temporada, episodio) {
  return `${rutaTemporada(id, temporada)}/episodio/${episodio}`;
}

function aniosSerie(serie) {
  const desde = anio(serie.first_air_date);
  if (["Ended", "Canceled"].includes(serie.status)) {
    const hasta = anio(serie.last_air_date);
    return hasta === desde ? desde : `${desde}–${hasta}`;
  }
  return `${desde}–`;
}

// Las temporadas en orden, con los especiales (temporada 0) al final
function temporadasDe(serie) {
  return [...serie.seasons].sort((a, b) =>
    (a.season_number || Infinity) - (b.season_number || Infinity));
}

async function vistaSeries() {
  if (!hayCredenciales()) return avisoSinCredenciales();
  const usuario = auth.usuarioActual();

  const [tendencias, populares, mejores, siguiendo] = await Promise.all([
    tmdb("/trending/tv/week"),
    tmdb("/tv/popular"),
    tmdb("/tv/top_rated"),
    Promise.all((usuario ? vistos.seriesDe(usuario) : []).map((id) => tmdb(`/tv/${id}`).catch(() => null))),
  ]);
  const destacada = tendencias.results.find((s) => s.backdrop_path) ?? tendencias.results[0];
  document.title = `Series · El "Santi"-Grial`;

  const seccion = (titulo, series) => `
    <section class="seccion">
      <h2>${titulo}</h2>
      <div class="grilla">${series.slice(0, 12).map((s) => tarjeta(s)).join("")}</div>
    </section>`;

  return `
    <section class="hero" style="background-image:url('${IMG}original${destacada.backdrop_path}')">
      <div class="contenido">
        <p class="suave">Serie en tendencia de la semana</p>
        <h1>${escapar(destacada.name)}</h1>
        <p>${escapar(destacada.overview.slice(0, 220))}${destacada.overview.length > 220 ? "…" : ""}</p>
        <a class="btn" href="#/serie/${destacada.id}">Ver serie</a>
      </div>
    </section>

    ${siguiendo.some(Boolean) ? `
      <section class="seccion">
        <h2>Seguís viendo</h2>
        <div class="grilla">
          ${siguiendo.filter(Boolean).map((s) => {
            const visto = vistos.deSerie(s.id, usuario);
            return `
              <div>
                ${tarjeta(s)}
                ${barraProgreso(cantidadVistos(visto), s.number_of_episodes)}
                <div class="suave nota">${cantidadVistos(visto)} de ${s.number_of_episodes} episodios</div>
              </div>`;
          }).join("")}
        </div>
      </section>` : ""}

    ${seccion("Tendencias de la semana", tendencias.results)}
    ${seccion("Populares", populares.results)}
    ${seccion("Mejor puntuadas", mejores.results)}`;
}

async function vistaSerie(id) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  id = Number(id);

  const serie = await tmdb(`/tv/${id}`, { append_to_response: "aggregate_credits,videos,recommendations,similar" });
  const trailer = await buscarTrailer(serie.videos.results, `/tv/${id}/videos`);
  const enCatalogo = await catalogo.buscar(claveCatalogo("serie", id));
  obraActual = { clave: claveCatalogo("serie", id), titulo: serie.name, tipo: "serie" };
  const usuario = auth.usuarioActual();
  const visto = usuario ? vistos.deSerie(id, usuario) : new Set();
  const siguiente = usuario ? proximoEpisodio(serie, visto) : null;
  const proximo = serie.next_episode_to_air;
  const reparto = serie.aggregate_credits.cast.map((a) => ({
    ...a,
    character: [a.roles?.[0]?.character, a.total_episode_count && `${a.total_episode_count} episodios`]
      .filter(Boolean).join(" · "),
  }));

  document.title = `${serie.name} · El "Santi"-Grial`;

  return `
    <div class="fondo-peli" style="${serie.backdrop_path ? `background-image:url('${IMG}w1280${serie.backdrop_path}')` : ""}">
      <div class="detalle">
        ${serie.poster_path
          ? `<img class="poster" src="${IMG}w500${serie.poster_path}" alt="${escapar(serie.name)}">`
          : `<div class="sin-poster">Sin póster</div>`}
        <div>
          <h1>${escapar(serie.name)} <span class="suave">(${aniosSerie(serie)})</span></h1>
          ${serie.tagline ? `<p class="eslogan">${escapar(serie.tagline)}</p>` : ""}
          <div class="datos">
            <span>📺 ${escapar(ESTADOS_SERIE[serie.status] ?? serie.status)}</span>
            <span>${serie.number_of_seasons} temporadas · ${serie.number_of_episodes} episodios</span>
            ${serie.episode_run_time?.[0] ? `<span>⏱ ${serie.episode_run_time[0]} min</span>` : ""}
            ${serie.created_by.length ? `<span>🎬 ${linksPersonas(serie.created_by)}</span>` : ""}
            ${serie.networks.length ? `<span>${serie.networks.map((n) => escapar(n.name)).join(", ")}</span>` : ""}
            ${serie.original_name !== serie.name ? `<span>Título original: ${escapar(serie.original_name)}</span>` : ""}
          </div>

          <div class="tags">
            ${serie.genres.map((g) => `<span class="tag genero">${escapar(g.name)}</span>`).join("")}
          </div>
          ${bloqueTagsCatalogo(enCatalogo)}

          <p>${escapar(serie.overview || "Sin sinopsis disponible.")}</p>

          ${usuario ? `
            <div class="seguimiento">
              ${barraProgreso(cantidadVistos(visto), serie.number_of_episodes)}
              <span class="suave">Viste ${cantidadVistos(visto)} de ${serie.number_of_episodes} episodios</span>
              ${siguiente ? `
                <a class="btn chico" href="${rutaEpisodio(id, siguiente.temporada, siguiente.episodio)}">
                  ▶ Seguir con ${codigoEpisodio(siguiente.temporada, siguiente.episodio)}
                </a>` : ""}
            </div>` : ""}
          ${proximo ? `
            <p class="suave">
              Próximo episodio: <a href="${rutaEpisodio(id, proximo.season_number, proximo.episode_number)}" style="color:var(--acento)">
              ${codigoEpisodio(proximo.season_number, proximo.episode_number)} ${escapar(proximo.name)}</a>
              ${proximo.air_date ? `· ${formatearDia(proximo.air_date)}` : ""}
            </p>` : ""}

          ${bloquePuntajes(claveSerie(id), serie.vote_average, serie.vote_count)}
        </div>
      </div>
    </div>

    <section class="seccion" style="margin-top:32px">
      <h2>Temporadas</h2>
      <div class="grilla">
        ${temporadasDe(serie).map((t) => `
          <a class="tarjeta" href="${rutaTemporada(id, t.season_number)}">
            ${t.poster_path
              ? `<img class="poster" src="${IMG}w342${t.poster_path}" alt="${escapar(t.name)}" loading="lazy">`
              : `<div class="sin-poster">${escapar(t.name)}</div>`}
            <div class="info">
              <h3>${escapar(t.name)}</h3>
              <div class="meta">
                <span>${anio(t.air_date)}</span>
                <span>${t.episode_count} ep.</span>
              </div>
              ${usuario && t.episode_count ? barraProgreso(cantidadVistos(visto, t.season_number), t.episode_count) : ""}
            </div>
          </a>`).join("")}
      </div>
    </section>

    ${seccionTrailer(trailer)}
    ${seccionReparto(reparto)}
    ${seccionSimilares(serie)}
    ${seccionResenas(claveSerie(id), serie.name)}`;
}

function eventosSerie(id) {
  eventosOpiniones(claveSerie(id));
  eventosTagsCatalogo();
  eventosCarruseles();
}

let temporadaActual = null;

async function vistaTemporada(id, numero) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  id = Number(id);
  numero = Number(numero);

  const [serie, temporada] = await Promise.all([tmdb(`/tv/${id}`), tmdb(`/tv/${id}/season/${numero}`)]);
  const usuario = auth.usuarioActual();
  const visto = usuario ? vistos.deSerie(id, usuario) : new Set();
  const emitidos = temporada.episodes.filter((e) => yaSalio(e.air_date)).map((e) => `${numero}x${e.episode_number}`);
  const todosVistos = emitidos.length > 0 && emitidos.every((ep) => visto.has(ep));
  temporadaActual = { emitidos, todosVistos };

  document.title = `${serie.name} · ${temporada.name} · El "Santi"-Grial`;

  return `
    <div class="fondo-peli" style="${serie.backdrop_path ? `background-image:url('${IMG}w1280${serie.backdrop_path}')` : ""}">
      <div class="detalle">
        ${temporada.poster_path || serie.poster_path
          ? `<img class="poster" src="${IMG}w500${temporada.poster_path || serie.poster_path}" alt="${escapar(temporada.name)}">`
          : `<div class="sin-poster">Sin póster</div>`}
        <div>
          <p class="miga"><a href="#/serie/${id}">${escapar(serie.name)}</a></p>
          <h1>${escapar(temporada.name)} <span class="suave">(${anio(temporada.air_date)})</span></h1>
          <div class="datos">
            <span>${temporada.episodes.length} episodios</span>
            ${usuario ? `<span>Viste ${cantidadVistos(visto, numero)} de ${temporada.episodes.length}</span>` : ""}
          </div>
          <div class="tags">
            ${temporadasDe(serie).map((t) => `
              <a class="tag ${t.season_number === numero ? "especial" : ""}" href="${rutaTemporada(id, t.season_number)}">
                ${t.season_number ? `T${t.season_number}` : "Especiales"}
              </a>`).join("")}
          </div>
          <p>${escapar(temporada.overview || serie.overview || "Sin sinopsis disponible.")}</p>
          ${usuario && emitidos.length ? `
            <div class="seguimiento">
              ${barraProgreso(cantidadVistos(visto, numero), temporada.episodes.length)}
              <button class="btn chico ${todosVistos ? "secundario" : ""}" id="btn-temporada-vista">
                ${todosVistos ? "Desmarcar temporada" : "✓ Marcar temporada como vista"}
              </button>
            </div>` : ""}
        </div>
      </div>
    </div>

    <section class="seccion" style="margin-top:32px">
      <h2>Episodios</h2>
      <div class="episodios">
        ${temporada.episodes.map((e) => {
          const clave = claveEpisodio(id, numero, e.episode_number);
          const local = ratings.promedio(clave);
          const cantComentarios = comentarios.dePelicula(clave).length;
          const fueVisto = visto.has(`${numero}x${e.episode_number}`);
          const ruta = rutaEpisodio(id, numero, e.episode_number);
          return `
            <div class="episodio ${fueVisto ? "visto" : ""}">
              <a href="${ruta}">
                ${e.still_path
                  ? `<img class="still" src="${IMG}w300${e.still_path}" alt="" loading="lazy">`
                  : `<div class="still sin-imagen">Sin imagen</div>`}
              </a>
              <div class="cuerpo">
                <a href="${ruta}"><h3>${codigoEpisodio(numero, e.episode_number)} · ${escapar(e.name)}</h3></a>
                <div class="meta">
                  ${e.air_date
                    ? `<span>${yaSalio(e.air_date) ? "" : "Se estrena el "}${formatearDia(e.air_date)}</span>`
                    : `<span>Sin fecha</span>`}
                  ${e.runtime ? `<span>⏱ ${e.runtime} min</span>` : ""}
                  ${e.vote_average ? `<span>★ ${e.vote_average.toFixed(1)}</span>` : ""}
                  ${local ? `<span>${local.valor.toFixed(1)}/5</span>` : ""}
                  ${cantComentarios ? `<span>💬 ${cantComentarios}</span>` : ""}
                </div>
                <p>${escapar(e.overview.slice(0, 260))}${e.overview.length > 260 ? "…" : ""}</p>
              </div>
              ${usuario && yaSalio(e.air_date) ? `
                <label class="check-visto">
                  <input type="checkbox" data-visto="${numero}x${e.episode_number}" ${fueVisto ? "checked" : ""}>
                  Visto
                </label>` : ""}
            </div>`;
        }).join("") || `<p class="suave">Esta temporada todavía no tiene episodios.</p>`}
      </div>
    </section>`;
}

function eventosTemporada(id) {
  id = Number(id);
  const usuario = auth.usuarioActual();
  if (!usuario) return;

  document.querySelectorAll("[data-visto]").forEach((c) => {
    c.onchange = () => {
      vistos.marcar(id, usuario, [c.dataset.visto], c.checked);
      recargar();
    };
  });

  const boton = document.getElementById("btn-temporada-vista");
  if (boton) boton.onclick = () => {
    vistos.marcar(id, usuario, temporadaActual.emitidos, !temporadaActual.todosVistos);
    recargar();
  };
}

// El episodio anterior y el siguiente, pasando de una temporada a otra
function episodiosVecinos(serie, temporada, episodio) {
  const cantidad = (t) => serie.seasons.find((s) => s.season_number === t)?.episode_count ?? 0;
  let anterior = null;
  let siguiente = null;
  if (episodio > 1) anterior = { temporada, episodio: episodio - 1 };
  else if (temporada > 1 && cantidad(temporada - 1)) anterior = { temporada: temporada - 1, episodio: cantidad(temporada - 1) };
  if (episodio < cantidad(temporada)) siguiente = { temporada, episodio: episodio + 1 };
  else if (temporada > 0 && cantidad(temporada + 1)) siguiente = { temporada: temporada + 1, episodio: 1 };
  return { anterior, siguiente };
}

async function vistaEpisodio(id, temporada, episodio) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  [id, temporada, episodio] = [id, temporada, episodio].map(Number);

  const [serie, ep] = await Promise.all([
    tmdb(`/tv/${id}`),
    tmdb(`/tv/${id}/season/${temporada}/episode/${episodio}`),
  ]);
  const usuario = auth.usuarioActual();
  const fueVisto = usuario && vistos.deSerie(id, usuario).has(`${temporada}x${episodio}`);
  const { anterior, siguiente } = episodiosVecinos(serie, temporada, episodio);
  const directores = ep.crew.filter((c) => c.job === "Director");
  const guionistas = ep.crew.filter((c) => ["Writer", "Screenplay", "Teleplay"].includes(c.job));
  const titulo = `${codigoEpisodio(temporada, episodio)} · ${ep.name}`;

  document.title = `${serie.name} ${titulo} · El "Santi"-Grial`;

  return `
    <div class="fondo-peli" style="${ep.still_path || serie.backdrop_path ? `background-image:url('${IMG}w1280${ep.still_path || serie.backdrop_path}')` : ""}">
      <div class="detalle">
        <a href="#/serie/${id}">
          ${serie.poster_path
            ? `<img class="poster" src="${IMG}w500${serie.poster_path}" alt="${escapar(serie.name)}">`
            : `<div class="sin-poster">${escapar(serie.name)}</div>`}
        </a>
        <div>
          <p class="miga">
            <a href="#/serie/${id}">${escapar(serie.name)}</a> ›
            <a href="${rutaTemporada(id, temporada)}">${temporada ? `Temporada ${temporada}` : "Especiales"}</a>
          </p>
          <h1>${escapar(titulo)}</h1>
          <div class="datos">
            ${ep.air_date ? `<span>📅 ${yaSalio(ep.air_date) ? "" : "Se estrena el "}${formatearDia(ep.air_date)}</span>` : ""}
            ${ep.runtime ? `<span>⏱ ${ep.runtime} min</span>` : ""}
            ${directores.length ? `<span>🎬 ${linksPersonas(directores)}</span>` : ""}
            ${guionistas.length ? `<span>✍ ${linksPersonas(guionistas)}</span>` : ""}
          </div>

          <p>${escapar(ep.overview || "Sin sinopsis disponible.")}</p>

          <div class="fila-form">
            ${anterior ? `<a class="btn secundario chico" href="${rutaEpisodio(id, anterior.temporada, anterior.episodio)}">← ${codigoEpisodio(anterior.temporada, anterior.episodio)}</a>` : ""}
            ${usuario && yaSalio(ep.air_date) ? `
              <button class="btn chico ${fueVisto ? "secundario" : ""}" id="btn-episodio-visto">
                ${fueVisto ? "✓ Visto · desmarcar" : "Marcar como visto"}
              </button>` : ""}
            ${siguiente ? `<a class="btn secundario chico" href="${rutaEpisodio(id, siguiente.temporada, siguiente.episodio)}">${codigoEpisodio(siguiente.temporada, siguiente.episodio)} →</a>` : ""}
          </div>

          ${bloquePuntajes(claveEpisodio(id, temporada, episodio), ep.vote_average, ep.vote_count)}
        </div>
      </div>
    </div>

    ${ep.guest_stars.length ? seccionReparto(ep.guest_stars, "Invitados") : ""}
    ${seccionResenas(claveEpisodio(id, temporada, episodio), titulo)}`;
}

function eventosEpisodio(id, temporada, episodio) {
  [id, temporada, episodio] = [id, temporada, episodio].map(Number);
  eventosOpiniones(claveEpisodio(id, temporada, episodio));

  const usuario = auth.usuarioActual();
  const boton = document.getElementById("btn-episodio-visto");
  if (!usuario || !boton) return;
  boton.onclick = () => {
    const ep = `${temporada}x${episodio}`;
    vistos.marcar(id, usuario, [ep], !vistos.deSerie(id, usuario).has(ep));
    recargar();
  };
}

// ---------- Personas ----------
const DEPARTAMENTOS = {
  Acting: "Actuación",
  Directing: "Dirección",
  Writing: "Guion",
  Production: "Producción",
  Sound: "Sonido",
  Camera: "Fotografía",
  Editing: "Edición",
  Art: "Arte",
  "Costume & Make-Up": "Vestuario y maquillaje",
  "Visual Effects": "Efectos visuales",
  Crew: "Equipo técnico",
  Lighting: "Iluminación",
};

// Programas de entrevistas (10767), noticias (10763) y reality (10764): se dejan fuera de la filmografía
const GENEROS_APARICIONES = [10767, 10763, 10764];

function esAparicion(credito) {
  return credito.media_type === "tv" && credito.genre_ids?.some((g) => GENEROS_APARICIONES.includes(g));
}

// Une los créditos de una misma obra (por ej. dos personajes en la misma película)
// campo: "character" para el reparto, "job" para el equipo
function unirCreditos(creditos, campo) {
  const obras = new Map();
  for (const c of creditos) {
    const clave = `${c.media_type}-${c.id}`;
    const obra = obras.get(clave) ?? { ...c, roles: [] };
    if (c[campo] && !obra.roles.includes(c[campo])) obra.roles.push(c[campo]);
    obra.episode_count = Math.max(obra.episode_count ?? 0, c.episode_count ?? 0);
    obras.set(clave, obra);
  }
  // Lo más nuevo primero; lo anunciado sin fecha, antes que todo
  return [...obras.values()].sort((a, b) => (fechaDe(b) || "9999").localeCompare(fechaDe(a) || "9999"));
}

function edad(desde, hasta = null) {
  const inicio = new Date(`${desde}T00:00`);
  const fin = hasta ? new Date(`${hasta}T00:00`) : new Date();
  let anios = fin.getFullYear() - inicio.getFullYear();
  if (fin < new Date(fin.getFullYear(), inicio.getMonth(), inicio.getDate())) anios--;
  return anios;
}

// Lista de créditos por año; muestra los primeros y el resto se despliega
function filmografia(creditos, detalle) {
  const VISIBLES = 15;
  const filas = creditos.map((c) => `
    <div class="fila-film">
      <span class="anio">${fechaDe(c) ? anio(fechaDe(c)) : "—"}</span>
      <a href="${rutaObra(c.media_type === "tv" ? "serie" : "pelicula", c.id)}">${escapar(tituloDe(c))}</a>
      <span class="suave">${detalle(c)}</span>
    </div>`);
  return `
    <div class="filmografia">${filas.slice(0, VISIBLES).join("")}</div>
    ${filas.length > VISIBLES ? `
      <details class="desplegable">
        <summary>Ver ${filas.length - VISIBLES} más</summary>
        <div class="filmografia">${filas.slice(VISIBLES).join("")}</div>
      </details>` : ""}`;
}

function listaPremios(premios) {
  return `
    <ul class="premios">
      ${premios.map((p) => `
        <li>
          <span class="anio">${p.anio ?? "—"}</span>
          <div>
            <strong>${escapar(p.premio)}</strong>
            ${p.obra ? `<span class="suave">por</span> <em>${escapar(p.obra)}</em>` : ""}
          </div>
        </li>`).join("")}
    </ul>`;
}

// Biografía de Wikipedia: la introducción a la vista y el resto desplegable
function seccionBiografia(persona, wiki) {
  // Si sólo hay artículo en inglés y TMDB tiene biografía en español, se usa la de TMDB
  const usarWiki = wiki?.biografia?.length && !(wiki.idioma === "en" && persona.biography);
  if (!usarWiki && !persona.biography) return "";

  if (!usarWiki) {
    return `
      <section class="seccion biografia">
        <h2>Biografía</h2>
        ${persona.biography.split(/\n+/).map((p) => `<p>${escapar(p)}</p>`).join("")}
        <p class="fuente">Fuente: TMDB</p>
      </section>`;
  }

  const bloques = wiki.biografia.flatMap((s) => [
    ...(s.titulo ? [s.nivel <= 2 ? `<h3>${escapar(s.titulo)}</h3>` : `<h4>${escapar(s.titulo)}</h4>`] : []),
    ...s.parrafos.map((p) => `<p>${escapar(p)}</p>`),
  ]);
  const VISIBLES = 3;
  return `
    <section class="seccion biografia">
      <h2>Biografía</h2>
      ${bloques.slice(0, VISIBLES).join("")}
      ${bloques.length > VISIBLES ? `
        <details class="desplegable">
          <summary>Leer la biografía completa</summary>
          ${bloques.slice(VISIBLES).join("")}
        </details>` : ""}
      <p class="fuente">
        Fuente: <a href="${wiki.url}" target="_blank" rel="noopener">Wikipedia${wiki.idioma === "en" ? " (en inglés)" : ""}</a>,
        bajo licencia <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.es" target="_blank" rel="noopener">CC BY-SA 4.0</a>.
      </p>
    </section>`;
}

async function vistaPersona(id) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  const persona = await tmdb(`/person/${id}`, { append_to_response: "combined_credits,external_ids" });
  const wikidataId = persona.external_ids?.wikidata_id;
  const wiki = wikidataId ? await datosWiki(wikidataId).catch(() => null) : null;

  const actuaciones = unirCreditos(persona.combined_credits.cast.filter((c) => !esAparicion(c)), "character");
  const equipo = unirCreditos(persona.combined_credits.crew, "job");
  const pelis = actuaciones.filter((c) => c.media_type === "movie");
  const series = actuaciones.filter((c) => c.media_type === "tv");
  const apariciones = persona.combined_credits.cast.filter(esAparicion).length;

  // "Conocido por": lo más votado de su departamento principal, sin cameos
  // (en el reparto, "order" es la posición en los créditos: 0 es el protagonista)
  const actua = persona.known_for_department === "Acting" || !equipo.length;
  const candidatas = actua
    ? actuaciones.filter((c) => c.media_type === "tv" ? c.episode_count >= 5 : (c.order ?? 0) <= 10)
    : unirCreditos(persona.combined_credits.crew.filter((c) => c.department === persona.known_for_department), "job");
  const conocidoPor = [...(candidatas.length ? candidatas : actua ? actuaciones : equipo)]
    .sort((a, b) => b.vote_count - a.vote_count).slice(0, 12);

  const premios = wiki?.premios ?? { ganados: [], nominaciones: [] };
  const nacimiento = persona.birthday;
  const muerte = persona.deathday;
  document.title = `${persona.name} · El "Santi"-Grial`;

  return `
    <div class="detalle persona">
      ${persona.profile_path
        ? `<img class="poster" src="${IMG}h632${persona.profile_path}" alt="${escapar(persona.name)}">`
        : `<div class="sin-poster">Sin foto</div>`}
      <div>
        <h1>${escapar(persona.name)}</h1>
        <div class="datos">
          ${persona.known_for_department ? `<span>${escapar(DEPARTAMENTOS[persona.known_for_department] ?? persona.known_for_department)}</span>` : ""}
          ${nacimiento ? `<span>🎂 ${formatearDia(nacimiento)}${muerte ? "" : ` (${edad(nacimiento)} años)`}</span>` : ""}
          ${muerte ? `<span>✝ ${formatearDia(muerte)}${nacimiento ? ` (${edad(nacimiento, muerte)} años)` : ""}</span>` : ""}
          ${persona.place_of_birth ? `<span>📍 ${escapar(persona.place_of_birth)}</span>` : ""}
        </div>
        <div class="puntajes">
          <div class="puntaje">
            <div class="valor">${pelis.length}</div>
            <div class="etiqueta">Películas</div>
          </div>
          <div class="puntaje">
            <div class="valor">${series.length}</div>
            <div class="etiqueta">Series</div>
          </div>
          <div class="puntaje">
            <div class="valor">${premios.ganados.length}</div>
            <div class="etiqueta">Premios</div>
          </div>
          <div class="puntaje">
            <div class="valor">${premios.nominaciones.length}</div>
            <div class="etiqueta">Nominaciones</div>
          </div>
        </div>
        <div class="tags">
          ${wiki?.url ? `<a class="tag" href="${wiki.url}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}
          ${persona.external_ids?.imdb_id ? `<a class="tag" href="https://www.imdb.com/name/${persona.external_ids.imdb_id}/" target="_blank" rel="noopener">IMDb ↗</a>` : ""}
          <a class="tag" href="https://www.themoviedb.org/person/${persona.id}" target="_blank" rel="noopener">TMDB ↗</a>
        </div>
      </div>
    </div>

    ${seccionBiografia(persona, wiki)}

    ${conocidoPor.length ? `
      <section class="seccion">
        <h2>Conocido por</h2>
        ${carrusel(conocidoPor, conocidoPor.length, "")}
      </section>` : ""}

    ${premios.ganados.length || premios.nominaciones.length ? `
      <section class="seccion">
        <h2>Premios</h2>
        ${premios.ganados.length ? listaPremios(premios.ganados) : `<p class="suave">No hay premios registrados.</p>`}
        ${premios.nominaciones.length ? `
          <details class="desplegable">
            <summary>Nominaciones (${premios.nominaciones.length})</summary>
            ${listaPremios(premios.nominaciones)}
          </details>` : ""}
        <p class="fuente">Fuente: <a href="https://www.wikidata.org/wiki/${wikidataId}" target="_blank" rel="noopener">Wikidata</a></p>
      </section>` : ""}

    ${pelis.length ? `
      <section class="seccion">
        <h2>Películas <span class="suave" style="font-size:1rem">${pelis.length}</span></h2>
        ${filmografia(pelis, (c) => c.roles.length ? `como ${escapar(c.roles.join(" / "))}` : "")}
      </section>` : ""}

    ${series.length ? `
      <section class="seccion">
        <h2>Series <span class="suave" style="font-size:1rem">${series.length}</span></h2>
        ${filmografia(series, (c) => [
          c.roles.length ? `como ${escapar(c.roles.join(" / "))}` : "",
          c.episode_count ? `${c.episode_count} ${c.episode_count === 1 ? "episodio" : "episodios"}` : "",
        ].filter(Boolean).join(" · "))}
        ${apariciones ? `<p class="suave nota">Sin contar ${apariciones} apariciones en programas de entrevistas, noticias o reality.</p>` : ""}
      </section>` : ""}

    ${equipo.length ? `
      <section class="seccion">
        <h2>Detrás de cámara <span class="suave" style="font-size:1rem">${equipo.length}</span></h2>
        ${filmografia(equipo, (c) => escapar(c.roles.join(", ")))}
      </section>` : ""}`;
}

// ---------- Música (MusicBrainz) ----------
// Ranking de discos según los puntajes del sitio. Con pocos votos, el promedio se acerca
// a la media general (así un disco con un solo 5 no le gana a uno con veinte 4,5).
function rankingDiscos(decada = "") {
  const meta = discos.todos();
  const filas = Object.entries(store.leer("ratings", {}))
    .filter(([clave]) => clave.startsWith("album-"))
    .map(([clave, porUsuario]) => {
      const valores = Object.values(porUsuario);
      const mbid = clave.slice("album-".length);
      if (!valores.length || !meta[mbid]) return null;
      return { mbid, disco: meta[mbid], votos: valores.length, promedio: valores.reduce((a, b) => a + b, 0) / valores.length };
    })
    .filter(Boolean);
  const media = filas.length ? filas.reduce((suma, f) => suma + f.promedio, 0) / filas.length : 3;
  return filas
    .filter((f) => !decada || f.disco.anio?.slice(0, 3) === decada.slice(0, 3))
    .map((f) => ({ ...f, puntaje: (f.promedio * f.votos + media * 2) / (f.votos + 2) }))
    .sort((a, b) => b.puntaje - a.puntaje || b.votos - a.votos);
}

function tablaRanking(filas) {
  return `
    <ol class="ranking">
      ${filas.map((f, i) => `
        <li>
          <span class="puesto">${i + 1}</span>
          <a class="mini-tapa" href="#/album/${f.mbid}">${tapa(f.mbid, f.disco.titulo)}</a>
          <div class="crece">
            <a class="titulo-disco" href="#/album/${f.mbid}">${escapar(f.disco.titulo)}</a>
            <div class="suave">
              ${f.disco.artistas.map((a) => `<a class="link-persona" href="#/artista/${a.id}">${escapar(a.nombre)}</a>${escapar(a.union)}`).join("")}
              · ${f.disco.anio ?? "s/f"} · ${escapar(f.disco.tipo)}
            </div>
          </div>
          <div class="nota-ranking">
            <strong>${f.promedio.toFixed(2)}</strong>
            <span>${f.votos} ${f.votos === 1 ? "voto" : "votos"}</span>
          </div>
        </li>`).join("")}
    </ol>`;
}

function formBusquedaMusica(q = "") {
  return `
    <form id="form-buscar-musica" class="fila-form">
      <input type="search" name="q" placeholder="Buscar artistas o discos…" value="${escapar(q)}" required autocomplete="off">
      <button class="btn">Buscar</button>
    </form>`;
}

function eventosBusquedaMusica() {
  const form = document.getElementById("form-buscar-musica");
  if (!form) return;
  form.onsubmit = (e) => {
    e.preventDefault();
    const q = form.elements.q.value.trim();
    if (q) location.hash = `#/musica/buscar/${encodeURIComponent(q)}`;
  };
}

async function vistaMusica() {
  const ranking = rankingDiscos().slice(0, 10);
  const ultimas = resenas.todas().filter((r) => r.clave.startsWith("album-")).slice(0, 6);
  const obras = await obrasDeClaves(ultimas.map((r) => r.clave));
  document.title = `Música · El "Santi"-Grial`;

  return `
    <section class="seccion panel">
      <h1 style="margin-top:0">🎵 Música</h1>
      <p class="suave">Buscá artistas y discos en MusicBrainz, puntualos y escribí reseñas.</p>
      ${formBusquedaMusica()}
    </section>

    <section class="seccion">
      <h2>Charts del sitio ${ranking.length ? `<a href="#/musica/charts">Ver todos →</a>` : ""}</h2>
      ${ranking.length
        ? tablaRanking(ranking)
        : `<p class="suave">Todavía nadie puntuó discos. Buscá uno y sé el primero.</p>`}
    </section>

    <section class="seccion">
      <h2>Reseñas recientes de discos</h2>
      <div class="resenas">
        ${ultimas.map((r) => tarjetaResena(r, { obra: obras[r.clave] })).join("")
          || `<p class="suave">Todavía no hay reseñas de discos.</p>`}
      </div>
    </section>`;
}

function eventosMusica() {
  eventosBusquedaMusica();
  eventosLikes();
}

const TIPOS_ARTISTA = {
  Person: "Solista",
  Group: "Grupo",
  Orchestra: "Orquesta",
  Choir: "Coro",
  Character: "Personaje",
  Other: "Otro",
};

function anios(lapso) {
  if (!lapso?.begin) return "";
  const desde = lapso.begin.slice(0, 4);
  if (lapso.end) return `${desde}–${lapso.end.slice(0, 4)}`;
  return lapso.ended ? desde : `${desde}–presente`;
}

async function vistaBusquedaMusica(q) {
  q = decodeURIComponent(q);
  const [{ artists }, gruposEncontrados] = await Promise.all([
    musicbrainz("/artist", { query: q, limit: 8 }),
    musicbrainz("/release-group", { query: q, limit: 24 }),
  ]);
  const albumes = gruposEncontrados["release-groups"];
  document.title = `Buscar "${q}" en música · El "Santi"-Grial`;

  return `
    <section class="seccion">
      ${formBusquedaMusica(q)}
    </section>
    <section class="seccion">
      <h2>Resultados para "${escapar(q)}"</h2>
      ${artists.length ? `
        <h3 class="titulo-genero">Artistas <span class="suave">(${artists.length})</span></h3>
        <div class="lista-admin">
          ${artists.map((a) => `
            <a class="fila-admin" href="#/artista/${a.id}">
              <strong class="crece">${escapar(a.name)}
                ${a.disambiguation ? `<span class="suave" style="font-weight:400">(${escapar(a.disambiguation)})</span>` : ""}
              </strong>
              <span class="suave">${[TIPOS_ARTISTA[a.type] ?? a.type, a.area?.name ?? a.country, anios(a["life-span"])]
                .filter(Boolean).map(escapar).join(" · ")}</span>
            </a>`).join("")}
        </div>` : ""}
      ${albumes.length ? `
        <h3 class="titulo-genero">Discos <span class="suave">(${albumes.length})</span></h3>
        <div class="grilla">
          ${albumes.map((rg) => tarjetaDisco(rg.id, {
            titulo: rg.title,
            artistas: (rg["artist-credit"] ?? []).map((c) => c.name + (c.joinphrase ?? "")).join(""),
            anio: rg["first-release-date"]?.slice(0, 4),
            tipo: tipoDisco(rg),
          })).join("")}
        </div>` : ""}
      ${artists.length || albumes.length ? "" : `<p class="suave">No se encontraron artistas ni discos.</p>`}
    </section>`;
}

// Secciones de la discografía; cada disco va en la primera que le corresponde
const SECCIONES_DISCOGRAFIA = [
  ["Álbumes", (rg, sec) => rg["primary-type"] === "Album" && !sec.length],
  ["EPs", (rg, sec) => rg["primary-type"] === "EP" && !sec.length],
  ["En vivo", (rg, sec) => sec.includes("Live")],
  ["Compilados", (rg, sec) => sec.includes("Compilation")],
  ["Otros", () => true],
];

async function vistaArtista(mbid) {
  const artista = await musicbrainz(`/artist/${mbid}`, { inc: "genres+tags+url-rels" });
  const wikidataId = artista.relations?.find((r) => r.type === "wikidata")?.url.resource.split("/").pop();
  const [discografia, wiki] = await Promise.all([
    musicbrainz("/release-group", { artist: mbid, type: "album|ep", limit: 100 }),
    wikidataId ? datosWiki(wikidataId).catch(() => null) : null,
  ]);

  const grupos = [...discografia["release-groups"]]
    .sort((a, b) => (a["first-release-date"] || "9999").localeCompare(b["first-release-date"] || "9999"));
  const secciones = SECCIONES_DISCOGRAFIA.map(([titulo]) => ({ titulo, discos: [] }));
  for (const rg of grupos) {
    const sec = rg["secondary-types"] ?? [];
    secciones[SECCIONES_DISCOGRAFIA.findIndex(([, corresponde]) => corresponde(rg, sec))].discos.push(rg);
  }

  // Promedio del sitio con todos los puntajes de sus discos
  const puntajes = grupos.flatMap((rg) => Object.values(ratings.dePelicula(claveDisco(rg.id))));
  const promedio = puntajes.length ? puntajes.reduce((a, b) => a + b, 0) / puntajes.length : null;
  const generos = (artista.genres?.length ? artista.genres : artista.tags ?? [])
    .sort((a, b) => b.count - a.count).slice(0, 8);
  const premios = wiki?.premios?.ganados ?? [];
  document.title = `${artista.name} · El "Santi"-Grial`;

  return `
    <div class="detalle persona">
      ${wiki?.imagen
        ? `<img class="poster" src="${wiki.imagen}" alt="${escapar(artista.name)}">`
        : `<div class="sin-poster">${escapar(artista.name)}</div>`}
      <div>
        <h1>${escapar(artista.name)}</h1>
        ${artista.disambiguation ? `<p class="eslogan">${escapar(artista.disambiguation)}</p>` : ""}
        <div class="datos">
          ${artista.type ? `<span>${escapar(TIPOS_ARTISTA[artista.type] ?? artista.type)}</span>` : ""}
          ${artista.area ? `<span>📍 ${escapar(artista.area.name)}</span>` : ""}
          ${anios(artista["life-span"]) ? `<span>📅 ${anios(artista["life-span"])}</span>` : ""}
        </div>
        <div class="tags">${generos.map((g) => `<span class="tag genero">${escapar(g.name)}</span>`).join("")}</div>
        <div class="puntajes">
          <div class="puntaje"><div class="valor">${grupos.length}</div><div class="etiqueta">Discos y EPs</div></div>
          <div class="puntaje">
            <div class="valor">${promedio ? promedio.toFixed(1) : "–"}<small>/5</small></div>
            <div class="etiqueta">El "Santi"-Grial · ${puntajes.length} votos</div>
          </div>
          ${premios.length ? `<div class="puntaje"><div class="valor">${premios.length}</div><div class="etiqueta">Premios</div></div>` : ""}
        </div>
        <div class="tags">
          ${wiki?.url ? `<a class="tag" href="${wiki.url}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}
          <a class="tag" href="https://musicbrainz.org/artist/${mbid}" target="_blank" rel="noopener">MusicBrainz ↗</a>
        </div>
      </div>
    </div>

    ${seccionBiografia({ biography: "" }, wiki)}

    <section class="seccion">
      <h2>Discografía</h2>
      ${secciones.filter((s) => s.discos.length).map((s) => `
        <h3 class="titulo-genero">${s.titulo} <span class="suave">(${s.discos.length})</span></h3>
        <div class="grilla">
          ${s.discos.map((rg) => tarjetaDisco(rg.id, {
            titulo: rg.title,
            anio: rg["first-release-date"]?.slice(0, 4),
            tipo: s.titulo === "Otros" ? tipoDisco(rg) : "",
          })).join("")}
        </div>`).join("") || `<p class="suave">MusicBrainz no tiene discos de este artista.</p>`}
      ${discografia["release-group-count"] > grupos.length
        ? `<p class="suave nota">Se muestran ${grupos.length} de ${discografia["release-group-count"]}.
             <a href="https://musicbrainz.org/artist/${mbid}" target="_blank" rel="noopener" style="color:var(--acento)">Ver todo en MusicBrainz ↗</a></p>`
        : ""}
    </section>

    ${premios.length ? `
      <section class="seccion">
        <h2>Premios</h2>
        ${listaPremios(premios)}
        <p class="fuente">Fuente: <a href="https://www.wikidata.org/wiki/${wikidataId}" target="_blank" rel="noopener">Wikidata</a></p>
      </section>` : ""}`;
}

async function vistaAlbum(mbid) {
  const rg = await musicbrainz(`/release-group/${mbid}`, { inc: "artist-credits+releases+genres+tags+ratings" });
  discos.recordar(rg);
  // Los temas salen de la primera edición oficial
  const edicion = rg.releases
    .filter((r) => r.status === "Official")
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))[0] ?? rg.releases[0];
  const release = edicion ? await musicbrainz(`/release/${edicion.id}`, { inc: "recordings" }).catch(() => null) : null;

  const medios = release?.media ?? [];
  const temas = medios.flatMap((m) => m.tracks ?? []);
  const total = temas.reduce((suma, t) => suma + (t.length ?? 0), 0);
  const generos = (rg.genres?.length ? rg.genres : rg.tags ?? []).sort((a, b) => b.count - a.count).slice(0, 6);
  const fecha = rg["first-release-date"];
  document.title = `${rg.title} · El "Santi"-Grial`;

  return `
    <div class="detalle disco">
      ${tapa(mbid, rg.title, 500)}
      <div>
        <h1>${escapar(rg.title)}</h1>
        <p class="artistas-disco">${creditoArtistas(rg["artist-credit"])}</p>
        <div class="datos">
          <span>${escapar(tipoDisco(rg))}</span>
          ${fecha ? `<span>📅 ${fecha.length === 10 ? formatearDia(fecha) : fecha.slice(0, 4)}</span>` : ""}
          ${temas.length ? `<span>${temas.length} temas</span>` : ""}
          ${total ? `<span>⏱ ${Math.round(total / 60000)} min</span>` : ""}
          ${rg.releases.length > 1 ? `<span>${rg.releases.length} ediciones</span>` : ""}
        </div>
        <div class="tags">${generos.map((g) => `<span class="tag genero">${escapar(g.name)}</span>`).join("")}</div>
        ${bloquePuntajes(claveDisco(mbid), rg.rating?.value, rg.rating?.["votes-count"], { nombre: "MusicBrainz", maximo: 5 })}
        <div class="tags">
          <a class="tag" href="https://musicbrainz.org/release-group/${mbid}" target="_blank" rel="noopener">MusicBrainz ↗</a>
        </div>
      </div>
    </div>

    <section class="seccion" style="margin-top:32px">
      <h2>Lista de temas</h2>
      ${medios.length ? medios.map((m) => `
        ${medios.length > 1 ? `<h3 class="titulo-genero">${escapar(m.format ?? "Disco")} ${m.position}${m.title ? ` · ${escapar(m.title)}` : ""}</h3>` : ""}
        <ol class="temas">
          ${(m.tracks ?? []).map((t) => `
            <li>
              <span class="numero">${escapar(t.number)}</span>
              <span class="crece">${escapar(t.title)}</span>
              <span class="suave">${duracion(t.length)}</span>
            </li>`).join("")}
        </ol>`).join("") : `<p class="suave">MusicBrainz no tiene la lista de temas de este disco.</p>`}
      ${edicion ? `<p class="fuente">Edición: ${escapar(edicion.date ?? "s/f")}${edicion.country ? ` · ${escapar(edicion.country)}` : ""}</p>` : ""}
    </section>

    ${seccionResenas(claveDisco(mbid), rg.title)}`;
}

function eventosAlbum(mbid) {
  eventosOpiniones(claveDisco(mbid));
}

async function vistaCharts(decada = "") {
  const ranking = rankingDiscos(decada);
  const decadas = [...new Set(Object.values(discos.todos()).map((d) => d.anio?.slice(0, 3)).filter(Boolean))]
    .sort().reverse().map((d) => `${d}0`);
  document.title = `Charts · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>Charts del sitio ${decada ? `<span class="suave" style="font-size:1rem">años ${decada.slice(2)}</span>` : ""}</h2>
      <div class="controles">
        <label>Década
          <select id="decada-charts">
            <option value="">Todas</option>
            ${decadas.map((d) => `<option value="${d}" ${d === decada ? "selected" : ""}>${d}s</option>`).join("")}
          </select>
        </label>
      </div>
      <p class="suave nota">Ordenados por promedio ponderado: con pocos votos, el puntaje se acerca a la media del sitio.</p>
      ${ranking.length ? tablaRanking(ranking.slice(0, 100)) : `<p class="suave">No hay discos puntuados${decada ? " de esa década" : ""}.</p>`}
    </section>`;
}

function eventosCharts() {
  const decada = document.getElementById("decada-charts");
  if (decada) decada.onchange = () => {
    location.hash = decada.value ? `#/musica/charts/${decada.value}` : "#/musica/charts";
  };
}

// ---------- Panel de administración ----------
let ultimaBusquedaAdmin = "";

// Lista del catálogo en el panel: se filtra y se muestra de a CANTIDAD_CATALOGO_ADMIN
// (el filtro y la cantidad se mantienen al recargar el panel)
const CANTIDAD_CATALOGO_ADMIN = 10;
let catalogoAdmin = [];
let filtroCatalogoAdmin = { texto: "", tipo: "" };
let limiteCatalogoAdmin = CANTIDAD_CATALOGO_ADMIN;

function sinAcentos(texto) {
  return String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function dibujarCatalogoAdmin() {
  const texto = sinAcentos(filtroCatalogoAdmin.texto.trim()).replace(/^#/, "");
  const filtradas = catalogoAdmin.filter((o) =>
    (!filtroCatalogoAdmin.tipo || o.tipo === filtroCatalogoAdmin.tipo) &&
    (!texto || sinAcentos(o.titulo).includes(texto) || o.tags.some((t) => t.includes(texto)) || String(o.id) === texto));
  const visibles = filtradas.slice(0, limiteCatalogoAdmin);

  if (!filtradas.length) {
    return `<p class="suave">${catalogoAdmin.length ? "No hay nada que coincida con la búsqueda." : "El catálogo está vacío."}</p>`;
  }
  return `
    <div class="lista-admin">
      ${visibles.map((o) => `
        <div class="fila-admin">
          <a class="crece" href="${rutaObra(o.tipo, o.id)}">
            ${escapar(o.titulo || `${o.tipo === "serie" ? "Serie" : "Película"} ${o.id}`)}
            ${o.tipo === "serie" ? `<span class="insignia">serie</span>` : ""}
          </a>
          <div class="tags">
            ${o.tags.map((t) => `
              <span class="tag especial">#${escapar(t)}
                <button class="quitar-tag" data-clave="${o.clave}" data-quitar-tag="${escapar(t)}" title="Quitar tag">✕</button>
              </span>`).join("")}
          </div>
          <form class="form-tag-fila" data-clave="${o.clave}">
            <input type="text" name="tag" list="lista-tags" placeholder="+ tag" required>
          </form>
          <button class="btn-link" data-quitar-obra="${o.clave}">Quitar</button>
        </div>`).join("")}
    </div>
    <div class="fila-form">
      <span class="suave crece">Mostrando ${visibles.length} de ${filtradas.length}</span>
      ${filtradas.length > visibles.length
        ? `<button class="btn secundario chico" id="ver-mas-catalogo">Mostrar ${Math.min(CANTIDAD_CATALOGO_ADMIN, filtradas.length - visibles.length)} más</button>`
        : ""}
    </div>`;
}

// Se llama cada vez que se redibuja la lista del catálogo
function eventosCatalogoAdmin() {
  const lista = document.getElementById("lista-catalogo-admin");

  lista.querySelectorAll(".form-tag-fila").forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const tag = normalizarTag(f.elements.tag.value);
      if (!tag) return;
      await catalogo.agregarTag(f.dataset.clave, "", tag);
      renderMenu();
      recargar();
    };
  });

  lista.querySelectorAll(".quitar-tag[data-clave]").forEach((b) => {
    b.onclick = async () => {
      await catalogo.quitarTag(b.dataset.clave, b.dataset.quitarTag);
      recargar();
    };
  });

  lista.querySelectorAll("[data-quitar-obra]").forEach((b) => {
    b.onclick = () => {
      if (!confirm("¿Quitar esto del catálogo?")) return;
      catalogo.quitar(b.dataset.quitarObra);
      recargar();
    };
  });

  const verMas = document.getElementById("ver-mas-catalogo");
  if (verMas) verMas.onclick = () => {
    limiteCatalogoAdmin += CANTIDAD_CATALOGO_ADMIN;
    redibujarCatalogoAdmin();
  };
}

function redibujarCatalogoAdmin() {
  document.getElementById("lista-catalogo-admin").innerHTML = dibujarCatalogoAdmin();
  eventosCatalogoAdmin();
}

async function vistaAdmin() {
  if (!auth.esAdmin()) {
    return `
      <div class="aviso error">
        Esta página es sólo para administradores.
        ${auth.usuarioActual() ? "" : `<a href="#/login" style="color:var(--acento)">Ingresá</a> con una cuenta de administrador.`}
      </div>`;
  }

  catalogoAdmin = (await catalogo.todas()).sort((a, b) => (a.titulo ?? "").localeCompare(b.titulo ?? ""));
  const tags = etiquetas.todas();
  const cantidad = (tag) => catalogoAdmin.filter((o) => o.tags.includes(tag)).length;
  document.title = `Admin · El "Santi"-Grial`;

  return `
    <h1>⚙ Panel de administración</h1>
    ${datalistTags()}

    <section class="seccion panel">
      <h2>Agregar película o serie</h2>
      <form id="form-buscar-admin" class="fila-form">
        <input type="text" name="q" placeholder="Buscar películas y series en TMDB…" required value="${escapar(ultimaBusquedaAdmin)}">
        <button class="btn">Buscar</button>
      </form>
      <div id="resultados-admin"></div>
    </section>

    <section class="seccion panel">
      <h2>Tags</h2>
      <div class="lista-admin">
        ${Object.entries(tags).map(([t, info]) => `
          <div class="fila-admin">
            <a class="tag especial" href="#/tag/${encodeURIComponent(t)}">#${escapar(t)}</a>
            <span class="suave crece">${escapar(info.descripcion || "Sin descripción")} · ${cantidad(t)} en el catálogo</span>
            <button class="btn-link" data-borrar-tag="${escapar(t)}">Borrar</button>
          </div>`).join("") || `<p class="suave">No hay tags.</p>`}
      </div>
      <form id="form-nuevo-tag" class="fila-form">
        <input type="text" name="nombre" placeholder="Nombre del tag" required>
        <input type="text" name="descripcion" placeholder="Descripción (opcional)">
        <button class="btn">Crear tag</button>
      </form>
    </section>

    <section class="seccion panel">
      <h2>Catálogo <span class="suave" style="font-size:1rem">${cantidadObras(catalogoAdmin)}</span></h2>
      <div class="fila-form">
        <input type="search" id="buscar-catalogo-admin" placeholder="Buscar en el catálogo por título o #tag…"
          value="${escapar(filtroCatalogoAdmin.texto)}" autocomplete="off">
        <select id="tipo-catalogo-admin">
          ${Object.entries(TIPOS_LISTADO).map(([valor, texto]) =>
            `<option value="${valor}" ${filtroCatalogoAdmin.tipo === valor ? "selected" : ""}>${texto}</option>`).join("")}
        </select>
      </div>
      <div id="lista-catalogo-admin">${dibujarCatalogoAdmin()}</div>
    </section>

    <section class="seccion panel">
      <h2>Guardar en los archivos</h2>
      <p class="suave">
        Los cambios del panel se guardan en el servidor (<code>datos/guardados.json</code>) y los ven todos.
        Si querés pasarlos a los archivos de <code>datos/</code>, descargalos y reemplazá los de esa carpeta. Después podés descartar los cambios.
      </p>
      <div class="fila-form">
        <button class="btn" id="exportar-peliculas">Descargar peliculas.js</button>
        <button class="btn" id="exportar-tags">Descargar tags.js</button>
        <button class="btn secundario" id="descartar-cambios">Descartar cambios</button>
      </div>
    </section>`;
}

async function buscarParaAdmin(q) {
  ultimaBusquedaAdmin = q;
  const contenedor = document.getElementById("resultados-admin");
  contenedor.innerHTML = `<p class="suave">Buscando…</p>`;

  const [{ results }, enCatalogo] = await Promise.all([tmdb("/search/multi", { query: q }), catalogo.todas()]);
  const claves = new Set(enCatalogo.map((o) => o.clave));
  const obras = results.filter((r) => ["movie", "tv"].includes(r.media_type)).map((r) => {
    const tipo = r.media_type === "tv" ? "serie" : "pelicula";
    return { ...r, tipo, clave: claveCatalogo(tipo, r.id) };
  });

  contenedor.innerHTML = `<div class="lista-admin">
    ${obras.slice(0, 10).map((o) => `
      <div class="fila-admin">
        ${o.poster_path
          ? `<img class="mini" src="${IMG}w92${o.poster_path}" alt="">`
          : `<div class="mini sin-poster"></div>`}
        <a class="crece" href="${rutaObra(o.tipo, o.id)}">
          ${escapar(tituloDe(o))} <span class="suave">(${anio(fechaDe(o))})</span>
          ${o.tipo === "serie" ? `<span class="insignia">serie</span>` : ""}
        </a>
        ${claves.has(o.clave)
          ? `<span class="suave">Ya está en el catálogo</span>`
          : `<form class="form-agregar fila-form" data-clave="${o.clave}" data-titulo="${escapar(tituloDe(o))}">
               <input type="text" name="tags" placeholder="tags separados por coma">
               <button class="btn chico">Agregar</button>
             </form>`}
      </div>`).join("") || `<p class="suave">Sin resultados.</p>`}
  </div>`;

  contenedor.querySelectorAll(".form-agregar").forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const tags = f.elements.tags.value.split(",").map(normalizarTag).filter(Boolean);
      catalogo.agregar(f.dataset.clave, f.dataset.titulo, tags);
      renderMenu();
      recargar();
    };
  });
}

function eventosAdmin() {
  const buscar = document.getElementById("form-buscar-admin");
  if (!buscar) return;

  buscar.onsubmit = (e) => {
    e.preventDefault();
    const q = buscar.elements.q.value.trim();
    if (q) buscarParaAdmin(q).catch((err) => {
      document.getElementById("resultados-admin").innerHTML = avisoError(err);
    });
  };
  // Al recargar el panel se mantiene la última búsqueda
  if (ultimaBusquedaAdmin) buscarParaAdmin(ultimaBusquedaAdmin).catch(() => {});

  document.getElementById("form-nuevo-tag").onsubmit = (e) => {
    e.preventDefault();
    const nombre = normalizarTag(e.target.elements.nombre.value);
    if (!nombre) return;
    etiquetas.crear(nombre, e.target.elements.descripcion.value.trim());
    renderMenu();
    recargar();
  };

  document.querySelectorAll("[data-borrar-tag]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`¿Borrar #${b.dataset.borrarTag}? Se quita de todas las películas y series.`)) return;
      await etiquetas.borrar(b.dataset.borrarTag);
      renderMenu();
      recargar();
    };
  });

  const buscarCatalogo = document.getElementById("buscar-catalogo-admin");
  const tipoCatalogo = document.getElementById("tipo-catalogo-admin");
  const filtrarCatalogo = () => {
    filtroCatalogoAdmin = { texto: buscarCatalogo.value, tipo: tipoCatalogo.value };
    limiteCatalogoAdmin = CANTIDAD_CATALOGO_ADMIN;
    redibujarCatalogoAdmin();
  };
  buscarCatalogo.oninput = filtrarCatalogo;
  tipoCatalogo.onchange = filtrarCatalogo;
  eventosCatalogoAdmin();

  document.getElementById("exportar-peliculas").onclick = exportarPeliculas;
  document.getElementById("exportar-tags").onclick = exportarTags;
  document.getElementById("descartar-cambios").onclick = () => {
    if (!confirm("¿Descartar los cambios guardados en el servidor? Quedará lo que dicen los archivos de datos/.")) return;
    store.borrar("catalogo");
    store.borrar("tags_admin");
    renderMenu();
    recargar();
  };
}

async function vistaBusqueda(q) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  q = decodeURIComponent(q);
  // /search/multi trae películas, series y personas
  const { results } = await tmdb("/search/multi", { query: q });
  const pelis = results.filter((r) => r.media_type === "movie");
  const series = results.filter((r) => r.media_type === "tv");
  const personas = results.filter((r) => r.media_type === "person");
  document.title = `Buscar "${q}" · El "Santi"-Grial`;

  const grupo = (titulo, lista, dibujar = (o) => tarjeta(o)) => lista.length ? `
    <h3 class="titulo-genero">${titulo} <span class="suave">(${lista.length})</span></h3>
    <div class="grilla">${lista.map(dibujar).join("")}</div>` : "";

  return `
    <section class="seccion">
      <h2>Resultados para "${escapar(q)}"</h2>
      ${results.length
        ? grupo("Personas", personas, tarjetaPersona) + grupo("Películas", pelis) + grupo("Series", series)
        : `<p class="suave">No se encontraron películas, series ni personas.</p>`}
      <p class="aviso">¿Buscabas música?
        <a href="#/musica/buscar/${encodeURIComponent(q)}" style="color:var(--acento)">Buscar "${escapar(q)}" en Música →</a></p>
    </section>`;
}

function vistaLogin() {
  if (auth.usuarioActual()) {
    location.hash = "#/";
    return "";
  }
  return `
    <div class="caja-login">
      <h1>Bienvenido</h1>
      <div class="pestanas">
        <button class="btn" data-modo="ingresar">Ingresar</button>
        <button class="btn secundario" data-modo="registrar">Crear cuenta</button>
      </div>
      <form id="form-login" data-modo="ingresar">
        <div>
          <label for="usuario">Usuario</label>
          <input type="text" id="usuario" name="usuario" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_.\\-]+" autocomplete="username">
        </div>
        <div>
          <label for="clave">Contraseña</label>
          <input type="password" id="clave" name="clave" required minlength="4" autocomplete="current-password">
        </div>
        <p class="mensaje-error" id="error-login"></p>
        <button class="btn" id="btn-enviar">Ingresar</button>
      </form>
      <p class="suave" style="font-size:.8rem;margin-bottom:0">
        Las cuentas se guardan en el servidor.
      </p>
    </div>`;
}

function eventosLogin() {
  const form = document.getElementById("form-login");
  if (!form) return;
  const error = document.getElementById("error-login");
  const enviar = document.getElementById("btn-enviar");

  document.querySelectorAll("[data-modo]").forEach((b) => {
    if (b.tagName !== "BUTTON") return;
    b.onclick = () => {
      form.dataset.modo = b.dataset.modo;
      document.querySelectorAll(".pestanas button").forEach((x) =>
        x.classList.toggle("secundario", x !== b));
      enviar.textContent = b.dataset.modo === "ingresar" ? "Ingresar" : "Crear cuenta";
      error.textContent = "";
    };
  });

  form.onsubmit = (e) => {
    e.preventDefault();
    const usuario = form.usuario.value.trim();
    const clave = form.clave.value;
    try {
      if (form.dataset.modo === "registrar") auth.registrar(usuario, clave);
      else auth.ingresar(usuario, clave);
      renderZonaUsuario();
      // Volver a la página desde donde vino, si la hay
      location.hash = sessionStorage.getItem("volverA") || "#/";
      sessionStorage.removeItem("volverA");
    } catch (err) {
      error.textContent = err.message;
    }
  };
}

// Título, link, imagen y tarjeta de una película, serie, episodio o disco a partir de su clave de ratings/reseñas
async function obraDeClave(clave) {
  const poster = (ruta) => (ruta ? `${IMG}w92${ruta}` : null);

  const album = clave.match(/^album-([0-9a-f-]{36})$/);
  if (album) {
    const mbid = album[1];
    let disco = discos.de(mbid);
    if (!disco) {
      const rg = await musicbrainz(`/release-group/${mbid}`, { inc: "artist-credits" });
      discos.recordar(rg);
      disco = discos.de(mbid);
    }
    return {
      titulo: `${disco.titulo} · ${nombreArtistas(disco)}`,
      href: `#/album/${mbid}`,
      imagen: tapaDe(mbid),
      tarjeta: tarjetaDisco(mbid, { ...disco, artistas: nombreArtistas(disco) }),
    };
  }

  const episodio = clave.match(/^serie-(d+)-(d+)x(d+)$/);
  if (episodio) {
    const [, id, t, e] = episodio.map(Number);
    const [serie, ep] = await Promise.all([tmdb(`/tv/${id}`), tmdb(`/tv/${id}/season/${t}/episode/${e}`)]);
    const titulo = `${serie.name} · ${codigoEpisodio(t, e)} ${ep.name}`;
    const href = rutaEpisodio(id, t, e);
    return {
      titulo, href, imagen: poster(serie.poster_path),
      tarjeta: tarjeta({ ...serie, name: titulo, vote_average: ep.vote_average }, href),
    };
  }

  const serie = clave.match(/^serie-(d+)$/);
  if (serie) {
    const datos = await tmdb(`/tv/${serie[1]}`);
    return { titulo: datos.name, href: `#/serie/${datos.id}`, imagen: poster(datos.poster_path), tarjeta: tarjeta(datos) };
  }

  const peli = await tmdb(`/movie/${clave}`);
  return { titulo: peli.title, href: `#/pelicula/${peli.id}`, imagen: poster(peli.poster_path), tarjeta: tarjeta(peli) };
}

// { [clave]: obra } para varias claves a la vez (las que fallan quedan con datos genéricos)
async function obrasDeClaves(claves) {
  const unicas = [...new Set(claves)];
  return Object.fromEntries(await Promise.all(unicas.map(async (clave) => [
    clave,
    await obraDeClave(clave).catch(() => ({ titulo: "Sin datos", href: "#/", imagen: null, tarjeta: "" })),
  ])));
}

// #/perfil lleva al perfil propio
function vistaPerfil() {
  const usuario = auth.usuarioActual();
  location.hash = usuario ? `#/usuario/${encodeURIComponent(usuario)}` : "#/login";
  return "";
}

async function vistaUsuario(nombre) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  const registro = buscarUsuario(decodeURIComponent(nombre));
  if (!registro) return `<div class="aviso error">No existe el usuario "${escapar(decodeURIComponent(nombre))}".</div>`;
  nombre = registro.usuario;

  const usuario = auth.usuarioActual();
  const propio = usuario === nombre;
  const susResenas = resenas.deUsuario(nombre);
  const conResena = new Set(susResenas.map((r) => r.clave));
  const susPuntajes = Object.entries(store.leer("ratings", {}))
    .filter(([, r]) => r[nombre])
    .map(([clave, r]) => ({ clave, valor: r[nombre] }));
  // Las puntuaciones que ya tienen reseña se ven en la reseña
  const soloPuntajes = susPuntajes.filter((p) => !conResena.has(p.clave));
  const susComentarios = Object.entries(store.leer("comentarios", {}))
    .flatMap(([clave, lista]) => lista.filter((c) => c.autor === nombre).map((c) => ({ ...c, clave })))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  const susAmigos = amigos.de(nombre);
  const obras = await obrasDeClaves([...susResenas, ...soloPuntajes, ...susComentarios].map((x) => x.clave));
  const promedio = susPuntajes.length
    ? susPuntajes.reduce((suma, p) => suma + p.valor, 0) / susPuntajes.length
    : null;
  document.title = `${nombre} · El "Santi"-Grial`;

  const recibidas = propio ? amigos.recibidas(nombre) : [];
  const enviadas = propio ? amigos.enviadas(nombre) : [];

  return `
    <div class="cabecera-perfil">
      ${avatar(nombre, true)}
      <div class="crece">
        <h1>${escapar(nombre)} ${USUARIOS.some((u) => u.usuario === nombre && u.rol === "admin") ? `<span class="insignia">admin</span>` : ""}</h1>
        <div class="puntajes">
          <div class="puntaje"><div class="valor">${susResenas.length}</div><div class="etiqueta">Reseñas</div></div>
          <div class="puntaje"><div class="valor">${susPuntajes.length}</div><div class="etiqueta">Puntuaciones</div></div>
          <div class="puntaje"><div class="valor">${promedio ? promedio.toFixed(1) : "–"}<small>/5</small></div><div class="etiqueta">Puntaje promedio</div></div>
          <div class="puntaje"><div class="valor">${susAmigos.length}</div><div class="etiqueta">Amigos</div></div>
        </div>
      </div>
      <div class="fila-form">${botonAmistad(nombre)}</div>
    </div>

    ${recibidas.length || enviadas.length ? `
      <section class="seccion panel">
        <h2>Solicitudes de amistad</h2>
        <div class="lista-admin">
          ${recibidas.map((otro) => `
            <div class="fila-admin">
              <span class="crece">${linkUsuario(otro)} <span class="suave">quiere ser tu amigo</span></span>
              ${botonAmistad(otro)}
            </div>`).join("")}
          ${enviadas.map((otro) => `
            <div class="fila-admin">
              <span class="crece">${linkUsuario(otro)} <span class="suave">todavía no respondió</span></span>
              ${botonAmistad(otro)}
            </div>`).join("")}
        </div>
      </section>` : ""}

    <section class="seccion">
      <h2>Reseñas (${susResenas.length})</h2>
      <div class="resenas">
        ${susResenas.map((r) => tarjetaResena(r, { obra: obras[r.clave], autor: false })).join("")
          || `<p class="suave">${propio ? "Todavía no escribiste reseñas." : "Todavía no escribió reseñas."}</p>`}
      </div>
    </section>

    ${soloPuntajes.length ? `
      <section class="seccion">
        <h2>Puntuaciones sin reseña (${soloPuntajes.length})</h2>
        <div class="grilla">
          ${soloPuntajes.map((p) => `
            <div>
              ${obras[p.clave].tarjeta}
              <div style="margin-top:6px">${estrellas(p.valor, false)}</div>
            </div>`).join("")}
        </div>
      </section>` : ""}

    <section class="seccion">
      <h2>Amigos (${susAmigos.length})</h2>
      ${susAmigos.length
        ? `<div class="lista-amigos">${susAmigos.map(linkUsuario).join("")}</div>`
        : `<p class="suave">${propio
          ? `Todavía no tenés amigos. Buscalos en <a href="#/comunidad" style="color:var(--acento)">Comunidad</a>.`
          : "Todavía no tiene amigos."}</p>`}
    </section>

    ${susComentarios.length ? `
      <section class="seccion">
        <h2>Comentarios anteriores (${susComentarios.length})</h2>
        <div class="comentarios">
          ${susComentarios.map((c) => `
            <div class="comentario">
              <div class="cabecera">
                <a class="autor" href="${obras[c.clave].href}">${escapar(obras[c.clave].titulo)}</a>
                <span class="fecha">${formatearFecha(c.fecha)}</span>
              </div>
              <p>${escapar(c.texto)}</p>
            </div>`).join("")}
        </div>
      </section>` : ""}`;
}

function eventosUsuario() {
  eventosAmistad();
  eventosLikes();
}

async function vistaComunidad() {
  if (!hayCredenciales()) return avisoSinCredenciales();
  const usuario = auth.usuarioActual();
  const misAmigos = new Set(usuario ? amigos.de(usuario) : []);
  const todas = resenas.todas();
  const deAmigos = todas.filter((r) => misAmigos.has(r.autor));
  const recientes = (deAmigos.length ? deAmigos : todas).slice(0, 8);
  const obras = await obrasDeClaves(recientes.map((r) => r.clave));

  const cantidadResenas = {};
  todas.forEach((r) => { cantidadResenas[r.autor] = (cantidadResenas[r.autor] ?? 0) + 1; });
  // Primero los amigos, después el resto
  const nombres = todosLosUsuarios().sort((a, b) => misAmigos.has(b) - misAmigos.has(a));
  document.title = `Comunidad · El "Santi"-Grial`;

  return `
    <h1>Comunidad</h1>
    <section class="seccion">
      <h2>${deAmigos.length ? "Lo último de tus amigos" : "Reseñas recientes"}</h2>
      <div class="resenas">
        ${recientes.map((r) => tarjetaResena(r, { obra: obras[r.clave] })).join("")
          || `<p class="suave">Todavía nadie escribió reseñas.</p>`}
      </div>
    </section>

    <section class="seccion">
      <h2>Usuarios <span class="suave" style="font-size:1rem">${nombres.length}</span></h2>
      <div class="fila-form">
        <input type="search" id="buscar-usuarios" placeholder="Buscar usuarios…" autocomplete="off">
      </div>
      <div class="lista-usuarios">
        ${nombres.map((n) => `
          <div class="fila-usuario" data-nombre="${escapar(n.toLowerCase())}">
            ${linkUsuario(n)}
            ${n === usuario ? `<span class="insignia">vos</span>` : ""}
            <span class="suave crece">${cantidadResenas[n] ?? 0} reseñas · ${amigos.de(n).length} amigos</span>
            ${botonAmistad(n)}
          </div>`).join("")}
      </div>
      <p class="suave" id="sin-usuarios" hidden>No hay usuarios con ese nombre.</p>
    </section>`;
}

function eventosComunidad() {
  eventosAmistad();
  eventosLikes();
  const buscar = document.getElementById("buscar-usuarios");
  if (!buscar) return;
  buscar.oninput = () => {
    const texto = buscar.value.trim().toLowerCase();
    let visibles = 0;
    document.querySelectorAll(".fila-usuario").forEach((f) => {
      f.hidden = !f.dataset.nombre.includes(texto);
      if (!f.hidden) visibles++;
    });
    document.getElementById("sin-usuarios").hidden = visibles > 0;
  };
}

function vistaNoEncontrada() {
  return `
    <div class="cargando">
      <h1>404</h1>
      <p>Esta página no existe.</p>
      <a class="btn" href="#/">Volver al inicio</a>
    </div>`;
}

// ---------------------------------------------------------------
//  Router (rutas por hash: #/pelicula/27205, #/serie/1399/temporada/1, ...)
// ---------------------------------------------------------------
const rutas = [
  { patron: /^\/?$/, vista: vistaInicio },
  { patron: /^\/login$/, vista: vistaLogin, despues: eventosLogin },
  { patron: /^\/perfil$/, vista: vistaPerfil },
  { patron: /^\/usuario\/([^/]+)$/, vista: vistaUsuario, despues: eventosUsuario },
  { patron: /^\/comunidad$/, vista: vistaComunidad, despues: eventosComunidad },
  { patron: /^\/musica$/, vista: vistaMusica, despues: eventosMusica },
  { patron: /^\/musica\/buscar\/(.+)$/, vista: vistaBusquedaMusica, despues: eventosBusquedaMusica },
  { patron: /^\/musica\/charts(?:\/(\d{4}))?$/, vista: vistaCharts, despues: eventosCharts },
  { patron: /^\/artista\/([0-9a-f-]{36})$/, vista: vistaArtista },
  { patron: /^\/album\/([0-9a-f-]{36})$/, vista: vistaAlbum, despues: eventosAlbum },
  { patron: /^\/pelicula\/(\d+)$/, vista: vistaPelicula, despues: eventosPelicula },
  { patron: /^\/series$/, vista: vistaSeries },
  { patron: /^\/serie\/(\d+)$/, vista: vistaSerie, despues: eventosSerie },
  { patron: /^\/serie\/(\d+)\/temporada\/(\d+)$/, vista: vistaTemporada, despues: eventosTemporada },
  { patron: /^\/serie\/(\d+)\/temporada\/(\d+)\/episodio\/(\d+)$/, vista: vistaEpisodio, despues: eventosEpisodio },
  { patron: /^\/tags$/, vista: vistaTags, despues: eventosCarruseles },
  { patron: /^\/persona\/(\d+)$/, vista: vistaPersona, despues: eventosCarruseles },
  { patron: /^\/tag\/([^/]+)$/, vista: vistaTag, despues: eventosListado },
  { patron: /^\/catalogo$/, vista: vistaCatalogo, despues: eventosListado },
  { patron: /^\/admin$/, vista: vistaAdmin, despues: eventosAdmin },
  { patron: /^\/buscar\/(.+)$/, vista: vistaBusqueda },
];

let renderActual = 0;

// recargar() vuelve a dibujar la ruta actual sin el "Cargando…" ni perder el scroll
const recargar = () => router(true);

async function router(mantenerScroll = false) {
  const ruta = location.hash.slice(1) || "/";
  const coincidencia = rutas
    .map((r) => ({ ...r, params: ruta.match(r.patron) }))
    .find((r) => r.params);

  if (!ruta.startsWith("/login")) sessionStorage.setItem("volverA", location.hash || "#/");

  const id = ++renderActual;
  const scroll = window.scrollY;
  document.title = `El "Santi"-Grial`;
  if (!mantenerScroll) app.innerHTML = `<div class="cargando">Cargando…</div>`;

  try {
    const html = coincidencia
      ? await coincidencia.vista(...coincidencia.params.slice(1))
      : vistaNoEncontrada();
    if (id !== renderActual) return; // el usuario ya navegó a otra ruta
    app.innerHTML = html;
    if (mantenerScroll) window.scrollTo(0, scroll);
    coincidencia?.despues?.(...coincidencia.params.slice(1));
  } catch (err) {
    if (id !== renderActual) return;
    console.error(err);
    app.innerHTML = avisoError(err);
  }
}

document.getElementById("form-busqueda").onsubmit = (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) location.hash = `#/buscar/${encodeURIComponent(q)}`;
};

window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  editandoResena = false;
  router();
});

store.cargar()
  .then(() => {
    renderZonaUsuario();
    router();
  })
  .catch((err) => {
    console.error(err);
    const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
    app.innerHTML = local
      ? `
      <div class="aviso error">
        No se pudo conectar con el servidor. Inicialo con <code>node servidor.js</code>
        y abrí <a href="http://localhost:3000" style="color:var(--acento)">http://localhost:3000</a>.
      </div>`
      : `
      <div class="aviso error">
        No se pudieron cargar los datos del servidor: ${escapar(err.message)}
      </div>`;
  });
