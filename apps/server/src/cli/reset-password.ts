// Recuperar el acceso cuando nadie recuerda la contraseña (p. ej. el único dueño). Se ejecuta en
// la PC del servidor: quien tiene esa PC ya tiene la base de datos, así que no abre ningún hueco
// nuevo. Genera una contraseña temporal, cierra las sesiones y obliga a elegir una nueva.
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { auditLog, role, user } from "@millhiore/db"
import { temporaryPassword, uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { openDatabase } from "../infra/database"
import { setPassword } from "../modules/users/service"

/** Dónde buscar los datos, en orden: --data, DATA_DIR, ./data y la app de escritorio. */
export function dataDirCandidates(args: string[], env = process.env): string[] {
  const flag = args.indexOf("--data")
  const explicit = flag >= 0 ? args[flag + 1] : undefined
  if (explicit) return [resolve(explicit)]
  if (env.DATA_DIR) return [resolve(env.DATA_DIR)]
  const desktop = env.APPDATA ? [join(env.APPDATA, "com.millhiore.wink", "data")] : []
  return [resolve("data"), ...desktop]
}

export async function resetPasswordCli(args: string[], env = process.env): Promise<number> {
  const candidates = dataDirCandidates(args, env)
  const dataDir = candidates.find((d) => existsSync(join(d, "millhiore.db")))
  if (!dataDir) {
    console.error(`No encontré la base de datos. Busqué en:\n  ${candidates.join("\n  ")}`)
    console.error("Indica la carpeta de datos con --data <carpeta>.")
    return 1
  }
  const db = openDatabase(dataDir, { applyRestore: false })
  const username = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--data")

  const users = db
    .select({
      id: user.id,
      username: user.username,
      name: user.name,
      active: user.active,
      role: role.name,
    })
    .from(user)
    .leftJoin(role, eq(role.id, user.roleId))
    .all()

  if (!username) {
    console.info(`Datos: ${dataDir}\n\nUsuarios:`)
    for (const u of users) {
      console.info(
        `  ${u.username ?? "?"}  ·  ${u.name}  ·  ${u.role ?? "sin rol"}${u.active ? "" : "  (inactivo)"}`,
      )
    }
    console.info("\nUso: reset-password <usuario> [--data <carpeta>]")
    return 0
  }

  const target = users.find((u) => u.username === username.toLowerCase())
  if (!target) {
    console.error(`No existe el usuario «${username}». Ejecuta sin usuario para ver la lista.`)
    return 1
  }
  const temporary = temporaryPassword()
  await setPassword(db, target.id, temporary, { mustChange: true, signOut: "all" })
  if (!target.active) db.update(user).set({ active: true }).where(eq(user.id, target.id)).run()
  const now = Date.now()
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId: null,
      action: "user.password.reset.console",
      entityType: "user",
      entityId: target.id,
      data: { reactivated: !target.active },
    })
    .run()
  db.$client.close()

  console.info(`\nContraseña temporal para «${target.username}» (${target.name}):\n`)
  console.info(`    ${temporary}\n`)
  console.info("Entra con ella: el sistema pedirá elegir una nueva antes de seguir.")
  console.info("Se cerraron todas las sesiones de ese usuario.")
  if (!target.active) console.info("El usuario estaba inactivo y se reactivó.")
  return 0
}
