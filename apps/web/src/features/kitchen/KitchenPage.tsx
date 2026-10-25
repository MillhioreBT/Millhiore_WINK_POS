import type { KitchenStation, KitchenTicket } from "@millhiore/contracts"
import { Button, cn } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { BellIcon, BellOffIcon, CheckIcon, PrinterIcon, RotateCcwIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatQty, formatTime } from "../../lib/format"
import { kitchenStationsQuery, kitchenTicketsQuery, queryClient } from "../../lib/queries"
import { can, useMe } from "../../lib/session"

const STATION_KEY = "millhiore.kitchen.station"
const SOUND_KEY = "millhiore.kitchen.sound"

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Sin almacenamiento (ventana privada): se olvida al recargar.
  }
}

/** Un pitido corto para avisar de una comanda nueva. */
function beep(): void {
  try {
    const audio = new AudioContext()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.frequency.value = 880
    gain.gain.value = 0.15
    osc.connect(gain).connect(audio.destination)
    osc.start()
    osc.stop(audio.currentTime + 0.18)
    osc.onended = () => void audio.close()
  } catch {
    // El navegador no deja sonar sin que se toque la pantalla primero.
  }
}

/** Minutos desde que se pidió, con el color según el tiempo de la estación. */
export function waitLevel(minutes: number, target: number): "ok" | "late" | "over" {
  if (minutes >= target) return "over"
  if (minutes >= target * 0.75) return "late"
  return "ok"
}

/**
 * La pantalla de cocina: las comandas por preparar de una estación (o de todas), la más vieja
 * primero, con cuánto llevan esperando. Se actualiza sola y pita cuando llega una nueva.
 */
export function KitchenPage() {
  const me = useMe()
  const stations = useQuery(kitchenStationsQuery)
  const [stationId, setStationId] = useState(() => readLocal(STATION_KEY) ?? "")
  const [sound, setSound] = useState(() => readLocal(SOUND_KEY) === "1")
  const active = (stations.data ?? []).filter((s) => s.active)
  const station = active.find((s) => s.id === stationId)
  const chosen = station ? station.id : ""
  const pending = useQuery(kitchenTicketsQuery(chosen, "pending"))
  const ready = useQuery(kitchenTicketsQuery(chosen, "ready"))
  const [now, setNow] = useState(() => Date.now())
  const seen = useRef<Set<string> | null>(null)
  const canMark = can(me, "kitchen.view")

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])

  // Pita cuando aparece una comanda que no estaba (no al abrir la pantalla).
  useEffect(() => {
    const ids = (pending.data ?? []).map((t) => t.id)
    if (!pending.data) return
    if (seen.current && sound && ids.some((id) => !seen.current?.has(id))) beep()
    seen.current = new Set(ids)
  }, [pending.data, sound])

  const pick = (id: string) => {
    setStationId(id)
    writeLocal(STATION_KEY, id)
    seen.current = null
  }

  const mark = async (ticket: KitchenTicket, action: "ready" | "unready" | "reprint") => {
    try {
      await api(`/api/kitchen/tickets/${ticket.id}/${action}`, { body: {} })
      await queryClient.invalidateQueries({ queryKey: ["kitchen", "tickets"] })
      if (action === "reprint") toast.success(`Comanda #${ticket.number} reimpresa`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const targetOf = (t: KitchenTicket) =>
    active.find((s) => s.id === t.stationId)?.targetMinutes ?? 15

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto font-semibold text-xl">Cocina</h1>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={sound}
          onClick={() => {
            setSound(!sound)
            writeLocal(SOUND_KEY, sound ? "0" : "1")
            if (!sound) beep()
          }}
        >
          {sound ? <BellIcon /> : <BellOffIcon />} {sound ? "Con sonido" : "Sin sonido"}
        </Button>
      </div>
      {active.length > 1 ? (
        <div
          className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
          role="tablist"
          aria-label="Estaciones"
        >
          {[{ id: "", name: "Todas" } as Pick<KitchenStation, "id" | "name">, ...active].map(
            (s) => (
              <Button
                key={s.id || "all"}
                role="tab"
                aria-selected={chosen === s.id}
                variant={chosen === s.id ? "default" : "outline"}
                size="sm"
                className="shrink-0 rounded-full"
                onClick={() => pick(s.id)}
              >
                {s.name}
              </Button>
            ),
          )}
        </div>
      ) : null}

      {stations.data && active.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          Aún no hay estaciones: créalas en Ajustes → Cocina.
        </p>
      ) : null}
      {pending.data?.length === 0 && active.length ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          No hay nada por preparar.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {(pending.data ?? []).map((t) => (
          <TicketCard
            key={t.id}
            ticket={t}
            now={now}
            target={targetOf(t)}
            showStation={!chosen && active.length > 1}
            canMark={canMark}
            onReady={() => void mark(t, "ready")}
            onReprint={() => void mark(t, "reprint")}
          />
        ))}
      </div>

      {ready.data?.length ? (
        <section aria-label="Listas" className="grid grid-cols-1 gap-2">
          <h2 className="font-medium text-muted-foreground text-sm">Listas hace poco</h2>
          <ul className="grid grid-cols-1 divide-y rounded-lg border bg-card">
            {ready.data.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <CheckIcon className="size-4 shrink-0 text-success" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{t.source}</span> · #{t.number} ·{" "}
                  {t.lines.map((l) => `${formatQty(l.qtyMilli)} ${l.name}`).join(", ")}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {t.readyAt ? formatTime(t.readyAt) : ""}
                </span>
                {canMark ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void mark(t, "unready")}
                  >
                    <RotateCcwIcon /> Deshacer
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function TicketCard({
  ticket,
  now,
  target,
  showStation,
  canMark,
  onReady,
  onReprint,
}: {
  ticket: KitchenTicket
  now: number
  target: number
  showStation: boolean
  canMark: boolean
  onReady: () => void
  onReprint: () => void
}) {
  const minutes = Math.max(0, Math.floor((now - ticket.createdAt) / 60_000))
  const level = waitLevel(minutes, target)
  const voided = ticket.kind === "void"
  return (
    <article
      aria-label={`Comanda ${ticket.number}, ${ticket.source}`}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs",
        voided ? "border-destructive" : level === "over" ? "border-destructive/60" : "",
      )}
    >
      <header
        className={cn(
          "flex items-start justify-between gap-2 border-b px-3 py-2",
          voided ? "bg-destructive/10" : "",
        )}
      >
        <div className="min-w-0">
          <p className="truncate font-bold text-lg leading-tight">{ticket.source}</p>
          <p className="truncate text-muted-foreground text-xs">
            #{ticket.number} · {formatTime(ticket.createdAt)}
            {showStation ? ` · ${ticket.stationName}` : ""}
            {ticket.createdBy ? ` · ${ticket.createdBy}` : ""}
          </p>
        </div>
        <span
          className={cn(
            "tabular shrink-0 rounded-md px-2 py-0.5 font-semibold text-sm",
            level === "over"
              ? "bg-destructive text-white"
              : level === "late"
                ? "bg-warning/30 text-warning-foreground dark:text-warning"
                : "bg-muted text-muted-foreground",
          )}
        >
          {minutes} min
        </span>
      </header>
      {voided ? (
        <p className="bg-destructive py-1 text-center font-bold text-sm text-white tracking-wide">
          ANULAR
        </p>
      ) : null}
      <ul className="grid flex-1 grid-cols-1 gap-2 px-3 py-2">
        {ticket.lines.map((l) => (
          <li key={l.id} className="grid grid-cols-[auto_1fr] gap-x-2">
            <span className="tabular font-bold text-lg leading-tight">
              {formatQty(l.qtyMilli)}×
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  "block font-semibold text-lg leading-tight",
                  voided ? "line-through" : "",
                )}
              >
                {l.name}
              </span>
              {l.modifiers.map((m) => (
                <span key={m.id} className="block text-sm">
                  + {m.name}
                </span>
              ))}
              {l.note ? (
                <span className="mt-0.5 block rounded bg-warning/25 px-1.5 py-0.5 font-medium text-sm">
                  {l.note}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {ticket.printError ? (
        <div className="flex items-center gap-2 border-t bg-warning/15 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1">No se imprimió: {ticket.printError}</span>
          <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={onReprint}>
            <PrinterIcon /> Reimprimir
          </Button>
        </div>
      ) : null}
      {canMark ? (
        <div className="border-t p-2">
          <Button
            size="lg"
            variant={voided ? "outline" : "success"}
            className="w-full"
            onClick={onReady}
          >
            <CheckIcon /> {voided ? "Visto" : "Listo"}
          </Button>
        </div>
      ) : null}
    </article>
  )
}
