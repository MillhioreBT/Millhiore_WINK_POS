import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  createPairingSchema,
  joinCentralSchema,
  joinResultSchema,
  pairingCodeSchema,
  type SyncStatus,
  syncStatusSchema,
} from "@millhiore/contracts"
import type { Db } from "@millhiore/db"
import type { Context } from "hono"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { clientKey, RateLimiter } from "../../http/rateLimit"
import { tailscaleStatus } from "../remote/tailscale"
import {
  buildInbox,
  createPairingCode,
  listPeers,
  type PeerRow,
  type PushBatch,
  pairPeer,
  peerByToken,
  prunePairings,
  receivePush,
  unpairPeer,
} from "./central"
import { joinCentral, SyncClient } from "./client"
import { branchPlaces } from "./documents"
import { readLink } from "./link"
import { buildMasterSnapshot } from "./master"
import { placeholders, selectRows } from "./raw"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ content: { "application/json": { schema } } })

const statusRoute = createRoute({
  method: "get",
  path: "/api/sync/status",
  tags: ["Sucursales"],
  summary: "Si este servidor es central, sucursal o ninguno, y cómo va la sincronización",
  responses: {
    200: { description: "Estado", ...json(syncStatusSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const codeRoute = createRoute({
  method: "post",
  path: "/api/sync/codes",
  tags: ["Sucursales"],
  summary: "Un código para unir el servidor de una sucursal (vale una hora y una vez)",
  request: { body: { ...json(createPairingSchema), required: true } },
  responses: {
    201: { description: "Código", ...json(pairingCodeSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe la sucursal", ...err },
    409: { description: "Tiene turnos abiertos, o esta PC es una sucursal", ...err },
    422: { description: "Es la sucursal principal", ...err },
  },
})

const unpairRoute = createRoute({
  method: "delete",
  path: "/api/sync/peers/{branchId}",
  tags: ["Sucursales"],
  summary: "Deja de recibir al servidor de una sucursal (lo ya recibido queda)",
  request: { params: z.object({ branchId: z.string() }) },
  responses: {
    204: { description: "Quitado" },
    403: { description: "Falta settings.manage", ...err },
  },
})

const runRoute = createRoute({
  method: "post",
  path: "/api/sync/run",
  tags: ["Sucursales"],
  summary: "En una sucursal: sincroniza ahora con el central",
  request: {
    query: z.object({
      /** Vuelve a subir todo (si el central restauró un respaldo anterior). */
      resend: z.enum(["1"]).optional(),
    }),
  },
  responses: {
    200: { description: "Estado después de sincronizar", ...json(syncStatusSchema) },
    403: { description: "Falta settings.manage", ...err },
    409: { description: "Esta PC no es una sucursal", ...err },
  },
})

const joinRoute = createRoute({
  method: "post",
  path: "/api/setup/join",
  tags: ["Configuración"],
  summary: "Une esta instalación nueva como sucursal de un central",
  description:
    "Con la dirección del central y el código que muestra (Ajustes → Sucursales). Solo funciona sobre una instalación vacía; después se entra con los usuarios del central.",
  request: { body: { ...json(joinCentralSchema), required: true } },
  responses: {
    201: { description: "Unida", ...json(joinResultSchema) },
    409: { description: "Ya estaba configurada, o versiones distintas", ...err },
    422: { description: "Código inválido o vencido", ...err },
    502: { description: "No se pudo llegar al central", ...err },
  },
})

const pairBodySchema = z.object({
  code: z.string().max(40),
  name: z.string().max(60).default(""),
  schema: z.number().int(),
})

export function syncStatus(db: Db): SyncStatus {
  const link = readLink(db)
  const peers = listPeers(db)
  if (!link) return { role: peers.length ? "central" : "standalone", central: null, peers }
  const { terminals } = branchPlaces(db, link.branchId)
  const pending = selectRows(
    db,
    `select count(*) as n from document where rowid > ? and terminal_id in (${placeholders(terminals.length)})
       and id not in (select document_id from sync_received)`,
    link.cursors.documents,
    ...terminals,
  )[0]
  return {
    role: "satellite",
    central: {
      url: link.centralUrl,
      branchId: link.branchId,
      branchName: link.branchName,
      pairedAt: link.joinedAt,
      lastSyncAt: link.lastSyncAt,
      lastMasterAt: link.lastMasterAt,
      pendingDocuments: Number(pending?.n ?? 0),
      lastError: link.lastError,
      lastErrorAt: link.lastErrorAt,
    },
    peers,
  }
}

/** Por dónde llegan las sucursales a este servidor: primero Tailscale, después la red local. */
async function centralUrls(deps: AppDeps): Promise<string[]> {
  const port = deps.network?.httpPort ?? 3000
  const urls: string[] = []
  try {
    const ts = await tailscaleStatus(deps.remote?.run ?? null, port)
    if (ts.httpsUrl) urls.push(ts.httpsUrl)
    if (ts.httpUrl) urls.push(ts.httpUrl)
  } catch {
    // sin Tailscale
  }
  for (const host of deps.network?.hosts ?? []) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.startsWith("127.")) {
      urls.push(`http://${host}:${port}`)
    }
  }
  return [...new Set(urls)]
}

/** Lo que el servidor de una sucursal pide con su clave. */
function requirePeer(c: Context, db: Db, now: number): PeerRow {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1]
  const peer = bearer ? peerByToken(db, bearer, now) : null
  if (!peer) {
    throw new HttpError(
      401,
      "SYNC_UNPAIRED",
      "El central ya no reconoce esta sucursal: vuelve a unirla",
    )
  }
  return peer
}

/** Las que corren sin sesión: el emparejamiento, lo que piden las sucursales y unirse. */
export function registerPublicSyncRoutes(app: App, deps: AppDeps): void {
  const client = () => deps.sync ?? new SyncClient(deps.db, { now: deps.now })
  // Un código tiene 12 caracteres de 32: adivinarlo es imposible, pero igual se frena a quien lo intente.
  const pairs = new RateLimiter(10, 10 * 60_000)

  app.post("/api/sync/pair", async (c) => {
    if (!pairs.allow(clientKey(c), deps.now())) {
      throw new HttpError(429, "TOO_MANY", "Demasiados intentos: espera unos minutos")
    }
    const parsed = pairBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new HttpError(422, "VALIDATION", "Datos inválidos")
    if (readLink(deps.db)) {
      throw new HttpError(409, "IS_SATELLITE", "Ese servidor es una sucursal, no el central")
    }
    const now = deps.now()
    prunePairings(deps.db, now)
    const { code, name, schema } = parsed.data
    return c.json(pairPeer(deps.db, code, name, schema, now), 200)
  })

  app.get("/api/sync/master", (c) => {
    requirePeer(c, deps.db, deps.now())
    const snapshot = buildMasterSnapshot(deps.db, deps.now())
    const etag = `"${snapshot.version}"`
    if (c.req.header("if-none-match") === etag) return c.body(null, 304)
    return c.json(snapshot, 200, { etag })
  })

  app.post("/api/sync/push", async (c) => {
    const now = deps.now()
    const peer = requirePeer(c, deps.db, now)
    const batch = (await c.req.json().catch(() => null)) as PushBatch | null
    if (!batch || !Array.isArray(batch.documents) || !Array.isArray(batch.shifts)) {
      throw new HttpError(422, "VALIDATION", "Envío inválido")
    }
    const normalized: PushBatch = {
      schema: Number(batch.schema),
      documents: batch.documents,
      shifts: batch.shifts,
      contacts: Array.isArray(batch.contacts) ? batch.contacts : [],
      audit: Array.isArray(batch.audit) ? batch.audit : [],
      events: Array.isArray(batch.events) ? batch.events : [],
      invoices: Array.isArray(batch.invoices) ? batch.invoices : [],
    }
    return c.json(receivePush(deps.db, peer, normalized, now), 200)
  })

  app.get("/api/sync/inbox", (c) => {
    const peer = requirePeer(c, deps.db, deps.now())
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0)
    return c.json(buildInbox(deps.db, peer, after), 200)
  })

  app.openapi(joinRoute, async (c) => {
    const sync = client()
    const result = await joinCentral(deps.db, c.req.valid("json"), sync.fetcher, deps.now())
    // Baja enseguida su historia y los traslados (no espera a la próxima vuelta).
    void sync.run()
    return c.json(result, 201)
  })
}

export function registerSyncRoutes(app: App, deps: AppDeps): void {
  app.openapi(statusRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(syncStatus(deps.db), 200)
  })

  app.openapi(codeRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    if (readLink(deps.db)) {
      throw new HttpError(
        409,
        "IS_SATELLITE",
        "Esta PC es una sucursal: los códigos se crean en el central",
      )
    }
    const { branchId } = c.req.valid("json")
    const { code, expiresAt } = createPairingCode(deps.db, branchId, actor.userId, deps.now())
    return c.json({ code, branchId, expiresAt, urls: await centralUrls(deps) }, 201)
  })

  app.openapi(unpairRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    unpairPeer(deps.db, c.req.valid("param").branchId, actor.userId, deps.now())
    return c.body(null, 204)
  })

  app.openapi(runRoute, async (c) => {
    requirePermission(c, "settings.manage")
    if (!readLink(deps.db)) throw new HttpError(409, "NOT_SATELLITE", "Esta PC no es una sucursal")
    const sync = deps.sync ?? new SyncClient(deps.db, { now: deps.now })
    if (c.req.valid("query").resend) await sync.resendAll()
    else await sync.run()
    return c.json(syncStatus(deps.db), 200)
  })
}
