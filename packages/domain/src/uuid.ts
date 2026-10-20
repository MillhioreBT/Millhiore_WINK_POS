/**
 * UUIDv7 (RFC 9562): 48 bits de milisegundos Unix + aleatorio. Ordenable por tiempo y generable
 * en el cliente (navegador, Tauri o servidor), lo que da idempotencia y modo offline.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // 48 bits de tiempo, big-endian. Se usa aritmética (no >>) porque supera los 32 bits.
  let t = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256
    t = Math.floor(t / 256)
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70 // versión 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80 // variante RFC 4122
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidv7(value: string): boolean {
  return UUID_RE.test(value)
}
