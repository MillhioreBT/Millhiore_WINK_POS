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
import { registerAuditRoutes } from "./modules/audit/routes"
import { registerBackupRoutes } from "./modules/backups/routes"
import { registerBootstrapRoutes } from "./modules/bootstrap/routes"
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
import { registerPayableRoutes } from "./modules/payables/routes"
import { registerPaymentMethodRoutes } from "./modules/payment-methods/routes"
import { registerPrintingRoutes } from "./modules/printing/routes"
import { registerQuoteRoutes } from "./modules/quotes/routes"
import { registerRateRoutes } from "./modules/rates/routes"
import { registerReceivableRoutes } from "./modules/receivables/routes"
import { registerRecurringRoutes } from "./modules/recurring/routes"
import { registerReportRoutes } from "./modules/reports/routes"
import { registerSettingsRoutes } from "./modules/settings/routes"
import { registerSetupRoutes } from "./modules/setup/routes"
import { isConfigured } from "./modules/setup/service"
import { registerShiftRoutes } from "./modules/shifts/routes"
import { registerUserRoutes } from "./modules/users/routes"

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

/** Lo único permitido mientras la contraseña es temporal. */
const TEMPORARY_PASSWORD_PATHS = ["/api/me", "/api/me/password", "/api/bootstrap"]

/** Rutas que no exigen sesión. Todo lo demás bajo /api la exige. */
const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/auth/",
  "/api/setup",
  "/api/openapi.json",
  "/api/docs",
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

  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PREFIXES.some((p) => c.req.path.startsWith(p))) return next()
    const actor = await resolveActor(deps.auth, deps.db, c.req.raw.headers)
    if (!actor) throw unauthorized()
    // Con una contraseña temporal solo se puede ver quién es uno y elegir la propia.
    if (actor.mustChangePassword && !TEMPORARY_PASSWORD_PATHS.includes(c.req.path)) {
      throw new HttpError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "Primero elige tu propia contraseña (la que tienes es temporal)",
      )
    }
    c.set("actor", actor)
    return next()
  })

  registerUserRoutes(app, deps)
  registerAuditRoutes(app, deps)
  registerAccountRoutes(app, deps)
  registerPaymentMethodRoutes(app, deps)
  registerInventoryRoutes(app, deps)
  registerLocationRoutes(app, deps)
  registerLotRoutes(app, deps)
  registerLabelRoutes(app, deps)
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

  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Millhiore WINK POS API", version: "0.0.0" },
  })
  app.get("/api/docs", Scalar({ url: "/api/openapi.json" }))

  if (deps.webRoot) serveSpa(app, deps.webRoot)

  return app
}

/**
 * Sirve la aplicación web compilada. Cualquier ruta que no sea un archivo devuelve `index.html`
 * (el enrutado lo hace el navegador). Los assets con hash se cachean un año; el HTML, nunca.
 */
function serveSpa(app: OpenAPIHono<AppEnv>, webRoot: string): void {
  const root = resolve(webRoot)
  const index = join(root, "index.html")
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api/")) return next()
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
