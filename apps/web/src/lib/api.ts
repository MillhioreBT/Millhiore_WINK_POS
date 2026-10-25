/** Error de la API con el código estable del servidor ({ error: { code, message } }). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message)
    this.name = "ApiError"
  }
}

// Mensajes de Better Auth (vienen en inglés) traducidos para la persona.
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_USERNAME_OR_PASSWORD: "Usuario o contraseña incorrectos",
  TOO_MANY_REQUESTS: "Demasiados intentos. Espera un minuto e intenta de nuevo",
}

/** El cuerpo va como JSON, salvo un archivo (una foto), que va tal cual con su tipo. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const file = init.body instanceof Blob ? init.body : null
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers:
        init.body === undefined
          ? {}
          : { "content-type": file ? file.type || "application/octet-stream" : "application/json" },
      body: init.body === undefined ? null : (file ?? JSON.stringify(init.body)),
      credentials: "same-origin",
      ...(init.signal ? { signal: init.signal } : {}),
    })
  } catch {
    throw new ApiError(0, "OFFLINE", "No hay conexión con el servidor")
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; issues?: { path: string; message: string }[] }
      code?: string
      message?: string
    } | null
    const code =
      body?.error?.code ?? body?.code ?? (res.status === 429 ? "TOO_MANY_REQUESTS" : "HTTP_ERROR")
    const message =
      AUTH_MESSAGES[code] ?? body?.error?.message ?? body?.message ?? `Error ${res.status}`
    throw new ApiError(res.status, code, message, body?.error?.issues ?? [])
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** Mensaje legible de cualquier error (para avisos). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const first = e.issues[0]
    return first ? `${e.message}: ${first.path} — ${first.message}` : e.message
  }
  return e instanceof Error ? e.message : String(e)
}
