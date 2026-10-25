import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { Db } from "@millhiore/db"
import type { Context } from "hono"
import type { AppEnv } from "../../http/actor"
import type { AppDeps } from "../../http/context"
import { errorBody, HttpError } from "../../http/errors"
import { businessProfile } from "../settings/service"
import { registerPublicStorefrontRoutes } from "./routes"
import { publicCatalog, storefrontSettings } from "./service"

/** La página del catálogo dentro de la aplicación web compilada. */
export const CATALOG_HTML = "catalogo.html"

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  )

/** De dónde se pidió (para la foto de la vista previa al compartir el enlace por WhatsApp). */
function originOf(c: Context): string {
  const url = new URL(c.req.url)
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(/:$/, "")
  return `${proto}://${host}`
}

/**
 * La página del catálogo con el nombre del negocio en el título y en la vista previa que muestran
 * WhatsApp, Instagram o Telegram al compartir el enlace (sin JavaScript no la leen).
 */
export function catalogPage(c: Context, db: Db, webRoot: string, now: number): Response {
  const file = join(resolve(webRoot), CATALOG_HTML)
  if (!existsSync(file)) return c.text("El catálogo no está compilado", 404)
  let name = "Catálogo"
  let description = "Productos y precios"
  let image: string | null = null
  try {
    name = businessProfile(db).name
    description = storefrontSettings(db).message ?? `Productos y precios de ${name}`
    image = publicCatalog(db, now).products.find((p) => p.imageUrl)?.imageUrl ?? null
  } catch {
    // sin configurar o con el catálogo apagado: la página dice lo que pasa
  }
  const title = `${name} · Catálogo`
  const meta = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    image ? `<meta property="og:image" content="${escapeHtml(originOf(c) + image)}" />` : "",
  ].join("\n    ")
  const html = readFileSync(file, "utf8").replace(/<title>[^<]*<\/title>/, meta)
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  })
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Lo que escucha en el puerto del catálogo, el que se publica en internet: la página del catálogo,
 * sus archivos y su API pública. Nada más: ni la entrada, ni la caja, ni la API con sesión.
 */
export function createStorefrontApp(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("VALIDATION", "Datos inválidos"), 422)
    },
  })
  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json(errorBody(e.code, e.message), e.status)
    console.error(e)
    return c.json(errorBody("INTERNAL", "Error interno del servidor"), 500)
  })
  app.use("*", async (c, next) => {
    await next()
    c.header("x-content-type-options", "nosniff")
    c.header("x-frame-options", "DENY")
    c.header("referrer-policy", "strict-origin-when-cross-origin")
  })

  registerPublicStorefrontRoutes(app, deps)
  app.all("/api/*", (c) => c.json(errorBody("NOT_FOUND", "No existe"), 404))

  const root = deps.webRoot ? resolve(deps.webRoot) : null
  app.get("*", (c) => {
    if (!root) return c.text("El catálogo no está compilado", 404)
    let relative: string
    try {
      relative = decodeURIComponent(c.req.path).replace(/^\/+/, "")
    } catch {
      return c.text("No existe", 404)
    }
    // Solo los archivos compilados de la web (con hash) y el ícono; lo demás es la página.
    if (relative.startsWith("assets/") || relative === "favicon.svg") {
      const full = resolve(root, relative)
      const inside =
        full === join(root, "favicon.svg") || full.startsWith(join(root, "assets") + sep)
      if (!inside || !isFile(full)) return c.text("No existe", 404)
      return new Response(Bun.file(full), {
        headers: {
          "cache-control": relative.startsWith("assets/")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=86400",
        },
      })
    }
    return catalogPage(c, deps.db, root, deps.now())
  })
  app.notFound((c) => c.text("No existe", 404))
  return app
}
