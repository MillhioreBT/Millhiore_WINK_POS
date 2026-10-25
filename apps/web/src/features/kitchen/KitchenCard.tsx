import type { KitchenStation, StationPrinter } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { CheckIcon, PencilIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { categoriesQuery, kitchenStationsQuery, queryClient } from "../../lib/queries"

type PrinterMode = "screen" | StationPrinter["mode"]

const MODES: { id: PrinterMode; label: string }[] = [
  { id: "screen", label: "Solo la pantalla de cocina" },
  { id: "network", label: "Impresora de red (IP)" },
  { id: "windows", label: "Impresora compartida en Windows" },
  { id: "device", label: "Dispositivo del servidor (Linux)" },
]

/** En Ajustes: las estaciones (cocina, barra…) con lo que prepara cada una y dónde imprime. */
export function KitchenCard() {
  const stations = useQuery(kitchenStationsQuery)
  const categories = useQuery(categoriesQuery({ all: true }))
  const [editing, setEditing] = useState<KitchenStation | "new" | null>(null)
  const nameOf = (id: string) => categories.data?.find((c) => c.id === id)?.name ?? "?"
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cocina</CardTitle>
        <CardDescription>
          Dónde se prepara lo que se pide. Cada estación recibe las comandas de sus categorías en su
          impresora o en la pantalla de cocina (Ventas → Cocina).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        {stations.data?.length ? (
          <ul className="divide-y rounded-lg border">
            {stations.data.map((s) => (
              <li
                key={s.id}
                className={cn(
                  "flex items-start gap-2 px-3 py-2 text-sm",
                  s.active ? "" : "opacity-60",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{s.name}</span>
                  {s.active ? null : (
                    <Badge variant="outline" className="ml-2">
                      Inactiva
                    </Badge>
                  )}
                  <span className="block text-muted-foreground text-xs">
                    {s.categoryIds
                      ? s.categoryIds.map(nameOf).join(", ")
                      : "Todo lo que no va a otra"}
                    {" · "}
                    {s.printer
                      ? s.printer.mode === "network"
                        ? `Impresora ${s.printer.host}:${s.printer.port}`
                        : s.printer.mode === "windows"
                          ? `Impresora ${s.printer.share}`
                          : `Impresora ${s.printer.device}`
                      : "Solo pantalla"}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Editar ${s.name}`}
                  onClick={() => setEditing(s)}
                >
                  <PencilIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            Aún no hay estaciones: sin ellas nada va a la cocina.
          </p>
        )}
        <Button variant="outline" className="justify-self-start" onClick={() => setEditing("new")}>
          <PlusIcon /> Estación
        </Button>
        {editing ? (
          <StationDialog
            station={editing === "new" ? null : editing}
            first={!stations.data?.length}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

function StationDialog({
  station,
  first,
  onClose,
}: {
  station: KitchenStation | null
  first: boolean
  onClose: () => void
}) {
  const categories = useQuery(categoriesQuery())
  const [name, setName] = useState(station?.name ?? (first ? "Cocina" : ""))
  const [categoryIds, setCategoryIds] = useState<string[]>(station?.categoryIds ?? [])
  const [mode, setMode] = useState<PrinterMode>(station?.printer?.mode ?? "screen")
  const [host, setHost] = useState(station?.printer?.host ?? "")
  const [port, setPort] = useState(String(station?.printer?.port ?? 9100))
  const [share, setShare] = useState(station?.printer?.share ?? "")
  const [device, setDevice] = useState(station?.printer?.device ?? "")
  const [paperWidth, setPaperWidth] = useState<58 | 80>(station?.printer?.paperWidth ?? 80)
  const [counterSales, setCounterSales] = useState(station?.counterSales ?? true)
  const [target, setTarget] = useState(String(station?.targetMinutes ?? 15))
  const [active, setActive] = useState(station?.active ?? true)
  const [busy, setBusy] = useState<"save" | "test" | null>(null)

  const printer = (): StationPrinter | null =>
    mode === "screen"
      ? null
      : {
          mode,
          host: mode === "windows" ? host.trim() || null : mode === "network" ? host.trim() : null,
          port: Number.parseInt(port, 10) || 9100,
          share: mode === "windows" ? share.trim() : null,
          device: mode === "device" ? device.trim() : null,
          paperWidth,
        }

  const test = async () => {
    const p = printer()
    if (!p) return
    setBusy("test")
    try {
      await api("/api/print/test", { body: p })
      toast.success("Página de prueba enviada")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy("save")
    try {
      await api(station ? `/api/kitchen/stations/${station.id}` : "/api/kitchen/stations", {
        method: station ? "PUT" : "POST",
        body: {
          name: name.trim(),
          categoryIds: categoryIds.length ? categoryIds : null,
          printer: printer(),
          counterSales,
          targetMinutes: Number.parseInt(target, 10) || 15,
          active,
        },
      })
      await queryClient.invalidateQueries({ queryKey: ["kitchen"] })
      toast.success(station ? "Estación guardada" : "Estación creada")
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <form onSubmit={save} className="grid grid-cols-1 gap-4">
          <DialogHeader>
            <DialogTitle>{station ? station.name : "Nueva estación"}</DialogTitle>
            <DialogDescription>La cocina, la barra, la parrilla…</DialogDescription>
          </DialogHeader>
          <Field label="Nombre" htmlFor="st-name">
            <Input
              id="st-name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <fieldset className="grid min-w-0 grid-cols-1 gap-2">
            <legend className="mb-1.5 font-medium text-sm">Qué prepara</legend>
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={categoryIds.length ? "outline" : "default"}
                className="h-8 rounded-full"
                aria-pressed={!categoryIds.length}
                onClick={() => setCategoryIds([])}
              >
                {categoryIds.length ? null : <CheckIcon />} Todo lo demás
              </Button>
              {(categories.data ?? []).map((c) => {
                const on = categoryIds.includes(c.id)
                return (
                  <Button
                    key={c.id}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    className="h-8 rounded-full"
                    aria-pressed={on}
                    onClick={() =>
                      setCategoryIds((ids) => (on ? ids.filter((x) => x !== c.id) : [...ids, c.id]))
                    }
                  >
                    {on ? <CheckIcon /> : null} {c.name}
                  </Button>
                )
              })}
            </div>
            <p className="text-muted-foreground text-xs">
              «Todo lo demás»: lo que no es de las categorías de otra estación.
            </p>
          </fieldset>
          <Field label="Dónde salen las comandas" htmlFor="st-mode">
            <NativeSelect
              id="st-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as PrinterMode)}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {mode === "network" ? (
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
              <Field label="IP de la impresora" htmlFor="st-host">
                <Input
                  id="st-host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.0.60"
                />
              </Field>
              <Field label="Puerto" htmlFor="st-port">
                <Input
                  id="st-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
          ) : null}
          {mode === "windows" ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Nombre compartido" htmlFor="st-share">
                <Input id="st-share" value={share} onChange={(e) => setShare(e.target.value)} />
              </Field>
              <Field label="Equipo (si es otro)" htmlFor="st-host-win">
                <Input
                  id="st-host-win"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="localhost"
                />
              </Field>
            </div>
          ) : null}
          {mode === "device" ? (
            <Field label="Dispositivo" htmlFor="st-device">
              <Input
                id="st-device"
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                placeholder="/dev/usb/lp1"
              />
            </Field>
          ) : null}
          {mode !== "screen" ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Papel" htmlFor="st-paper">
                <NativeSelect
                  id="st-paper"
                  value={paperWidth}
                  onChange={(e) => setPaperWidth(Number(e.target.value) as 58 | 80)}
                >
                  <option value={80}>80 mm</option>
                  <option value={58}>58 mm</option>
                </NativeSelect>
              </Field>
              <Button type="button" variant="outline" disabled={busy !== null} onClick={test}>
                {busy === "test" ? "Probando…" : "Probar"}
              </Button>
            </div>
          ) : null}
          <Field
            label="Debería estar listo en (minutos)"
            htmlFor="st-target"
            hint="Pasado ese tiempo, la pantalla de cocina lo marca en rojo"
          >
            <Input
              id="st-target"
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value.replace(/\D/g, "").slice(0, 3))}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={counterSales}
              onChange={(e) => setCounterSales(e.target.checked)}
            />
            También lo que se vende en la caja (no solo lo de las mesas)
          </label>
          {station ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Activa
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy !== null}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy !== null || !name.trim()}>
              {busy === "save" ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
