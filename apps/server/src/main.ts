import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { createApp } from "./app"
import { createAuth } from "./infra/auth"
import { backupDatabase, rotateBackups } from "./infra/backups"
import { loadConfig } from "./infra/config"
import { openDatabase } from "./infra/database"
import { startJobs } from "./jobs"

// Recuperar el acceso desde la PC del servidor: `millhiore-server reset-password <usuario>`.
if (process.argv[2] === "reset-password") {
  const { resetPasswordCli } = await import("./cli/reset-password")
  process.exit(await resetPasswordCli(process.argv.slice(3)))
}

const config = loadConfig()
// Aplica una restauración pendiente (Ajustes → Respaldos), respalda antes de migrar y migra.
const db = openDatabase(config.dataDir, { applyRestore: true })

const auth = createAuth(db, {
  secret: config.authSecret,
  baseURL: config.baseURL,
  trustedOrigins: config.trustedOrigins,
})

const jobs = startJobs(db, config)
const app = createApp({
  db,
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
  ...(config.webRoot ? { webRoot: config.webRoot } : {}),
})

const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: app.fetch })
console.info(`Millhiore WINK POS escuchando en ${server.url} · datos en ${config.dataDir}`)
console.info(`  En esta PC:        http://localhost:${config.port}`)
for (const address of lanAddresses()) {
  console.info(`  Desde la red local: http://${address}:${config.port}`)
}
if (!config.webRoot) {
  console.info("[web] sin la aplicación compilada: solo API (compila con `bun run build`)")
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
  void server.stop()
  db.$client.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
