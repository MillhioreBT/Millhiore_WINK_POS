/**
 * Lo que la pantalla de un plugin carga con `<script src="/plugins/sdk.js">`: `millhiore.api` y
 * `millhiore.route` hablan con la app por mensajes (la pantalla corre en un marco aislado, sin
 * acceso directo a la API ni a la sesión), y `millhiore.ready` trae quién la usa y el tema.
 */
export const PLUGIN_SDK = `(() => {
  "use strict"
  const pending = new Map()
  let seq = 0
  let info = null
  let resolveReady
  const ready = new Promise((r) => { resolveReady = r })
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return
    const m = e.data || {}
    if (m.type === "millhiore:init" && !info) {
      info = Object.freeze(m.info)
      document.documentElement.classList.toggle("dark", info.theme === "dark")
      document.documentElement.dataset.theme = info.theme
      resolveReady(info)
    } else if (m.type === "millhiore:theme" && info) {
      document.documentElement.classList.toggle("dark", m.theme === "dark")
      document.documentElement.dataset.theme = m.theme
    } else if (m.type === "millhiore:response") {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.body)
      else p.reject(Object.assign(new Error(m.message || "Error"), { status: m.status, code: m.code }))
    }
  })
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      window.parent.postMessage({ type: "millhiore:request", id, method, path, body }, "*")
    })
  window.millhiore = Object.freeze({
    ready,
    api: (method, path, body) => call(String(method).toUpperCase(), String(path), body),
    route: (method, path, body) =>
      ready.then((i) => call(String(method).toUpperCase(), "/api/plugins/" + i.pluginId + "/run" + path, body)),
  })
  window.parent.postMessage({ type: "millhiore:hello" }, "*")
})()
`
