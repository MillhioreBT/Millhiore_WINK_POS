import type { Context } from "hono"
import { getConnInfo } from "hono/bun"

/**
 * Cuántas peticiones deja hacer cada cliente por ventana de tiempo (ventana fija, en memoria). Es
 * para lo público (el catálogo en línea): que un curioso o un robot no tumbe la caja.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number): boolean {
    const hit = this.hits.get(key)
    if (!hit || now - hit.start >= this.windowMs) {
      // Se limpian las ventanas vencidas de vez en cuando, para no crecer sin fin.
      if (this.hits.size > 10_000) {
        for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k)
      }
      this.hits.set(key, { start: now, count: 1 })
      return true
    }
    hit.count++
    return hit.count <= this.limit
  }
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/

/**
 * De dónde viene la petición: la IP del socket o, si llega por un túnel que corre en esta misma PC
 * (Tailscale Funnel, Cloudflare Tunnel: se conectan desde 127.0.0.1), la que dice el túnel. Desde
 * otra máquina, la cabecera no se cree (cualquiera podría escribirla).
 */
export function clientKey(c: Context): string {
  let address: string | undefined
  try {
    address = getConnInfo(c).remote.address
  } catch {
    // sin servidor Bun (pruebas): no hay socket que leer
  }
  if (!address || LOOPBACK.test(address)) {
    const forwarded =
      c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded) return forwarded
  }
  return address ?? "local"
}
