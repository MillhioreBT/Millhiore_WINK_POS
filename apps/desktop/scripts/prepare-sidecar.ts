// Prepara lo que empaqueta Tauri: el servidor compilado con Bun (sidecar), la web compilada y
// las migraciones. Se ejecuta antes de `tauri dev` / `tauri build`.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { $ } from "bun"

// El servidor compilado lleva dentro el Bun con que se compila: uno anterior a 1.4.4 tiene fallos
// de seguridad (descompresión Brotli, certificados raíz, HTTP/3) que irían en el instalador.
const MIN_BUN = "1.4.4"
if (Bun.semver.order(Bun.version, MIN_BUN) < 0) {
  throw new Error(`Bun ${Bun.version} es vulnerable: actualiza a ${MIN_BUN} o más (bun upgrade)`)
}

const root = resolve(import.meta.dir, "..", "..", "..")
const tauriDir = resolve(import.meta.dir, "..", "src-tauri")

// Triple del compilador de Rust: Tauri busca el sidecar con ese sufijo.
const rustInfo = await $`rustc -vV`.text()
const triple = /host: (\S+)/.exec(rustInfo)?.[1]
if (!triple) throw new Error("No se pudo leer el triple de rustc (¿está instalado Rust?)")
const exe = triple.includes("windows") ? ".exe" : ""

console.log("· compilando la web")
await $`bunx turbo run build --filter=@millhiore/web`.cwd(root).quiet()

console.log(`· compilando el servidor para ${triple}`)
mkdirSync(join(tauriDir, "binaries"), { recursive: true })
const outfile = join(tauriDir, "binaries", `millhiore-server-${triple}${exe}`)
// Programa de consola (sirve para `reset-password`); Tauri lo lanza sin ventana (CREATE_NO_WINDOW).
await $`bun build ${join(root, "apps/server/src/main.ts")} --compile --minify --outfile ${outfile}`.quiet()

console.log("· copiando la web y las migraciones")
const resources = join(tauriDir, "resources")
rmSync(resources, { recursive: true, force: true })
cpSync(join(root, "apps/web/dist"), join(resources, "web"), { recursive: true })
cpSync(join(root, "packages/db/drizzle"), join(resources, "drizzle"), { recursive: true })
cpSync(
  join(root, "apps/web/public/favicon.svg"),
  resolve(import.meta.dir, "..", "splash", "icon.svg"),
)

if (!existsSync(join(tauriDir, "icons", "icon.ico"))) {
  console.log("· generando íconos")
  await $`bunx tauri icon ${join(root, "apps/web/public/favicon.svg")}`
    .cwd(resolve(import.meta.dir, ".."))
    .quiet()
}
console.log("Listo:", outfile)
