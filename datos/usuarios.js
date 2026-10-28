// Usuarios que pueden ingresar al sitio.
// rol: "admin" puede agregar y quitar películas del catálogo, crear tags y asignarlos.
// Las cuentas creadas desde "Crear cuenta" se guardan en el navegador (localStorage),
// porque una página sin servidor no puede escribir en este archivo. Nunca son admin.
const USUARIOS = [
  { usuario: "santiagod", clave: "1234",  rol: "admin" },
  { usuario: "admin",     clave: "admin", rol: "admin" },
];
