import type {
  TelegramAlerts,
  TelegramChat,
  TelegramSettings,
  TelegramTest,
} from "@millhiore/contracts"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PlusIcon, SearchIcon, SendIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { queryClient, telegramQuery } from "../../lib/queries"
import { useFeatures } from "../../lib/session"

const ALERTS: { key: Exclude<keyof TelegramAlerts, "dailyHour">; label: string }[] = [
  { key: "daily", label: "Resumen del día" },
  { key: "lowStock", label: "Un producto llegó a su existencia mínima" },
  { key: "voids", label: "Se anuló una venta u otro documento" },
  { key: "shifts", label: "Cierre de turno, con lo que no cuadró" },
  { key: "rate", label: "Tasa nueva" },
  { key: "orders", label: "Pedido desde el catálogo en línea" },
]

/** Las 24 horas con su nombre: «8 p. m.», «12 del mediodía». */
const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label:
    h === 0
      ? "12 de la noche"
      : h < 12
        ? `${h} a. m.`
        : h === 12
          ? "12 del mediodía"
          : `${h - 12} p. m.`,
}))

/**
 * Alertas al dueño por Telegram: se conecta un bot (lo crea @BotFather), se eligen los chats que
 * le escribieron y qué alertas reciben. Necesita internet; si no hay, se reintentan un rato.
 */
export function TelegramCard() {
  const features = useFeatures()
  const settings = useQuery(telegramQuery)
  const [token, setToken] = useState("")
  const [found, setFound] = useState<TelegramChat[] | null>(null)
  const [busy, setBusy] = useState(false)
  const s = settings.data

  const save = async (
    body: Partial<Pick<TelegramSettings, "chats" | "alerts">> & { token?: string | null },
    done?: string,
  ) => {
    // Las alertas y los chats cambian al instante en pantalla; si el servidor no los guarda,
    // vuelven a como estaban.
    const before = s
    const { token: _, ...visible } = body
    if (before) queryClient.setQueryData(telegramQuery.queryKey, { ...before, ...visible })
    setBusy(body.token !== undefined)
    try {
      const next = await api<TelegramSettings>("/api/telegram", { method: "PUT", body })
      queryClient.setQueryData(telegramQuery.queryKey, next)
      if (done) toast.success(done)
      return true
    } catch (e) {
      if (before) queryClient.setQueryData(telegramQuery.queryKey, before)
      toast.error(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const discover = async () => {
    setBusy(true)
    try {
      setFound(await api<TelegramChat[]>("/api/telegram/discover", { method: "POST" }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const test = async () => {
    setBusy(true)
    try {
      const r = await api<TelegramTest>("/api/telegram/test", { method: "POST" })
      if (r.errors.length) toast.error(r.errors.join(" · "))
      else toast.success(`Prueba enviada a ${r.sent} chat${r.sent === 1 ? "" : "s"}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alertas por Telegram</CardTitle>
        <CardDescription>
          Te avisa en tu Telegram del cierre del día, los productos por reponer, las anulaciones y
          los cierres de turno. Necesita internet.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        {!s ? (
          <p className="text-muted-foreground text-sm">Cargando…</p>
        ) : !s.configured ? (
          <form
            className="grid min-w-0 gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await save({ token: token.trim() }, "Bot conectado")) setToken("")
            }}
          >
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
              <li>
                En Telegram, abre <span className="font-medium text-foreground">@BotFather</span>,
                escribe <code>/newbot</code> y ponle un nombre (por ejemplo, «Alertas de mi
                bodega»).
              </li>
              <li>Pega aquí el token que te da (empieza con números y dos puntos).</li>
            </ol>
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <Field label="Token del bot" htmlFor="tg-token" className="min-w-56 flex-1">
                <Input
                  id="tg-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="123456789:AA…"
                  autoComplete="off"
                  className="font-mono"
                />
              </Field>
              <Button type="submit" disabled={busy || !token.trim()}>
                Conectar
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                Conectado a <span className="font-medium">{s.botName ?? "tu bot"}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void save({ token: null }, "Bot desconectado")}
              >
                Desconectar
              </Button>
            </div>

            <section className="grid min-w-0 gap-2">
              <h3 className="font-medium text-sm">Quién recibe las alertas</h3>
              {s.chats.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Desde tu Telegram, escríbele cualquier cosa a {s.botName ?? "tu bot"} (o agrégalo
                  a un grupo del negocio) y toca «Buscar chats».
                </p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {s.chats.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-1 rounded-full border py-0.5 pr-0.5 pl-3 text-sm"
                    >
                      {c.name}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-6 rounded-full"
                        aria-label={`Quitar a ${c.name}`}
                        onClick={() => void save({ chats: s.chats.filter((x) => x.id !== c.id) })}
                      >
                        <XIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void discover()}>
                  <SearchIcon /> Buscar chats
                </Button>
                {s.chats.length ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void test()}>
                    <SendIcon /> Mandar una prueba
                  </Button>
                ) : null}
              </div>
              {found ? (
                <div className="grid gap-1.5 rounded-lg bg-muted/50 p-2.5 text-sm">
                  {found.filter((f) => !s.chats.some((c) => c.id === f.id)).length === 0 ? (
                    <p className="text-muted-foreground">
                      No hay chats nuevos: escríbele al bot y vuelve a buscar.
                    </p>
                  ) : null}
                  {found
                    .filter((f) => !s.chats.some((c) => c.id === f.id))
                    .map((f) => (
                      <div key={f.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">{f.name}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={() =>
                            void save({ chats: [...s.chats, f] }, `${f.name} agregado`)
                          }
                        >
                          <PlusIcon /> Agregar
                        </Button>
                      </div>
                    ))}
                </div>
              ) : null}
            </section>

            <fieldset className="grid min-w-0 gap-1" disabled={busy}>
              <legend className="mb-1.5 font-medium text-sm">Qué alertas</legend>
              {ALERTS.filter((a) => a.key !== "orders" || features.catalog).map((a) => (
                <div key={a.key} className="flex flex-wrap items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={s.alerts[a.key]}
                      onChange={(e) =>
                        void save({ alerts: { ...s.alerts, [a.key]: e.target.checked } })
                      }
                    />
                    {a.label}
                  </label>
                  {a.key === "daily" && s.alerts.daily ? (
                    <NativeSelect
                      aria-label="Hora del resumen"
                      value={s.alerts.dailyHour}
                      onChange={(e) =>
                        void save({ alerts: { ...s.alerts, dailyHour: Number(e.target.value) } })
                      }
                      className="h-8 w-auto py-1"
                    >
                      {HOURS.map((h) => (
                        <option key={h.value} value={h.value}>
                          a las {h.label}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : null}
                </div>
              ))}
            </fieldset>
          </>
        )}
      </CardContent>
    </Card>
  )
}
