// Usuarios que pueden ingresar al sitio.
// rol: "admin" puede agregar y quitar películas del catálogo, crear tags y asignarlos.
// Las cuentas creadas desde "Crear cuenta" las guarda el servidor en datos/guardados.json.
// Nunca son admin: para eso hay que agregarlas acá.
const USUARIOS = [
  { usuario: "santiagod", clave: "1234",  rol: "admin" },
  { usuario: "admin",     clave: "admin", rol: "admin" },
  { usuario: "perezelraton",     clave: "1234", rol: "admin" },
];
