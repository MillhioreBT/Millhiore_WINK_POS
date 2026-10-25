// La pantalla corre en un marco aislado: habla con la app solo por `millhiore` (mensajes).
const money = (minor, currency) =>
  `${currency === "VES" ? "Bs" : currency} ${(minor / 100).toLocaleString("es-VE", { minimumFractionDigits: 2 })}`

async function load() {
  const estado = document.getElementById("estado")
  try {
    const info = await millhiore.ready
    estado.textContent = `Hola, ${info.user.name}.`
    const r = await millhiore.route("GET", "/resumen")
    document.getElementById("hoy").textContent = String(r.hoy)
    document.getElementById("total").textContent = money(r.totalHoy, r.moneda)
    document.getElementById("desde").textContent = String(r.desdeQueSeInstalo)
    document.getElementById("datos").hidden = false
  } catch (e) {
    estado.textContent = `No se pudo cargar: ${e.message}`
  }
}

document.getElementById("actualizar").addEventListener("click", load)
load()
