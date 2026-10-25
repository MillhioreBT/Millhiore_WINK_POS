import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { bootstrapQuery, pluginPagesQuery } from "../../lib/queries"
import { useMe } from "../../lib/session"

/** Lo que la pantalla de un plugin puede pedirle a la app (nunca entrar, ni manejar sesiones). */
function allowed(method: string, path: string): boolean {
  return (
    /^(GET|POST|PUT|PATCH|DELETE)$/.test(method) &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/auth") &&
    !path.includes("..")
  )
}

const theme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light")

/**
 * La pantalla de un plugin en un marco aislado (`sandbox`, sin la sesión ni el origen de la app).
 * Habla con la app por mensajes: la app hace cada llamada con la sesión de quien la usa y el
 * plugin en la cabecera, así el servidor le da solo lo que ambos pueden.
 */
export function PluginPage({ pluginId }: { pluginId: string }) {
  const pages = useQuery(pluginPagesQuery)
  const page = pages.data?.find((p) => p.id === pluginId)
  const me = useMe()
  const business = useQuery(bootstrapQuery).data?.business.name ?? ""
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || e.source !== target) return
      const m = (e.data ?? {}) as {
        type?: string
        id?: number
        method?: string
        path?: string
        body?: unknown
      }
      // Su origen es opaco («null»): se le responde a su ventana, con «*».
      const reply = (data: Record<string, unknown>) =>
        target.postMessage({ type: "millhiore:response", id: m.id, ...data }, "*")
      if (m.type === "millhiore:hello") {
        target.postMessage(
          {
            type: "millhiore:init",
            info: { pluginId, user: { id: me.id, name: me.name }, theme: theme(), business },
          },
          "*",
        )
        return
      }
      if (m.type !== "millhiore:request") return
      const method = String(m.method ?? "GET").toUpperCase()
      const path = String(m.path ?? "")
      if (!allowed(method, path)) {
        reply({ ok: false, status: 400, code: "NOT_ALLOWED", message: "Ruta no permitida" })
        return
      }
      try {
        const hasBody = m.body !== undefined && m.body !== null && method !== "GET"
        const res = await fetch(path, {
          method,
          credentials: "same-origin",
          headers: {
            "x-millhiore-plugin": pluginId,
            ...(hasBody ? { "content-type": "application/json" } : {}),
          },
          ...(hasBody ? { body: JSON.stringify(m.body) } : {}),
        })
        const text = await res.text()
        let body: unknown = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = text
        }
        if (res.ok) reply({ ok: true, body })
        else {
          const error = (body as { error?: { code?: string; message?: string } } | null)?.error
          reply({ ok: false, status: res.status, code: error?.code, message: error?.message })
        }
      } catch {
        reply({ ok: false, status: 0, code: "OFFLINE", message: "Sin conexión con el servidor" })
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [pluginId, me.id, me.name, business])

  // Si cambia el tema de la app, la pantalla del plugin lo sigue.
  useEffect(() => {
    const observer = new MutationObserver(() =>
      frame.current?.contentWindow?.postMessage({ type: "millhiore:theme", theme: theme() }, "*"),
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  if (pages.isPending) return <p className="text-muted-foreground text-sm">Cargando…</p>
  if (!page) {
    return (
      <p className="text-muted-foreground text-sm">
        Ese plugin no está encendido o no tienes permiso para usarlo.
      </p>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3">
      <h1 className="font-semibold text-xl">{page.title}</h1>
      <iframe
        ref={frame}
        key={page.url}
        src={page.url}
        title={page.title}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="h-[calc(100dvh-10rem)] min-h-96 w-full rounded-xl border bg-card"
      />
    </div>
  )
}
