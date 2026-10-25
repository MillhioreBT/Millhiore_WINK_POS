import { parseScaleReading, type ScaleReading } from "@millhiore/domain"

// Balanza conectada por el puerto serie (o un adaptador USB-serie) del equipo de la caja, con Web
// Serial: Chrome, Edge y Opera en la PC, por HTTPS o en la PC del servidor (localhost). Cada equipo
// recuerda su balanza; el navegador pide permiso la primera vez.

interface SerialPortLike {
  open(options: {
    baudRate: number
    dataBits?: number
    parity?: "none" | "even" | "odd"
    stopBits?: number
  }): Promise<void>
  close(): Promise<void>
  forget?: () => Promise<void>
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>
  getPorts(): Promise<SerialPortLike[]>
}

const serial = (): SerialLike | undefined =>
  typeof navigator === "undefined"
    ? undefined
    : (navigator as unknown as { serial?: SerialLike }).serial

/** El navegador puede hablar con una balanza (Web Serial en un contexto seguro). */
export function scaleSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && serial() !== undefined
}

/** Cómo pedirle el peso: algunas lo mandan solas todo el tiempo; otras esperan una orden. */
export const SCALE_COMMANDS = {
  none: { label: "La balanza manda el peso sola", bytes: null },
  W: { label: "Pedirlo con «W» (Toledo, Torrey y compatibles)", bytes: "W\r" },
  P: { label: "Pedirlo con «P»", bytes: "P\r" },
  ENQ: { label: "Pedirlo con ENQ (Dibal, Systel y compatibles)", bytes: "\u0005" },
} as const
export type ScaleCommand = keyof typeof SCALE_COMMANDS

/** La balanza de este equipo: velocidad, formato de los datos y cómo se le pide el peso. */
export interface ScaleDevice {
  baudRate: number
  dataBits: 7 | 8
  parity: "none" | "even" | "odd"
  command: ScaleCommand
}

export const DEFAULT_SCALE_DEVICE: ScaleDevice = {
  baudRate: 9600,
  dataBits: 8,
  parity: "none",
  command: "none",
}

const KEY = "millhiore.scale-device"

/** La balanza que se configuró en este equipo; null si no tiene. */
export function loadScaleDevice(): ScaleDevice | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULT_SCALE_DEVICE, ...(JSON.parse(raw) as Partial<ScaleDevice>) } : null
  } catch {
    return null
  }
}

export function saveScaleDevice(device: ScaleDevice | null): void {
  try {
    if (device) localStorage.setItem(KEY, JSON.stringify(device))
    else localStorage.removeItem(KEY)
  } catch {
    // Sin almacenamiento (ventana privada): la balanza se elige cada vez.
  }
}

/** Pide al navegador elegir el puerto de la balanza (hace falta un toque o un clic). */
export async function pairScale(): Promise<void> {
  const s = serial()
  if (!s) throw new Error("Este navegador no se conecta a balanzas: usa Chrome o Edge en la PC")
  await s.requestPort()
}

/** Olvida el permiso del puerto (para elegir otro). */
export async function forgetScale(): Promise<void> {
  const ports = (await serial()?.getPorts()) ?? []
  await Promise.all(ports.map((p) => p.forget?.()))
}

/** Ya hay un puerto con permiso en este equipo. */
export async function scalePaired(): Promise<boolean> {
  return ((await serial()?.getPorts())?.length ?? 0) > 0
}

const wait = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))

/**
 * Lee el peso: abre el puerto, le pide el peso si hace falta y espera una lectura estable (hasta
 * `timeoutMs`). Devuelve también lo que llegó tal cual, para ver qué manda una balanza nueva.
 */
export async function readScale(
  device: ScaleDevice,
  timeoutMs = 1500,
): Promise<{ reading: ScaleReading | null; raw: string }> {
  const s = serial()
  if (!s) throw new Error("Este navegador no se conecta a balanzas: usa Chrome o Edge en la PC")
  const [port] = await s.getPorts()
  if (!port) throw new Error("Conecta la balanza en Ajustes → Balanza")
  await port.open({
    baudRate: device.baudRate,
    dataBits: device.dataBits,
    parity: device.parity,
    stopBits: 1,
  })
  let raw = ""
  let stable: ScaleReading | null = null
  try {
    const bytes = SCALE_COMMANDS[device.command].bytes
    if (bytes && port.writable) {
      const writer = port.writable.getWriter()
      await writer.write(new TextEncoder().encode(bytes))
      writer.releaseLock()
    }
    const reader = port.readable?.getReader()
    if (!reader) throw new Error("La balanza no responde")
    const decoder = new TextDecoder()
    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), wait(deadline - Date.now())])
        if (!chunk || chunk.done) break
        raw += decoder.decode(chunk.value, { stream: true })
        // Solo cuenta lo que ya terminó de llegar (hasta el último fin de línea o de trama).
        const end = Math.max(
          raw.lastIndexOf("\n"),
          raw.lastIndexOf("\r"),
          raw.lastIndexOf(String.fromCharCode(3)),
        )
        const reading = end >= 0 ? parseScaleReading(raw.slice(0, end + 1)) : null
        if (reading?.stable) {
          stable = reading
          break
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } finally {
    await port.close().catch(() => {})
  }
  return { reading: stable ?? parseScaleReading(raw), raw }
}
