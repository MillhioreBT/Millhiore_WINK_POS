import { join } from "node:path"
import type { Db } from "@millhiore/db"
import { localDate } from "@millhiore/domain"
import { Cron } from "croner"
import { drainOutbox } from "../events/outbox"
import { backupDatabase, integrityCheck, lastBackupAt, rotateBackups } from "../infra/backups"
import type { Config } from "../infra/config"
import { refreshRates } from "../modules/rates/service"
import { generateDueRecurring } from "../modules/recurring/service"
import { readLink } from "../modules/sync/link"
import { enqueueDaily, sendDueTelegram } from "../modules/telegram/service"
import { deliverDue } from "../modules/webhooks/service"

const TIMEZONE = "America/Caracas"

export interface JobsHandle {
  stop(): void
  /** Consulta las tasas oficiales ahora mismo (sin esperar al próximo ciclo). */
  refreshRates(): Promise<void>
}

/**
 * Tareas en segundo plano del servidor:
 * - tasa oficial: al arrancar y cada 2 horas (el BCV publica la del día siguiente por la tarde;
 *   una sucursal no la consulta: le llega del central);
 * - respaldo diario con rotación: a los 30 s de arrancar y cada hora, si hoy aún no se hizo;
 * - gastos recurrentes automáticos que ya vencieron: a los 45 s de arrancar y cada hora;
 * - avisos de los webhooks y alertas por Telegram (con el resumen del día a su hora): cada 5 s;
 * - verificación de integridad los domingos a las 4:00.
 * Un fallo en una tarea se registra y no afecta a las demás ni a las ventas.
 */
export function startJobs(db: Db, config: Config, now: () => number = Date.now): JobsHandle {
  const backupsDir = join(config.dataDir, "backups")
  const safe = (name: string, fn: () => unknown | Promise<unknown>) => async () => {
    try {
      await fn()
    } catch (e) {
      console.error(`[jobs] ${name} falló:`, e)
    }
  }

  const rates = safe("tasas", async () => {
    // Una sucursal recibe la tasa del central.
    if (readLink(db)) return
    const report = await refreshRates(db, { now: now() })
    if (!report.ok && report.error) console.warn(`[jobs] tasas: ${report.error}`)
    else if (report.recorded.length > 0) {
      console.info(
        `[jobs] tasas: ${report.recorded.map((r) => `${r.currency}=${r.value}`).join(", ")} (${report.source})`,
      )
    }
  })
  // Un respaldo diario por día local, en cuanto la PC esté encendida: en una bodega la PC suele
  // apagarse de noche, así que no basta con una hora fija.
  const backup = safe("respaldo", () => {
    const last = lastBackupAt(backupsDir, "daily")
    if (last !== null && localDate(last, TIMEZONE) === localDate(now(), TIMEZONE)) return
    const file = backupDatabase(db, backupsDir, "daily", now())
    const removed = rotateBackups(backupsDir, config.backupsKeep)
    console.info(`[jobs] respaldo: ${file}${removed.length ? ` (rotados: ${removed.length})` : ""}`)
  })
  // Los recurrentes automáticos generan su gasto a deber en cuanto vencen (aunque la PC haya
  // estado apagada: se ponen al día, un gasto por periodo atrasado).
  const recurring = safe("recurrentes", () => {
    const report = generateDueRecurring(db, now())
    if (report.generated || report.failed) {
      console.info(
        `[jobs] recurrentes: ${report.generated} gasto(s) generado(s)${report.failed ? `, ${report.failed} sin poder generar` : ""}`,
      )
    }
  })
  const integrity = safe("integridad", () => {
    const result = integrityCheck(db)
    if (result !== "ok") console.error(`[jobs] INTEGRIDAD DE LA BASE: ${result}`)
  })

  // Avisos: cada 5 s se reparten los eventos nuevos y se mandan los webhooks y las alertas de
  // Telegram que ya tocan (también el resumen del día, a su hora). Una vuelta no empieza mientras
  // la anterior espera a un sistema lento.
  let sending = false
  const notify = safe("avisos", async () => {
    if (sending) return
    sending = true
    try {
      drainOutbox(db, now())
      enqueueDaily(db, now())
      const hooks = await deliverDue(db, now())
      if (hooks.failed) console.warn(`[jobs] webhooks: ${hooks.failed} aviso(s) dados por fallidos`)
      const alerts = await sendDueTelegram(db, now())
      if (alerts.failed) console.warn(`[jobs] telegram: ${alerts.failed} alerta(s) sin enviar`)
    } finally {
      sending = false
    }
  })
  const notifyTimer = setInterval(() => void notify(), 5_000)

  const options = { timezone: TIMEZONE, protect: true }
  const crons = [
    new Cron("0 */2 * * *", options, rates),
    new Cron("15 * * * *", options, backup),
    new Cron("30 * * * *", options, recurring),
    new Cron("0 4 * * 0", options, integrity),
  ]
  void rates() // primera consulta al arrancar, sin bloquear el servidor
  const firstBackup = setTimeout(() => void backup(), 30_000)
  const firstRecurring = setTimeout(() => void recurring(), 45_000)

  return {
    stop: () => {
      clearInterval(notifyTimer)
      clearTimeout(firstBackup)
      clearTimeout(firstRecurring)
      for (const c of crons) c.stop()
    },
    refreshRates: rates,
  }
}
