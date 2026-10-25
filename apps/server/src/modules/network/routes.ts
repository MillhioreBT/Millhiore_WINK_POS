import { createRoute } from "@hono/zod-openapi"
import { apiErrorSchema, type NetworkInfo, networkInfoSchema } from "@millhiore/contracts"
import { actorOf } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"

const err = { content: { "application/json": { schema: apiErrorSchema } } }

/** Los hosts que sirven desde otro equipo (no localhost ni 127.0.0.1). */
export const reachable = (hosts: readonly string[]) =>
  hosts.filter((h) => h !== "localhost" && !h.startsWith("127."))

export function networkInfo(deps: AppDeps): NetworkInfo {
  const n = deps.network
  if (!n) return { httpUrls: [], httpsUrls: [], caUrls: [], caFingerprint: null }
  const hosts = reachable(n.hosts)
  return {
    httpUrls: hosts.map((h) => `http://${h}:${n.httpPort}`),
    httpsUrls: n.httpsPort && n.caCert ? hosts.map((h) => `https://${h}:${n.httpsPort}`) : [],
    caUrls: n.caCert ? hosts.map((h) => `http://${h}:${n.httpPort}/api/network/ca.crt`) : [],
    caFingerprint: n.caCert ? n.caFingerprint : null,
  }
}

const infoRoute = createRoute({
  method: "get",
  path: "/api/network",
  tags: ["Equipos"],
  summary: "Cómo abrir la app desde otro equipo de la red local (con y sin HTTPS)",
  responses: {
    200: {
      description: "Direcciones",
      content: { "application/json": { schema: networkInfoSchema } },
    },
  },
})

const caRoute = createRoute({
  method: "get",
  path: "/api/network/ca.crt",
  tags: ["Equipos"],
  summary: "El certificado de la autoridad local, para instalarlo en un celular o una tablet",
  description: "Público: un certificado de autoridad no tiene nada secreto (su clave nunca sale).",
  responses: {
    200: {
      description: "Certificado (DER)",
      content: { "application/x-x509-ca-cert": { schema: {} } },
    },
    404: { description: "HTTPS está apagado", ...err },
  },
})

export function registerNetworkRoutes(app: App, deps: AppDeps): void {
  app.openapi(infoRoute, (c) => {
    actorOf(c)
    return c.json(networkInfo(deps), 200)
  })

  app.openapi(caRoute, (c) => {
    const pem = deps.network?.caCert
    if (!pem) throw new HttpError(404, "NOT_FOUND", "HTTPS está apagado en este servidor")
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64")
    return c.body(der, 200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="millhiore-ca.crt"',
      "cache-control": "no-cache",
    })
  })
}
