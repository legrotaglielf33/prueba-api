// Películas y series del catálogo, con sus tags.
// - id: el id en TMDB (aparece en la URL de themoviedb.org/movie/<id> o themoviedb.org/tv/<id>).
// - tipo: "serie" para las series; si no está, es una película.
// - Si no sabés el id, usá "buscar" (título) y "anio": la app la busca en TMDB y recuerda el resultado.
// - titulo: sólo de referencia, la app muestra el título que devuelve TMDB.
const PELICULAS = [
  { id: 1893,   titulo: "Star Wars: Episodio I - La amenaza fantasma",   tags: ["santiagod"] },
  { id: 1894,   titulo: "Star Wars: Episodio II - El ataque de los clones", tags: ["santiagod"] },
  { id: 1895,   titulo: "Star Wars: Episodio III - La venganza de los Sith", tags: ["santiagod"] },
  { id: 11,     titulo: "Star Wars: Episodio IV - Una nueva esperanza",  tags: ["santiagod"] },
  { id: 1891,   titulo: "Star Wars: Episodio V - El imperio contraataca", tags: ["santiagod"] },
  { id: 1892,   titulo: "Star Wars: Episodio VI - El regreso del Jedi",  tags: ["santiagod"] },
  { id: 330459, titulo: "Rogue One",                                     tags: ["santiagod"] },
  { id: 238,    titulo: "El Padrino",                                    tags: ["santiagod"] },
  { id: 240,    titulo: "El Padrino II",                                 tags: ["santiagod"] },
  { id: 77,     titulo: "Memento",                                       tags: ["santiagod"] },
  { id: 27205,  titulo: "Inception",                                     tags: ["santiagod"] },
  { id: 155,    titulo: "The Dark Knight",                               tags: ["santiagod"] },
  { buscar: "The Odyssey", anio: 2026, titulo: "La Odisea (Nolan)",      tags: ["santiagod"] },
  { id: 24,     titulo: "Kill Bill Vol. 1",                              tags: ["santiagod"] },
  { id: 393,    titulo: "Kill Bill Vol. 2",                              tags: ["santiagod"] },
  { id: 600,    titulo: "Full Metal Jacket",                             tags: ["santiagod"] },
];
