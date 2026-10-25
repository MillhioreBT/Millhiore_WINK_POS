import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PrintBillBody, PrinterSettings } from "@millhiore/contracts"
import { account, business, type Db, paymentMethod } from "@millhiore/db"
import {
  billLines,
  COLUMNS,
  EscPos,
  receiptLines,
  testPageLines,
  toEscPos,
} from "@millhiore/printing"
import { eq, inArray } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { getDocument } from "../documents/service"
import { businessProfile, type Patch, readSetting, writeSetting } from "../settings/service"

const KEY = "printing.printer"

export const DEFAULT_PRINTER: PrinterSettings = {
  mode: "browser",
  host: null,
  port: 9100,
  share: null,
  device: null,
  paperWidth: 80,
  autoPrint: false,
  openDrawer: false,
}

export function printerSettings(db: Db): PrinterSettings {
  return { ...DEFAULT_PRINTER, ...(readSetting<Partial<PrinterSettings>>(db, KEY) ?? {}) }
}

/** La configuración con los cambios aplicados (lo que venga como undefined no se toca). */
export function withPatch(base: PrinterSettings, patch: Patch<PrinterSettings>): PrinterSettings {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  return { ...base, ...defined }
}

export function savePrinterSettings(db: Db, patch: Patch<PrinterSettings>): PrinterSettings {
  const next = withPatch(printerSettings(db), patch)
  requireTarget(next)
  writeSetting(db, KEY, next)
  return next
}

/** Cada modo necesita su dato: la IP, el nombre compartido o el dispositivo. */
function requireTarget(p: PrinterSettings): void {
  const missing =
    p.mode === "network" && !p.host
      ? "Escribe la IP de la impresora"
      : p.mode === "windows" && !p.share
        ? "Escribe el nombre con que compartiste la impresora en Windows"
        : p.mode === "device" && !p.device
          ? "Escribe el dispositivo de la impresora, p. ej. /dev/usb/lp0"
          : null
  if (missing) throw new HttpError(422, "PRINTER_TARGET", missing)
}

/** Envía bytes a una impresora de red (RAW, normalmente puerto 9100). */
export function sendTcp(host: string, port: number, bytes: Uint8Array, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    let pending = bytes
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(
      () => finish(new Error(`La impresora ${host}:${port} no respondió`)),
      timeoutMs,
    )
    const flush = (socket: { write(b: Uint8Array): number; end(): void }) => {
      const written = socket.write(pending)
      pending = pending.subarray(Math.max(0, written))
      if (pending.length === 0) socket.end()
    }
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open: flush,
        drain: flush,
        data() {},
        close: () =>
          finish(pending.length ? new Error("La impresora cortó la conexión") : undefined),
        error: (_s, e) => finish(e),
        connectError: (_s, e) =>
          finish(new Error(`No se pudo conectar con la impresora ${host}:${port} (${e.message})`)),
      },
    }).catch((e: Error) => finish(e))
  })
}

/**
 * Impresora USB compartida en Windows: `copy /b archivo \\equipo\recurso` manda los bytes tal
 * cual (RAW) al administrador de impresión, como hacen los sistemas de caja de toda la vida.
 */
async function sendWindowsShare(host: string, share: string, bytes: Uint8Array) {
  if (process.platform !== "win32") {
    throw new HttpError(
      409,
      "NOT_WINDOWS",
      "Ese modo solo funciona si el servidor corre en Windows",
    )
  }
  const dir = mkdtempSync(join(tmpdir(), "millhiore-print-"))
  const file = join(dir, "recibo.bin")
  try {
    writeFileSync(file, bytes)
    const proc = Bun.spawn(["cmd", "/c", "copy", "/b", file, `\\\\${host}\\${share}`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (code !== 0) {
      throw new Error(
        `Windows no pudo imprimir en \\\\${host}\\${share}: ${(err || out).trim() || `código ${code}`}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function sendToPrinter(p: PrinterSettings, bytes: Uint8Array): Promise<void> {
  requireTarget(p)
  try {
    if (p.mode === "network") await sendTcp(p.host ?? "", p.port, bytes)
    else if (p.mode === "windows")
      await sendWindowsShare(p.host || "localhost", p.share ?? "", bytes)
    else if (p.mode === "device") writeFileSync(p.device ?? "", bytes)
    else {
      throw new HttpError(
        409,
        "BROWSER_PRINTING",
        "La impresora está configurada para imprimir desde el navegador",
      )
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(502, "PRINTER_ERROR", (e as Error).message)
  }
}

/** ¿Algún pago del documento fue en efectivo? (para abrir la gaveta). */
function hasCash(db: Db, methodIds: string[]): boolean {
  if (!methodIds.length) return false
  return db
    .select({ kind: account.kind })
    .from(paymentMethod)
    .innerJoin(account, eq(account.id, paymentMethod.accountId))
    .where(inArray(paymentMethod.id, methodIds))
    .all()
    .some((m) => m.kind === "cash")
}

/** Imprime el recibo de un documento; con `openDrawer` abre la gaveta si hubo efectivo. */
export async function printDocument(db: Db, id: string, opts: { openDrawer: boolean }) {
  const p = printerSettings(db)
  const doc = getDocument(db, id)
  const header = { ...businessProfile(db), timezone: timezoneOf(db) }
  const drawer =
    opts.openDrawer &&
    p.openDrawer &&
    doc.type === "SALE" &&
    hasCash(
      db,
      doc.payments.map((x) => x.paymentMethodId),
    )
  const bytes = toEscPos(receiptLines(doc, header, COLUMNS[p.paperWidth]), { openDrawer: drawer })
  await sendToPrinter(p, bytes)
  return { drawerOpened: drawer }
}

/** Imprime una precuenta en la térmica. */
export async function printBill(db: Db, bill: PrintBillBody) {
  const p = printerSettings(db)
  const header = { ...businessProfile(db), timezone: timezoneOf(db) }
  await sendToPrinter(p, toEscPos(billLines(bill, header, COLUMNS[p.paperWidth])))
}

export async function printTestPage(db: Db, p: PrinterSettings, now: number) {
  const header = { ...businessProfile(db), timezone: timezoneOf(db) }
  await sendToPrinter(p, toEscPos(testPageLines(header, COLUMNS[p.paperWidth], now)))
}

/** Abre la gaveta sin imprimir (para dar cambio o hacer un retiro). */
export async function kickDrawer(db: Db) {
  await sendToPrinter(printerSettings(db), new EscPos().openDrawer().encode())
}

function timezoneOf(db: Db): string {
  return db.select({ tz: business.timezone }).from(business).get()?.tz ?? "America/Caracas"
}
