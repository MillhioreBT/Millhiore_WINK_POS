import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { createApp } from "./app"
import { createAuth } from "./infra/auth"
import { backupDatabase, rotateBackups } from "./infra/backups"
import { loadConfig } from "./infra/config"
import { openDatabase } from "./infra/database"
import { ensureLocalTls, type LocalTls, localHosts } from "./infra/tls"
import { startJobs } from "./jobs"
import { PluginManager } from "./modules/plugins/manager"
import { findTailscale, processRunner, tailscaleStatus } from "./modules/remote/tailscale"
import { createStorefrontApp } from "./modules/storefront/app"
import { SyncClient } from "./modules/sync/client"

// Recuperar el acceso desde la PC del servidor: `millhiore-server reset-password <usuario>`.
if (process.argv[2] === "reset-password") {
  const { resetPasswordCli } = await import("./cli/reset-password")
  process.exit(await resetPasswordCli(process.argv.slice(3)))
}

const config = loadConfig()
// Aplica una restauración pendiente (Ajustes → Respaldos), respalda antes de migrar y migra.
const db = openDatabase(config.dataDir, { applyRestore: true })

// Acceso remoto con Tailscale: si ya sirve la app con HTTPS (https://pc.red.ts.net), ese origen
// también es de confianza para las sesiones (se suma sin reiniciar si se activa después).
const tailscaleBin = findTailscale()
const remote = {
  run: tailscaleBin ? processRunner(tailscaleBin) : null,
  origins: new Set<string>(),
}
void tailscaleStatus(remote.run, config.port)
  .then((s) => {
    if (s.httpsUrl) remote.origins.add(s.httpsUrl)
  })
  .catch(() => {})

const auth = createAuth(db, {
  secret: config.authSecret,
  baseURL: config.baseURL,
  trustedOrigins: () => [...config.trustedOrigins, ...remote.origins],
})

const jobs = startJobs(db, config)

// HTTPS en la red local con la autoridad propia (la cámara en vivo y la app instalable lo exigen
// en celulares y tablets). Si algo falla, el negocio sigue por HTTP.
const network = {
  httpPort: config.port,
  httpsPort: config.httpsPort,
  catalogPort: config.catalogPort,
  hosts: localHosts(lanAddresses()),
  caCert: null as string | null,
  caFingerprint: null as string | null,
}
let tls: LocalTls | null = null
if (config.httpsPort) {
  try {
    tls = ensureLocalTls(join(config.dataDir, "tls"), network.hosts, Date.now())
    network.caCert = tls.caCert
    network.caFingerprint = tls.caFingerprint
  } catch (e) {
    console.warn("[https] no se pudo preparar el certificado; sigue solo por HTTP:", e)
    network.httpsPort = null
  }
}

// Los plugins corren aislados (cada uno en su QuickJS) y llaman a la API como cualquier cliente.
const plugins = new PluginManager(db, { now: Date.now })

// En una sucursal, cada 30 s sube lo registrado y baja lo del central (sin sucursal, no hace nada).
const sync = new SyncClient(db)

const deps = {
  db,
  plugins,
  sync,
  auth,
  now: Date.now,
  afterSetup: () => void jobs.refreshRates(),
  // Respaldo en cada cierre de turno (PLAN §10): fuera de la petición, sin hacer esperar a la caja.
  onShiftClosed: () =>
    setTimeout(() => {
      try {
        const file = backupDatabase(db, join(config.dataDir, "backups"), "shift-close", Date.now())
        rotateBackups(join(config.dataDir, "backups"), config.backupsKeep)
        console.info(`[turno] respaldo: ${file}`)
      } catch (e) {
        console.error("[turno] respaldo falló:", e)
      }
    }, 0),
  trustProxy: config.trustProxy,
  backups: { dataDir: config.dataDir, keep: config.backupsKeep },
  network,
  remote,
  ...(config.webRoot ? { webRoot: config.webRoot } : {}),
}
const app = createApp(deps)
plugins.setApp((req) => app.fetch(req))

const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: app.fetch })
let secure: ReturnType<typeof Bun.serve> | null = null
if (tls && network.httpsPort) {
  try {
    secure = Bun.serve({
      port: network.httpsPort,
      hostname: "0.0.0.0",
      tls: { cert: tls.cert, key: tls.key },
      fetch: app.fetch,
    })
  } catch (e) {
    console.warn(`[https] no se pudo abrir el puerto ${network.httpsPort}; sigue solo por HTTP:`, e)
    network.httpsPort = null
  }
}
// El catálogo en línea en su propio puerto: lo único que se publica en internet (con Tailscale
// Funnel o Cloudflare Tunnel), sin la entrada ni la API con sesión. Si el puerto está ocupado, el
// negocio sigue igual.
let storefront: ReturnType<typeof Bun.serve> | null = null
if (network.catalogPort) {
  try {
    storefront = Bun.serve({
      port: network.catalogPort,
      hostname: "0.0.0.0",
      fetch: createStorefrontApp(deps).fetch,
    })
  } catch (e) {
    console.warn(`[catálogo] no se pudo abrir el puerto ${network.catalogPort}:`, e)
    network.catalogPort = null
  }
}
sync.start()
void plugins
  .start()
  .then(() => plugins.startTimers())
  .catch((e) => console.error("[plugins] no arrancaron:", e))
console.info(`Millhiore WINK POS escuchando en ${server.url} · datos en ${config.dataDir}`)
console.info(`  En esta PC:        http://localhost:${config.port}`)
for (const address of lanAddresses()) {
  console.info(`  Desde la red local: http://${address}:${config.port}`)
  if (secure) console.info(`  Con HTTPS:         https://${address}:${secure.port}`)
}
if (secure) {
  console.info("  (HTTPS pide instalar una vez la autoridad local: Ajustes → Equipos)")
}
if (storefront) console.info(`  Catálogo en línea:  puerto ${storefront.port}`)
if (!config.webRoot) {
  console.info("[web] sin la aplicación compilada: solo API (compila con `bun run build`)")
}
// Antes de 1.4.4, Bun tiene fallos de seguridad (descompresión Brotli al traer la tasa, certificados
// raíz comprometidos): se avisa, sin impedir que el negocio abra.
if (Bun.semver.order(Bun.version, "1.4.4") < 0) {
  console.warn(
    `[seguridad] Bun ${Bun.version} tiene fallos corregidos en 1.4.4: ejecuta \`bun upgrade\``,
  )
}

/** IPv4 privadas de la PC (192.168.x.x, 10.x.x.x, 172.16–31.x.x): por donde entran celulares y tablets. */
function lanAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/vpn|wireguard|proton|tunnel|\btun|\btap/i.test(name)) // no son la red local
    .flatMap(([, list]) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal)
    .map((i) => i.address)
    .filter((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a))
}

function shutdown() {
  jobs.stop()
  sync.stop()
  plugins.stop()
  void server.stop()
  void secure?.stop()
  void storefront?.stop()
  db.$client.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
