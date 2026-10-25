// Corre en el servidor, aislado: solo puede usar `millhiore` (la API con los permisos del
// manifiesto, su almacenamiento y su registro).

// Cada venta llega con el documento completo.
millhiore.on("sale.posted", async (sale) => {
  const count = (await millhiore.storage.get("ventas")) ?? 0
  await millhiore.storage.set("ventas", count + 1)
  millhiore.log(`Venta ${sale.number}`)
})

// Una ruta propia: la pantalla del plugin la llama con millhiore.route("GET", "/resumen").
millhiore.route("GET", "/resumen", async () => {
  const day = await millhiore.api("GET", "/api/reports/day")
  if (day.status !== 200) return { status: day.status, body: day.body }
  return {
    status: 200,
    body: {
      desdeQueSeInstalo: (await millhiore.storage.get("ventas")) ?? 0,
      hoy: day.body.sales.count,
      totalHoy: day.body.sales.totalLegalMinor,
      moneda: day.body.legalCurrency,
    },
  }
})

// Una tarea cada hora.
millhiore.every(60, async () => {
  millhiore.log("Sigo contando")
})
