import { statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { PostingError } from "@millhiore/domain"
import { Scalar } from "@scalar/hono-api-reference"
import { APIError } from "better-auth/api"
import type { Context } from "hono"
import { getConnInfo } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { type AppEnv, resolveActor } from "./http/actor"
import type { AppDeps } from "./http/context"
import { errorBody, HttpError, postingStatus, unauthorized } from "./http/errors"
import { PUBLIC_AUTH_PATHS } from "./infra/auth"
import { registerAccountRoutes } from "./modules/accounts/routes"
import { registerApiKeyRoutes } from "./modules/api-keys/routes"
import { resolveApiKeyActor } from "./modules/api-keys/service"
import { registerAuditRoutes } from "./modules/audit/routes"
import { registerBackupRoutes } from "./modules/backups/routes"
import { registerBootstrapRoutes } from "./modules/bootstrap/routes"
import { registerBranchRoutes } from "./modules/branches/routes"
import { registerCatalogRoutes } from "./modules/catalog/routes"
import { registerChargeRoutes } from "./modules/charges/routes"
import { registerContactRoutes } from "./modules/contacts/routes"
import { registerDebtRoutes } from "./modules/debts/routes"
import { registerDiningRoutes } from "./modules/dining/routes"
import { registerDiscountCodeRoutes } from "./modules/discount-codes/routes"
import { registerDocumentRoutes } from "./modules/documents/routes"
import { registerExpenseRoutes } from "./modules/expenses/routes"
import { registerFeatureRoutes } from "./modules/features/routes"
import { registerImportRoutes } from "./modules/imports/routes"
import { registerInventoryRoutes } from "./modules/inventory/routes"
import { registerKitchenRoutes } from "./modules/kitchen/routes"
import { registerLabelRoutes } from "./modules/labels/routes"
import { registerLocationRoutes } from "./modules/locations/routes"
import { registerLotRoutes } from "./modules/lots/routes"
import { registerNetworkRoutes } from "./modules/network/routes"
import { registerOrderRoutes } from "./modules/orders/routes"
import { registerPayableRoutes } from "./modules/payables/routes"
import { registerPaymentMethodRoutes } from "./modules/payment-methods/routes"
import { pluginBridgeActor, pluginTokenActor } from "./modules/plugins/actor"
import { PLUGIN_TOKEN_PREFIX } from "./modules/plugins/manager"
import { registerPluginFiles, registerPluginRoutes } from "./modules/plugins/routes"
import { registerPrintingRoutes } from "./modules/printing/routes"
import { registerQuoteRoutes } from "./modules/quotes/routes"
import { registerRateRoutes } from "./modules/rates/routes"
import { registerReceivableRoutes } from "./modules/receivables/routes"
import { registerRecurringRoutes } from "./modules/recurring/routes"
import { registerRemoteRoutes } from "./modules/remote/routes"
import { registerReportRoutes } from "./modules/reports/routes"
import { registerScaleRoutes } from "./modules/scale/routes"
import { registerSettingsRoutes } from "./modules/settings/routes"
import { registerSetupRoutes } from "./modules/setup/routes"
import { isConfigured } from "./modules/setup/service"
import { registerShiftRoutes } from "./modules/shifts/routes"
import { catalogPage } from "./modules/storefront/app"
import {
  registerPublicStorefrontRoutes,
  registerStorefrontRoutes,
} from "./modules/storefront/routes"
import { requireNotManagedByCentral } from "./modules/sync/guard"
import { registerPublicSyncRoutes, registerSyncRoutes } from "./modules/sync/routes"
import { registerTelegramRoutes } from "./modules/telegram/routes"
import { registerUserRoutes } from "./modules/users/routes"
import { registerWebhookRoutes } from "./modules/webhooks/routes"

/**
 * Better Auth limita intentos por IP y solo la lee de cabeceras. Sin proxy delante, la IP real es la
 * del socket: se escribe en `x-forwarded-for` (pisando lo que mande el cliente, que podría
 * falsearla). Con `trustProxy` (Tailscale, Cloudflare Tunnel) se respeta la cabecera del proxy.
 */
function withClientIp(c: Context, trustProxy: boolean): Request {
  if (trustProxy) return c.req.raw
  let address: string | undefined
  try {
    address = getConnInfo(c).remote.address
  } catch {
    // sin servidor Bun (pruebas): no hay socket que leer
  }
  if (!address) return c.req.raw
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-forwarded-for", address)
  return new Request(c.req.raw, { headers })
}

/**
 * Lo que es de una persona con su sesión (su contraseña, su PIN, sus sesiones) o crea accesos: una
 * clave de la API no llega aquí.
 */
const SESSION_ONLY_PREFIXES = ["/api/me", "/api/sessions", "/api/api-keys", "/api/users"]

/** Lo único permitido mientras la contraseña es temporal. */
const TEMPORARY_PASSWORD_PATHS = ["/api/me", "/api/me/password", "/api/bootstrap"]

/** Rutas que no exigen sesión. Todo lo demás bajo /api la exige. */
const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/auth/",
  "/api/setup",
  "/api/openapi.json",
  "/api/docs",
  // El certificado de la autoridad local se instala antes de entrar (no tiene nada secreto).
  "/api/network/ca.crt",
  // El catálogo en línea: lo ve cualquiera, sin costos ni cantidades.
  "/api/public/",
  // El servidor de una sucursal: con su código al emparejarse y después con su clave (`mws_…`).
  "/api/sync/pair",
  "/api/sync/master",
  "/api/sync/push",
  "/api/sync/inbox",
]

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        }))
        return c.json(errorBody("VALIDATION", "Datos inválidos", issues), 422)
      }
    },
  })

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status)
    if (err instanceof PostingError)
      return c.json(errorBody(err.code, err.message), postingStatus(err.code))
    if (err instanceof APIError) {
      const status = err.statusCode === 401 ? 401 : err.statusCode >= 500 ? 500 : 422
      return c.json(
        errorBody(String(err.body?.code ?? "AUTH_ERROR"), err.body?.message ?? err.message),
        status,
      )
    }
    if (err instanceof HTTPException)
      return c.json(errorBody("HTTP_ERROR", err.message), err.status)
    console.error(err)
    return c.json(errorBody("INTERNAL", "Error interno del servidor"), 500)
  })
  app.notFound((c) => c.json(errorBody("NOT_FOUND", "No existe"), 404))

  app.get("/api/health", (c) => c.json({ status: "ok", configured: isConfigured(deps.db) }))

  // Better Auth: solo inicio/cierre de sesión y sesión actual. El registro público, el cambio de
  // contraseña y lo demás quedan cerrados: se hacen por la API propia (reglas, permisos, auditoría).
  app.on(["GET", "POST"], ["/api/auth/*"], async (c) => {
    if (!PUBLIC_AUTH_PATHS.includes(c.req.path)) {
      return c.json(errorBody("NOT_FOUND", "No existe"), 404)
    }
    return await deps.auth.handler(withClientIp(c, deps.trustProxy ?? false))
  })

  registerSetupRoutes(app, deps)
  registerPublicStorefrontRoutes(app, deps)
  registerPublicSyncRoutes(app, deps)

  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PREFIXES.some((p) => c.req.path.startsWith(p))) return next()
    // Otro sistema llega con su clave; una persona, con la cookie de su sesión.
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1]
    let actor = bearer
      ? bearer.startsWith(PLUGIN_TOKEN_PREFIX)
        ? pluginTokenActor(deps.db, deps.plugins, bearer)
        : resolveApiKeyActor(deps.db, bearer, deps.now())
      : await resolveActor(deps.auth, deps.db, c.req.raw.headers)
    if (!actor) throw unauthorized()
    // La pantalla de un plugin llega con la sesión de quien la usa y el plugin en la cabecera
    // (la pone la app, nunca el plugin): puede lo que ambos pueden.
    const bridged = c.req.header("x-millhiore-plugin")
    if (bridged && !actor.pluginId) {
      if (actor.apiKeyId)
        throw new HttpError(403, "FORBIDDEN", "Una clave de la API no es un plugin")
      actor = pluginBridgeActor(deps.db, actor, bridged)
      if (!actor) throw new HttpError(403, "PLUGIN_OFF", "Ese plugin no está encendido")
    }
    if (
      (actor.apiKeyId || actor.pluginId) &&
      SESSION_ONLY_PREFIXES.some((p) => c.req.path.startsWith(p))
    ) {
      throw new HttpError(403, "FORBIDDEN", "Una clave de la API o un plugin no pueden usar esto")
    }
    // Un plugin no maneja plugins: solo llega a sus propias rutas.
    if (
      actor.pluginId &&
      c.req.path.startsWith("/api/plugins") &&
      !c.req.path.startsWith(`/api/plugins/${actor.pluginId}/run/`)
    ) {
      throw new HttpError(403, "FORBIDDEN", "Un plugin no puede usar esto")
    }
    // Con una contraseña temporal solo se puede ver quién es uno y elegir la propia.
    if (actor.mustChangePassword && !TEMPORARY_PASSWORD_PATHS.includes(c.req.path)) {
      throw new HttpError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "Primero elige tu propia contraseña (la que tienes es temporal)",
      )
    }
    // En una sucursal, el catálogo, los usuarios y los ajustes del negocio se cambian en el central.
    requireNotManagedByCentral(deps.db, c.req.method, c.req.path)
    c.set("actor", actor)
    return next()
  })

  registerUserRoutes(app, deps)
  registerAuditRoutes(app, deps)
  registerAccountRoutes(app, deps)
  registerPaymentMethodRoutes(app, deps)
  registerInventoryRoutes(app, deps)
  registerLocationRoutes(app, deps)
  registerBranchRoutes(app, deps)
  registerLotRoutes(app, deps)
  registerLabelRoutes(app, deps)
  registerScaleRoutes(app, deps)
  registerDocumentRoutes(app, deps)
  registerDiscountCodeRoutes(app, deps)
  registerExpenseRoutes(app, deps)
  registerRecurringRoutes(app, deps)
  registerRateRoutes(app, deps)
  registerSettingsRoutes(app, deps)
  registerCatalogRoutes(app, deps)
  registerChargeRoutes(app, deps)
  registerBootstrapRoutes(app, deps)
  registerShiftRoutes(app, deps)
  registerContactRoutes(app, deps)
  registerReceivableRoutes(app, deps)
  registerPayableRoutes(app, deps)
  registerDebtRoutes(app, deps)
  registerReportRoutes(app, deps)
  registerQuoteRoutes(app, deps)
  registerDiningRoutes(app, deps)
  registerKitchenRoutes(app, deps)
  registerImportRoutes(app, deps)
  registerFeatureRoutes(app, deps)
  registerBackupRoutes(app, deps)
  registerPrintingRoutes(app, deps)
  registerApiKeyRoutes(app, deps)
  registerWebhookRoutes(app, deps)
  registerTelegramRoutes(app, deps)
  registerNetworkRoutes(app, deps)
  registerRemoteRoutes(app, deps)
  registerStorefrontRoutes(app, deps)
  registerOrderRoutes(app, deps)
  registerPluginRoutes(app, deps)
  registerSyncRoutes(app, deps)

  app.openAPIRegistry.registerComponent("securitySchemes", "claveApi", {
    type: "http",
    scheme: "bearer",
    description:
      "Clave creada en Ajustes → Integraciones (mwk_…). Actúa como quien la creó, con los permisos que se le dieron.",
  })
  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Millhiore WINK POS API",
      version: "0.0.0",
      description:
        "API del punto de venta. Otro sistema entra con una clave de la API en la cabecera `Authorization: Bearer mwk_…` (se crea en Ajustes → Integraciones con los permisos que necesita); la app web usa la cookie de la sesión. Una clave puede lo mismo que un usuario con esos permisos, salvo manejar usuarios, sesiones, claves y ajustes.",
    },
    security: [{ claveApi: [] }],
  })
  app.get("/api/docs", Scalar({ url: "/api/openapi.json" }))

  registerPluginFiles(app, deps)
  if (deps.webRoot) serveSpa(app, { ...deps, webRoot: deps.webRoot })

  return app
}

/**
 * Sirve la aplicación web compilada. Cualquier ruta que no sea un archivo devuelve `index.html`
 * (el enrutado lo hace el navegador), salvo `/catalogo`, que es la página del catálogo en línea.
 * Los assets con hash se cachean un año; el HTML, nunca.
 */
function serveSpa(app: OpenAPIHono<AppEnv>, deps: AppDeps & { webRoot: string }): void {
  const root = resolve(deps.webRoot)
  const index = join(root, "index.html")
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api/")) return next()
    if (c.req.path === "/catalogo" || c.req.path.startsWith("/catalogo/")) {
      return catalogPage(c, deps.db, root, deps.now())
    }
    let relative: string
    try {
      relative = decodeURIComponent(c.req.path).replace(/^\/+/, "")
    } catch {
      return next()
    }
    const full = resolve(root, relative)
    if (relative && full.startsWith(root + sep) && isFile(full)) {
      const immutable = relative.startsWith("assets/")
      return new Response(Bun.file(full), {
        headers: {
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        },
      })
    }
    return new Response(Bun.file(index), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    })
  })
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
