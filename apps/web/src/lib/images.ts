/**
 * Achica una foto en el navegador antes de subirla (el lado más largo a `max` píxeles, en JPEG):
 * una foto del celular de 4 MB queda en unos 150 KB y el catálogo carga rápido con datos móviles.
 * Respeta la orientación con que se tomó.
 */
export async function shrinkImage(file: Blob, max = 1000, quality = 0.82): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" })
  } catch {
    throw new Error("Esa foto no se puede leer: elige una JPG o PNG")
  }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Este navegador no puede preparar la foto")
  // Lo transparente de un PNG queda blanco (JPEG no tiene transparencia).
  ctx.fillStyle = "#fff"
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("No se pudo preparar la foto"))),
      "image/jpeg",
      quality,
    ),
  )
}
