import { type PluginManifest, pluginManifestSchema } from "@millhiore/contracts"
import { unzipSync } from "fflate"
import { HttpError } from "../../http/errors"

/** Topes del paquete: que un .zip mal hecho (o una bomba de compresión) no tumbe el servidor. */
export const MAX_ARCHIVE_BYTES = 5_000_000
const MAX_UNPACKED_BYTES = 20_000_000
const MAX_FILES = 300

export interface PluginArchive {
  manifest: PluginManifest
  /** Los archivos del paquete por su ruta («page/index.html»). */
  files: Map<string, Uint8Array>
}

const invalid = (message: string) => new HttpError(422, "INVALID_PLUGIN", message)

/** Una ruta segura dentro del paquete; null si sube de carpeta o es absoluta. */
function cleanPath(name: string): string | null {
  const path = name.replace(/\\/g, "/").replace(/^\.\//, "")
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path)) return null
  if (path.split("/").some((part) => part === ".." || part === "")) return null
  return path
}

/**
 * Lee y valida un plugin (.zip con `manifest.json` en la raíz o en una sola carpeta): que el
 * manifiesto sea válido y que lo que nombra (el código del servidor, la página) exista.
 */
export function readArchive(bytes: Uint8Array): PluginArchive {
  if (bytes.byteLength === 0) throw invalid("Falta el archivo del plugin")
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new HttpError(413, "PLUGIN_TOO_LARGE", "El plugin pesa más de 5 MB")
  }
  let entries: Record<string, Uint8Array>
  let unpacked = 0
  let count = 0
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        count++
        unpacked += file.originalSize
        if (count > MAX_FILES) throw invalid(`El plugin trae más de ${MAX_FILES} archivos`)
        if (unpacked > MAX_UNPACKED_BYTES)
          throw invalid("El plugin descomprimido pesa más de 20 MB")
        return !file.name.endsWith("/")
      },
    })
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw invalid("No es un .zip válido")
  }
  const raw = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(entries)) {
    const path = cleanPath(name)
    if (!path) throw invalid(`Ruta inválida en el paquete: ${name}`)
    // Lo que agregan macOS y Windows al comprimir no es del plugin.
    if (path.startsWith("__MACOSX/") || path.endsWith(".DS_Store") || path.endsWith("Thumbs.db")) {
      continue
    }
    raw.set(path, data)
  }
  // El manifiesto en la raíz o dentro de una única carpeta (como queda al comprimir la carpeta).
  let prefix = ""
  if (!raw.has("manifest.json")) {
    const roots = new Set([...raw.keys()].map((p) => p.split("/")[0]))
    const [only] = roots
    if (roots.size === 1 && only && raw.has(`${only}/manifest.json`)) prefix = `${only}/`
    else throw invalid("Falta manifest.json")
  }
  const files = new Map<string, Uint8Array>()
  for (const [path, data] of raw) {
    if (path.startsWith(prefix)) files.set(path.slice(prefix.length), data)
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(files.get("manifest.json")))
  } catch {
    throw invalid("manifest.json no es un JSON válido")
  }
  const parsed = pluginManifestSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalid(
      `manifest.json: ${issue?.path.join(".") || "?"} — ${issue?.message ?? "inválido"}`,
    )
  }
  const manifest = parsed.data
  if (!manifest.server && !manifest.page) {
    throw invalid("El plugin no trae ni código del servidor ni pantalla")
  }
  if (manifest.server && !files.has(manifest.server)) {
    throw invalid(`Falta ${manifest.server}, el código del servidor`)
  }
  if (manifest.page && !files.has(manifest.page.entry)) {
    throw invalid(`Falta ${manifest.page.entry}, la pantalla del plugin`)
  }
  return { manifest, files }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  txt: "text/plain; charset=utf-8",
}

/** El tipo de un archivo del paquete por su extensión; null si no se sirve. */
export function contentType(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return TYPES[ext] ?? null
}
