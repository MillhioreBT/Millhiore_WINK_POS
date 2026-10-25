import variant from "@jitl/quickjs-singlefile-mjs-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core"

/**
 * Lo único que el código de un plugin puede usar: la API (con los permisos del plugin), internet
 * (solo a los equipos que declaró), su propio almacenamiento y su registro. Corre en QuickJS
 * compilado a WebAssembly: no ve archivos, ni la base, ni el proceso.
 */
export interface SandboxHost {
  api(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }>
  fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>
  storageGet(key: string): unknown
  storageSet(key: string, value: unknown): void
  storageDelete(key: string): void
  storageKeys(): string[]
  log(level: "info" | "error", message: string): void
}

export interface SandboxLimits {
  /** Memoria del plugin (bytes). */
  memory: number
  /** Tiempo de CPU seguido antes de cortarlo (ms). */
  cpuMs: number
  /** Lo más que espera a que termine una llamada, contando lo que espera a la red (ms). */
  callMs: number
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memory: 32 * 1024 * 1024,
  cpuMs: 2_000,
  callMs: 15_000,
}

let module: Promise<QuickJSWASMModule> | null = null
const quickjs = () => {
  module ??= newQuickJSWASMModuleFromVariant(variant)
  return module
}

export interface SandboxShape {
  events: string[]
  routes: { method: string; path: string }[]
  /** Cada cuántos minutos corre cada tarea. */
  tasks: number[]
}

/** Lo que define `millhiore` dentro del plugin, sobre las funciones del anfitrión (`__*`). */
const PRELUDE = `
(() => {
  const handlers = {}
  const routes = []
  const tasks = []
  const text = (args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
  const parse = (t) => (t === undefined ? undefined : JSON.parse(t))
  const millhiore = Object.freeze({
    on(event, fn) {
      if (typeof fn !== "function") throw new TypeError("millhiore.on: falta la función")
      ;(handlers[String(event)] ||= []).push(fn)
    },
    route(method, path, fn) {
      if (typeof fn !== "function") throw new TypeError("millhiore.route: falta la función")
      routes.push({ method: String(method).toUpperCase(), path: String(path), fn })
    },
    every(minutes, fn) {
      if (typeof fn !== "function") throw new TypeError("millhiore.every: falta la función")
      tasks.push({ minutes: Math.max(1, Math.floor(Number(minutes) || 0)), fn })
    },
    api: (method, path, body) =>
      __api(String(method).toUpperCase(), String(path), body === undefined ? "null" : JSON.stringify(body)).then(JSON.parse),
    fetch: (url, init) => __fetch(String(url), JSON.stringify(init || {})).then(JSON.parse),
    storage: Object.freeze({
      get: async (key) => parse(__storage("get", String(key), "")),
      set: async (key, value) => { __storage("set", String(key), JSON.stringify(value === undefined ? null : value)) },
      delete: async (key) => { __storage("delete", String(key), "") },
      keys: async () => JSON.parse(__storage("keys", "", "")),
    }),
    log: (...args) => __log("info", text(args)),
    error: (...args) => __log("error", text(args)),
  })
  globalThis.millhiore = millhiore
  globalThis.console = Object.freeze({ log: millhiore.log, info: millhiore.log, warn: millhiore.error, error: millhiore.error })
  globalThis.__dispatch = Object.freeze({
    describe: () =>
      JSON.stringify({
        events: Object.keys(handlers),
        routes: routes.map((r) => ({ method: r.method, path: r.path })),
        tasks: tasks.map((t) => t.minutes),
      }),
    emit: async (event, payload) => {
      for (const fn of handlers[event] || []) await fn(JSON.parse(payload))
    },
    task: async (i) => { await tasks[i].fn() },
    route: async (method, path, req) => {
      const r = routes.find((x) => x.method === method && x.path === path)
      if (!r) return "null"
      const res = await r.fn(JSON.parse(req))
      return JSON.stringify(res === undefined ? { status: 204 } : res)
    },
  })
})()
`

const MAX_TEXT = 1_000_000

/** Un plugin cargado: su propio QuickJS, con su memoria, su tiempo y sus funciones. */
export class PluginSandbox {
  private alive = true
  shape: SandboxShape = { events: [], routes: [], tasks: [] }

  private constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly vm: QuickJSContext,
    private readonly limits: SandboxLimits,
  ) {}

  /** Carga el código del plugin; si falla al cargar, lo dice (y no queda nada corriendo). */
  static async create(
    code: string,
    host: SandboxHost,
    limits: SandboxLimits = DEFAULT_LIMITS,
  ): Promise<PluginSandbox> {
    const runtime = (await quickjs()).newRuntime()
    runtime.setMemoryLimit(limits.memory)
    runtime.setMaxStackSize(512 * 1024)
    const vm = runtime.newContext()
    const box = new PluginSandbox(runtime, vm, limits)
    try {
      box.install(host)
      box.run(() => vm.evalCode(PRELUDE, "millhiore.js"))
      box.run(() => vm.evalCode(code, "server.js"))
      box.flush()
      box.shape = JSON.parse(box.callSync("describe")) as SandboxShape
      return box
    } catch (e) {
      box.dispose()
      throw e
    }
  }

  get running(): boolean {
    return this.alive
  }

  /** Corre el evento en sus manejadores (en orden); falla si alguno falla. */
  async emit(event: string, payload: unknown): Promise<void> {
    if (!this.shape.events.includes(event)) return
    await this.callAsync("emit", [event, JSON.stringify(payload)])
  }

  async task(index: number): Promise<void> {
    await this.callAsync("task", [index])
  }

  /** Su respuesta a una ruta propia; null si no tiene esa ruta. */
  async route(
    method: string,
    path: string,
    request: unknown,
  ): Promise<{ status: number; body: unknown } | null> {
    const out = await this.callAsync("route", [method, path, JSON.stringify(request)])
    const res = JSON.parse(String(out)) as { status?: unknown; body?: unknown } | null
    if (!res) return null
    const status = Number(res.status ?? 200)
    return {
      status: Number.isInteger(status) && status >= 200 && status <= 599 ? status : 200,
      body: res.body ?? null,
    }
  }

  dispose(): void {
    if (!this.alive) return
    this.alive = false
    try {
      this.vm.dispose()
      this.runtime.dispose()
    } catch {
      // un objeto que el plugin dejó vivo no impide soltar el resto
    }
  }

  /** Corre algo dentro de QuickJS con su tiempo de CPU contado. */
  private run(fn: () => ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.cpuMs))
    const result = fn()
    if (result.error) {
      const error = this.vm.dump(result.error) as { message?: string; name?: string } | string
      result.error.dispose()
      throw new Error(
        typeof error === "string" ? error : `${error?.name ?? "Error"}: ${error?.message ?? "?"}`,
      )
    }
    const value = result.value
    return value
  }

  /** Lo que quedó pendiente (las continuaciones de las promesas), también con su tiempo. */
  private flush(): void {
    if (!this.alive) return
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.cpuMs))
    const r = this.runtime.executePendingJobs()
    if (r.error) r.error.dispose()
  }

  private callSync(name: string): string {
    const dispatch = this.vm.getProp(this.vm.global, "__dispatch")
    const fn = this.vm.getProp(dispatch, name)
    try {
      const out = this.run(() => this.vm.callFunction(fn, dispatch))
      const value = this.vm.dump(out) as string
      out.dispose()
      return value
    } finally {
      fn.dispose()
      dispatch.dispose()
    }
  }

  private async callAsync(name: string, args: (string | number)[]): Promise<unknown> {
    if (!this.alive) throw new Error("El plugin no está corriendo")
    const vm = this.vm
    const dispatch = vm.getProp(vm.global, "__dispatch")
    const fn = vm.getProp(dispatch, name)
    const handles = args.map((a) => (typeof a === "number" ? vm.newNumber(a) : vm.newString(a)))
    let promise: QuickJSHandle
    try {
      promise = this.run(() => vm.callFunction(fn, dispatch, ...handles))
    } finally {
      for (const h of handles) h.dispose()
      fn.dispose()
      dispatch.dispose()
    }
    const settled = vm.resolvePromise(promise)
    promise.dispose()
    this.flush()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`El plugin tardó más de ${this.limits.callMs / 1000} s`)),
        this.limits.callMs,
      )
    })
    try {
      const result = await Promise.race([settled, timeout])
      if (!this.alive) throw new Error("El plugin se detuvo")
      if (result.error) {
        const error = vm.dump(result.error) as { message?: string; name?: string } | string
        result.error.dispose()
        throw new Error(
          typeof error === "string" ? error : `${error?.name ?? "Error"}: ${error?.message ?? "?"}`,
        )
      }
      const value = vm.dump(result.value)
      result.value.dispose()
      return value
    } finally {
      clearTimeout(timer)
    }
  }

  /** Las funciones del anfitrión que usa el preludio (`__api`, `__fetch`, `__storage`, `__log`). */
  private install(host: SandboxHost): void {
    const vm = this.vm
    const asyncFn = (name: string, run: (...args: string[]) => Promise<unknown>) => {
      const fn = vm.newFunction(name, (...handles) => {
        const args = handles.map((h) => vm.getString(h))
        const deferred = vm.newPromise()
        run(...args)
          .then(
            (value) => {
              if (!this.alive) return
              const h = vm.newString(JSON.stringify(value ?? null))
              deferred.resolve(h)
              h.dispose()
            },
            (e: unknown) => {
              if (!this.alive) return
              const err = vm.newError((e as Error)?.message ?? String(e))
              deferred.reject(err)
              err.dispose()
            },
          )
          .finally(() => {
            if (!this.alive) return
            deferred.dispose()
            this.flush()
          })
        return deferred.handle
      })
      vm.setProp(vm.global, name, fn)
      fn.dispose()
    }
    asyncFn("__api", (method = "GET", path = "", body = "null") =>
      host.api(method, path, JSON.parse(body)),
    )
    asyncFn("__fetch", (url = "", init = "{}") => {
      const parsed = JSON.parse(init) as {
        method?: string
        headers?: Record<string, string>
        body?: unknown
      }
      return host.fetch(url, {
        ...(parsed.method ? { method: String(parsed.method) } : {}),
        ...(parsed.headers ? { headers: parsed.headers } : {}),
        ...(parsed.body !== undefined
          ? { body: typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body) }
          : {}),
      })
    })
    const storage = vm.newFunction("__storage", (op, key, value) => {
      const action = vm.getString(op)
      const k = vm.getString(key)
      if (action === "get") {
        const v = host.storageGet(k)
        return v === undefined ? vm.undefined : vm.newString(JSON.stringify(v))
      }
      if (action === "set") {
        const text = vm.getString(value)
        if (text.length > 64_000) throw new Error("Un valor guardado no puede pasar de 64 KB")
        host.storageSet(k, JSON.parse(text))
        return vm.undefined
      }
      if (action === "delete") {
        host.storageDelete(k)
        return vm.undefined
      }
      return vm.newString(JSON.stringify(host.storageKeys()))
    })
    vm.setProp(vm.global, "__storage", storage)
    storage.dispose()
    const log = vm.newFunction("__log", (level, message) => {
      const text = vm.getString(message).slice(0, 2_000)
      host.log(vm.getString(level) === "error" ? "error" : "info", text)
    })
    vm.setProp(vm.global, "__log", log)
    log.dispose()
  }
}

/** Cuánto texto se acepta de una respuesta de internet. */
export const MAX_FETCH_TEXT = MAX_TEXT
