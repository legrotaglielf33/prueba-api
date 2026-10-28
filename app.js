// ===================================================================
//  El "Santi"-Grial — SPA con la API de TMDB, login, ratings, comentarios y tags
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

// Estas claves se guardan en el servidor (datos/guardados.json) y las ven todos.
// El resto (sesión, búsquedas en caché, preferencias) queda en este navegador.
const COMPARTIDAS = ["usuarios", "ratings", "comentarios", "tags_admin", "catalogo"];
let datosServidor = {};

const store = {
  // Trae los datos del servidor. Se llama una vez, antes de mostrar la página.
  async cargar() {
    const resp = await fetch("/api/datos");
    if (!resp.ok) throw new Error(`El servidor respondió ${resp.status}`);
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
  return `${entrada.buscar}|${entrada.anio ?? ""}`;
}

// Convierte una entrada de PELICULAS en un id de TMDB.
async function resolverId(entrada) {
  if (entrada.id) return entrada.id;

  const cache = store.leer("cache_busquedas", {});
  const clave = claveBusqueda(entrada);
  if (cache[clave]) return cache[clave];

  const params = { query: entrada.buscar };
  if (entrada.anio) params.primary_release_year = entrada.anio;
  const { results } = await tmdb("/search/movie", params);
  if (!results.length) return null;

  cache[clave] = results[0].id;
  store.guardar("cache_busquedas", cache);
  return results[0].id;
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
// ---------------------------------------------------------------
const ratings = {
  // { [peliId]: { [usuario]: 1..5 } }
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
  // { [peliId]: [{ id, autor, texto, fecha }] }
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
    for (const peli of await catalogo.todas()) {
      if (peli.tags.includes(nombre)) await catalogo.quitarTag(peli.id, nombre);
    }
  },
};

const catalogo = {
  // Cambios de los admins: { [id]: { titulo, tags, quitada } }
  cambios() {
    return store.leer("catalogo", {});
  },
  guardarCambio(id, cambio) {
    const todos = this.cambios();
    todos[id] = { ...(todos[id] ?? {}), ...cambio };
    store.guardar("catalogo", todos);
  },
  async todas() {
    const ids = await Promise.all(PELICULAS.map((p) => resolverId(p).catch(() => null)));
    const lista = new Map();
    PELICULAS.forEach((p, i) => {
      if (ids[i]) lista.set(ids[i], { id: ids[i], titulo: p.titulo, tags: p.tags ?? [] });
    });
    for (const [id, cambio] of Object.entries(this.cambios())) {
      const previa = lista.get(Number(id)) ?? { id: Number(id), tags: [] };
      lista.set(Number(id), { ...previa, ...cambio });
    }
    return [...lista.values()].filter((p) => !p.quitada);
  },
  async buscar(id) {
    return (await this.todas()).find((p) => p.id === id) ?? null;
  },
  async idsDeTag(tag) {
    return (await this.todas()).filter((p) => p.tags.includes(tag)).map((p) => p.id);
  },
  agregar(id, titulo, tags = []) {
    etiquetas.asegurar(tags);
    this.guardarCambio(id, { titulo, tags, quitada: false });
  },
  async agregarTag(id, titulo, tag) {
    const peli = await this.buscar(id);
    etiquetas.asegurar([tag]);
    this.guardarCambio(id, {
      titulo: peli?.titulo ?? titulo,
      tags: [...new Set([...(peli?.tags ?? []), tag])],
      quitada: false,
    });
  },
  async quitarTag(id, tag) {
    const peli = await this.buscar(id);
    if (peli) this.guardarCambio(id, { tags: peli.tags.filter((t) => t !== tag) });
  },
  quitar(id) {
    this.guardarCambio(id, { quitada: true });
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
  const lineas = (await catalogo.todas()).map((p) =>
    `  { id: ${p.id}, titulo: ${JSON.stringify(p.titulo ?? "")}, tags: ${JSON.stringify(p.tags)} },`);
  descargar("peliculas.js", `// Películas con tags predefinidos.
// - id: el id de la película en TMDB (aparece en la URL de themoviedb.org/movie/<id>).
// - Si no sabés el id, usá "buscar" (título) y "anio": la app la busca en TMDB y recuerda el resultado.
// - titulo: sólo de referencia, la app muestra el título que devuelve TMDB.
const PELICULAS = [
${lineas.join("\n")}
];
`);
}

function exportarTags() {
  descargar("tags.js", `// Tags predefinidos. La clave es el nombre del tag (lo que va después del #).
// Para asignarle un tag a una película, agregalo en datos/peliculas.js.
const TAGS = ${JSON.stringify(etiquetas.todas(), null, 2)};
`);
}

// ---------------------------------------------------------------
//  Componentes de HTML
// ---------------------------------------------------------------
function tarjeta(peli) {
  const poster = peli.poster_path
    ? `<img class="poster" src="${IMG}w342${peli.poster_path}" alt="${escapar(peli.title)}" loading="lazy">`
    : `<div class="sin-poster">${escapar(peli.title)}</div>`;
  const local = ratings.promedio(peli.id);
  return `
    <a class="tarjeta" href="#/pelicula/${peli.id}">
      ${poster}
      <div class="info">
        <h3>${escapar(peli.title)}</h3>
        <div class="meta">
          <span>${anio(peli.release_date)}</span>
          <span>★ ${peli.vote_average ? peli.vote_average.toFixed(1) : "–"}${local ? ` · ${local.valor.toFixed(1)}/5` : ""}</span>
        </div>
      </div>
    </a>`;
}

function estrellas(valor, editable) {
  let html = `<div class="estrellas ${editable ? "" : "solo-lectura"}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<button type="button" data-valor="${i}" class="${i <= valor ? "activa" : ""}" ${editable ? "" : "disabled"} aria-label="${i} estrellas">★</button>`;
  }
  return html + "</div>";
}

// Listado con orden y filtro por género (para el catálogo y las páginas de tags).
// Necesita películas con detalle completo (que traigan "genres").
let pelisListado = [];

const ORDENES = {
  genero: "Género",
  titulo: "Título",
  anio: "Año",
  puntaje: "Puntaje TMDB",
};

function preferenciasListado() {
  return store.leer("listado", { orden: "genero", genero: "" });
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

  return `
    <div class="controles">
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
  const { orden, genero } = preferenciasListado();
  const pelis = pelisListado.filter((p) => !genero || p.genres.some((g) => g.name === genero));
  if (!pelis.length) return `<p class="suave">No hay películas para mostrar.</p>`;

  const porAnio = (a, b) => (a.release_date || "").localeCompare(b.release_date || "");

  if (orden === "genero") {
    // Cada película va en su género principal (el primero que da TMDB)
    const grupos = {};
    for (const p of [...pelis].sort(porAnio)) {
      const g = genero || p.genres[0]?.name || "Sin género";
      (grupos[g] ??= []).push(p);
    }
    return Object.keys(grupos).sort((a, b) => a.localeCompare(b)).map((g) => `
      <h3 class="titulo-genero">${escapar(g)} <span class="suave">(${grupos[g].length})</span></h3>
      <div class="grilla">${grupos[g].map(tarjeta).join("")}</div>`).join("");
  }

  const comparar = {
    titulo: (a, b) => a.title.localeCompare(b.title),
    anio: porAnio,
    puntaje: (a, b) => b.vote_average - a.vote_average,
  }[orden] ?? porAnio;
  return `<div class="grilla">${[...pelis].sort(comparar).map(tarjeta).join("")}</div>`;
}

function eventosListado() {
  const orden = document.getElementById("orden");
  const genero = document.getElementById("filtro-genero");
  if (!orden) return;
  const actualizar = () => {
    store.guardar("listado", { orden: orden.value, genero: genero.value });
    document.getElementById("resultado-listado").innerHTML = dibujarListado();
  };
  orden.onchange = actualizar;
  genero.onchange = actualizar;
}

async function detallesDe(ids) {
  return (await Promise.all(ids.map((id) => tmdb(`/movie/${id}`).catch(() => null)))).filter(Boolean);
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
    ${Object.keys(etiquetas.todas()).map((t) =>
      `<a href="#/tag/${encodeURIComponent(t)}">#${escapar(t)}</a>`).join("")}
    ${auth.esAdmin() ? `<a href="#/admin">⚙ Admin</a>` : ""}`;
}

function renderZonaUsuario() {
  renderMenu();
  const zona = document.getElementById("zona-usuario");
  const usuario = auth.usuarioActual();
  if (usuario) {
    zona.innerHTML = `
      <a href="#/perfil">👤 ${escapar(usuario)}${auth.esAdmin() ? ` <span class="insignia">admin</span>` : ""}</a>
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

  const [tendencias, mejores, secciones] = await Promise.all([
    tmdb("/trending/movie/week"),
    tmdb("/movie/top_rated"),
    Promise.all(Object.keys(etiquetas.todas()).map(async (tag) => {
      const ids = await catalogo.idsDeTag(tag);
      return { tag, total: ids.length, pelis: await detallesDe(ids.slice(0, 6)) };
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
        <div class="grilla">${s.pelis.map(tarjeta).join("")}</div>
      </section>`).join("")}

    <section class="seccion">
      <h2>Tendencias de la semana</h2>
      <div class="grilla">${tendencias.results.slice(0, 12).map(tarjeta).join("")}</div>
    </section>

    <section class="seccion">
      <h2>Mejor puntuadas</h2>
      <div class="grilla">${mejores.results.slice(0, 12).map(tarjeta).join("")}</div>
    </section>`;
}

async function vistaPelicula(id) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  id = Number(id);

  const peli = await tmdb(`/movie/${id}`, { append_to_response: "credits,videos" });
  // Si no hay trailer en español, se busca en inglés
  let videos = peli.videos.results;
  if (!videos.some((v) => v.site === "YouTube" && v.type === "Trailer")) {
    videos = (await tmdb(`/movie/${id}/videos`, { language: "en-US" })).results;
  }
  const trailer = videos.find((v) => v.site === "YouTube" && v.type === "Trailer");

  const usuario = auth.usuarioActual();
  const miRating = usuario ? ratings.dePelicula(id)[usuario] ?? 0 : 0;
  const promedio = ratings.promedio(id);
  const director = peli.credits.crew.find((c) => c.job === "Director");
  const enCatalogo = await catalogo.buscar(id);
  const tagsPeli = enCatalogo?.tags ?? [];
  const admin = auth.esAdmin();
  const lista = comentarios.dePelicula(id);
  peliActual = { id, titulo: peli.title };

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
            ${director ? `<span>🎬 ${escapar(director.name)}</span>` : ""}
            ${peli.original_title !== peli.title ? `<span>Título original: ${escapar(peli.original_title)}</span>` : ""}
          </div>

          <div class="tags">
            ${peli.genres.map((g) => `<span class="tag genero">${escapar(g.name)}</span>`).join("")}
          </div>
          <div class="tags">
            ${tagsPeli.map((t) => `
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
            </form>` : ""}

          <p>${escapar(peli.overview || "Sin sinopsis disponible.")}</p>

          <div class="puntajes">
            <div class="puntaje">
              <div class="valor">${peli.vote_average.toFixed(1)}<small>/10</small></div>
              <div class="etiqueta">TMDB · ${peli.vote_count.toLocaleString("es-AR")} votos</div>
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
          </div>
        </div>
      </div>
    </div>

    ${trailer ? `
      <section class="seccion" style="margin-top:32px">
        <h2>Tráiler</h2>
        <iframe class="trailer" src="https://www.youtube.com/embed/${trailer.key}" title="Tráiler" allowfullscreen></iframe>
      </section>` : ""}

    <section class="seccion" style="margin-top:32px">
      <h2>Reparto</h2>
      <div class="reparto">
        ${peli.credits.cast.slice(0, 12).map((a) => `
          <div class="actor">
            ${a.profile_path
              ? `<img src="${IMG}w185${a.profile_path}" alt="${escapar(a.name)}" loading="lazy">`
              : `<div class="sin-poster">Sin foto</div>`}
            ${escapar(a.name)}
            <span>${escapar(a.character)}</span>
          </div>`).join("") || `<p class="suave">Sin datos de reparto.</p>`}
      </div>
    </section>

    <section class="seccion">
      <h2>Comentarios (${lista.length})</h2>
      ${usuario
        ? `<form class="form-comentario" id="form-comentario">
             <textarea name="texto" placeholder="¿Qué te pareció ${escapar(peli.title)}?" maxlength="1000" required></textarea>
             <button class="btn">Publicar</button>
           </form>`
        : `<p class="aviso"><a href="#/login" style="color:var(--acento)">Ingresá</a> para dejar un comentario.</p>`}
      <div class="comentarios">
        ${lista.map((c) => {
          const suRating = ratings.dePelicula(id)[c.autor];
          return `
            <div class="comentario">
              <div class="cabecera">
                <div>
                  <span class="autor">${escapar(c.autor)}</span>
                  ${suRating ? estrellas(suRating, false) : ""}
                </div>
                <div>
                  <span class="fecha">${formatearFecha(c.fecha)}</span>
                  ${c.autor === usuario ? `<button class="btn-link" data-borrar="${c.id}">Borrar</button>` : ""}
                </div>
              </div>
              <p>${escapar(c.texto)}</p>
            </div>`;
        }).join("") || `<p class="suave">Todavía no hay comentarios. ¡Sé el primero!</p>`}
      </div>
    </section>`;
}

let peliActual = null;

// Eventos de la página de película (se enganchan después de renderizar)
function eventosPelicula(id) {
  id = Number(id);
  const usuario = auth.usuarioActual();
  if (!usuario) return;

  document.querySelectorAll("#mi-rating button").forEach((b) => {
    b.onclick = () => {
      ratings.poner(id, usuario, Number(b.dataset.valor));
      recargar();
    };
  });

  const quitarRating = document.getElementById("btn-quitar-rating");
  if (quitarRating) quitarRating.onclick = () => { ratings.quitar(id, usuario); recargar(); };

  document.getElementById("form-comentario").onsubmit = (e) => {
    e.preventDefault();
    const texto = e.target.texto.value.trim();
    if (!texto) return;
    comentarios.agregar(id, usuario, texto);
    recargar();
  };

  document.querySelectorAll("[data-borrar]").forEach((b) => {
    b.onclick = () => {
      if (confirm("¿Borrar este comentario?")) {
        comentarios.borrar(id, b.dataset.borrar);
        recargar();
      }
    };
  });

  if (!auth.esAdmin()) return;

  document.getElementById("form-tag").onsubmit = async (e) => {
    e.preventDefault();
    const tag = normalizarTag(e.target.elements.tag.value);
    if (!tag) return;
    await catalogo.agregarTag(id, peliActual.titulo, tag);
    renderMenu();
    recargar();
  };

  document.querySelectorAll("[data-quitar-tag]").forEach((b) => {
    b.onclick = async () => {
      await catalogo.quitarTag(id, b.dataset.quitarTag);
      recargar();
    };
  });

  const agregar = document.getElementById("btn-agregar-catalogo");
  if (agregar) agregar.onclick = () => { catalogo.agregar(id, peliActual.titulo); recargar(); };

  const quitar = document.getElementById("btn-quitar-catalogo");
  if (quitar) quitar.onclick = () => {
    if (confirm("¿Quitar esta película del catálogo? Se le borran también los tags.")) {
      catalogo.quitar(id);
      recargar();
    }
  };
}

function datalistTags() {
  return `<datalist id="lista-tags">
    ${Object.keys(etiquetas.todas()).map((t) => `<option value="${escapar(t)}">`).join("")}
  </datalist>`;
}

async function vistaTag(tag) {
  if (!hayCredenciales()) return avisoSinCredenciales();
  tag = normalizarTag(decodeURIComponent(tag));

  const pelis = await detallesDe(await catalogo.idsDeTag(tag));
  const descripcion = etiquetas.todas()[tag]?.descripcion;
  document.title = `#${tag} · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>#${escapar(tag)} <span class="suave" style="font-size:1rem">${pelis.length} películas</span></h2>
      ${descripcion ? `<p class="suave">${escapar(descripcion)}</p>` : ""}
      ${pelis.length ? listado(pelis) : `<p class="suave">No hay películas con este tag.</p>`}
    </section>`;
}

async function vistaCatalogo() {
  if (!hayCredenciales()) return avisoSinCredenciales();
  const pelis = await detallesDe((await catalogo.todas()).map((p) => p.id));
  document.title = `Catálogo · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>Catálogo <span class="suave" style="font-size:1rem">${pelis.length} películas</span></h2>
      ${pelis.length ? listado(pelis) : `<p class="suave">El catálogo está vacío.</p>`}
    </section>`;
}

// ---------- Panel de administración ----------
let ultimaBusquedaAdmin = "";

async function vistaAdmin() {
  if (!auth.esAdmin()) {
    return `
      <div class="aviso error">
        Esta página es sólo para administradores.
        ${auth.usuarioActual() ? "" : `<a href="#/login" style="color:var(--acento)">Ingresá</a> con una cuenta de administrador.`}
      </div>`;
  }

  const pelis = (await catalogo.todas()).sort((a, b) => (a.titulo ?? "").localeCompare(b.titulo ?? ""));
  const tags = etiquetas.todas();
  const cantidad = (tag) => pelis.filter((p) => p.tags.includes(tag)).length;
  document.title = `Admin · El "Santi"-Grial`;

  return `
    <h1>⚙ Panel de administración</h1>
    ${datalistTags()}

    <section class="seccion panel">
      <h2>Agregar película</h2>
      <form id="form-buscar-admin" class="fila-form">
        <input type="text" name="q" placeholder="Buscar en TMDB…" required value="${escapar(ultimaBusquedaAdmin)}">
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
            <span class="suave crece">${escapar(info.descripcion || "Sin descripción")} · ${cantidad(t)} películas</span>
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
      <h2>Catálogo (${pelis.length})</h2>
      <div class="lista-admin">
        ${pelis.map((p) => `
          <div class="fila-admin">
            <a class="crece" href="#/pelicula/${p.id}">${escapar(p.titulo || `Película ${p.id}`)}</a>
            <div class="tags">
              ${p.tags.map((t) => `
                <span class="tag especial">#${escapar(t)}
                  <button class="quitar-tag" data-id="${p.id}" data-quitar-tag="${escapar(t)}" title="Quitar tag">✕</button>
                </span>`).join("")}
            </div>
            <form class="form-tag-fila" data-id="${p.id}">
              <input type="text" name="tag" list="lista-tags" placeholder="+ tag" required>
            </form>
            <button class="btn-link" data-quitar-peli="${p.id}">Quitar</button>
          </div>`).join("") || `<p class="suave">El catálogo está vacío.</p>`}
      </div>
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

  const [{ results }, enCatalogo] = await Promise.all([tmdb("/search/movie", { query: q }), catalogo.todas()]);
  const ids = new Set(enCatalogo.map((p) => p.id));

  contenedor.innerHTML = `<div class="lista-admin">
    ${results.slice(0, 10).map((p) => `
      <div class="fila-admin">
        ${p.poster_path
          ? `<img class="mini" src="${IMG}w92${p.poster_path}" alt="">`
          : `<div class="mini sin-poster"></div>`}
        <a class="crece" href="#/pelicula/${p.id}">${escapar(p.title)} <span class="suave">(${anio(p.release_date)})</span></a>
        ${ids.has(p.id)
          ? `<span class="suave">Ya está en el catálogo</span>`
          : `<form class="form-agregar fila-form" data-id="${p.id}" data-titulo="${escapar(p.title)}">
               <input type="text" name="tags" placeholder="tags separados por coma">
               <button class="btn chico">Agregar</button>
             </form>`}
      </div>`).join("") || `<p class="suave">Sin resultados.</p>`}
  </div>`;

  contenedor.querySelectorAll(".form-agregar").forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const tags = f.elements.tags.value.split(",").map(normalizarTag).filter(Boolean);
      catalogo.agregar(Number(f.dataset.id), f.dataset.titulo, tags);
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
      if (!confirm(`¿Borrar #${b.dataset.borrarTag}? Se quita de todas las películas.`)) return;
      await etiquetas.borrar(b.dataset.borrarTag);
      renderMenu();
      recargar();
    };
  });

  document.querySelectorAll(".form-tag-fila").forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const tag = normalizarTag(f.elements.tag.value);
      if (!tag) return;
      await catalogo.agregarTag(Number(f.dataset.id), "", tag);
      renderMenu();
      recargar();
    };
  });

  document.querySelectorAll(".quitar-tag[data-id]").forEach((b) => {
    b.onclick = async () => {
      await catalogo.quitarTag(Number(b.dataset.id), b.dataset.quitarTag);
      recargar();
    };
  });

  document.querySelectorAll("[data-quitar-peli]").forEach((b) => {
    b.onclick = () => {
      if (!confirm("¿Quitar esta película del catálogo?")) return;
      catalogo.quitar(Number(b.dataset.quitarPeli));
      recargar();
    };
  });

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
  const { results } = await tmdb("/search/movie", { query: q });
  document.title = `Buscar "${q}" · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>Resultados para "${escapar(q)}"</h2>
      ${results.length
        ? `<div class="grilla">${results.map(tarjeta).join("")}</div>`
        : `<p class="suave">No se encontraron películas.</p>`}
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

async function vistaPerfil() {
  const usuario = auth.usuarioActual();
  if (!usuario) {
    location.hash = "#/login";
    return "";
  }
  if (!hayCredenciales()) return avisoSinCredenciales();

  const todosRatings = store.leer("ratings", {});
  const misRatings = Object.entries(todosRatings)
    .filter(([, r]) => r[usuario])
    .map(([id, r]) => ({ id: Number(id), valor: r[usuario] }));

  const todosComentarios = store.leer("comentarios", {});
  const misComentarios = Object.entries(todosComentarios)
    .flatMap(([id, lista]) => lista.filter((c) => c.autor === usuario).map((c) => ({ ...c, peliId: Number(id) })))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  const ids = [...new Set([...misRatings.map((r) => r.id), ...misComentarios.map((c) => c.peliId)])];
  const pelis = Object.fromEntries(
    (await Promise.all(ids.map((id) => tmdb(`/movie/${id}`).catch(() => null))))
      .filter(Boolean)
      .map((p) => [p.id, p]),
  );
  document.title = `${usuario} · El "Santi"-Grial`;

  return `
    <section class="seccion">
      <h2>👤 ${escapar(usuario)}</h2>
    </section>
    <section class="seccion">
      <h2>Mis puntuaciones (${misRatings.length})</h2>
      ${misRatings.length
        ? `<div class="grilla">${misRatings.filter((r) => pelis[r.id]).map((r) => `
            <div>
              ${tarjeta(pelis[r.id])}
              <div style="margin-top:6px">${estrellas(r.valor, false)}</div>
            </div>`).join("")}</div>`
        : `<p class="suave">Todavía no puntuaste ninguna película.</p>`}
    </section>
    <section class="seccion">
      <h2>Mis comentarios (${misComentarios.length})</h2>
      <div class="comentarios">
        ${misComentarios.map((c) => `
          <div class="comentario">
            <div class="cabecera">
              <a class="autor" href="#/pelicula/${c.peliId}">${escapar(pelis[c.peliId]?.title ?? "Película")}</a>
              <span class="fecha">${formatearFecha(c.fecha)}</span>
            </div>
            <p>${escapar(c.texto)}</p>
          </div>`).join("") || `<p class="suave">Todavía no comentaste nada.</p>`}
      </div>
    </section>`;
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
//  Router (rutas por hash: #/pelicula/27205, #/tag/santiagod, ...)
// ---------------------------------------------------------------
const rutas = [
  { patron: /^\/?$/, vista: vistaInicio },
  { patron: /^\/login$/, vista: vistaLogin, despues: eventosLogin },
  { patron: /^\/perfil$/, vista: vistaPerfil },
  { patron: /^\/pelicula\/(\d+)$/, vista: vistaPelicula, despues: eventosPelicula },
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
  router();
});

store.cargar()
  .then(() => {
    renderZonaUsuario();
    router();
  })
  .catch((err) => {
    console.error(err);
    app.innerHTML = `
      <div class="aviso error">
        No se pudo conectar con el servidor. Inicialo con <code>node servidor.js</code>
        y abrí <a href="http://localhost:3000" style="color:var(--acento)">http://localhost:3000</a>.
      </div>`;
  });
