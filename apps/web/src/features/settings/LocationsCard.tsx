import type { LocationKind, StockLocation, TerminalInfo } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PencilIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { TerminalPicker } from "../../components/TerminalPicker"
import { api, errorMessage } from "../../lib/api"
import { LOCATION_KIND_LABEL } from "../../lib/locations"
import { bootstrapQuery, locationsQuery, queryClient, terminalsQuery } from "../../lib/queries"

const refresh = () =>
  Promise.all(
    ["locations", "terminals", "bootstrap", "products"].map((k) =>
      queryClient.invalidateQueries({ queryKey: [k] }),
    ),
  )

const KINDS = Object.entries(LOCATION_KIND_LABEL) as [LocationKind, string][]

/**
 * Ubicaciones (tienda, depósito, cocina, otra tienda) y cajas. Cada caja vende de la existencia de
 * su ubicación y abre y cierra su propio turno con su gaveta; en cada equipo se elige cuál es.
 */
export function LocationsCard() {
  const boot = useQuery(bootstrapQuery)
  const locations = useQuery(locationsQuery({ all: true }))
  const terminals = useQuery(terminalsQuery({ all: true }))
  const [location, setLocation] = useState<StockLocation | null | undefined>(undefined)
  const [terminal, setTerminal] = useState<TerminalInfo | null | undefined>(undefined)
  const active = (locations.data ?? []).filter((l) => l.active)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ubicaciones y cajas</CardTitle>
        <CardDescription>
          Dónde está la mercancía y desde dónde se vende. Las compras y los ajustes eligen la
          ubicación; la mercancía pasa de una a otra con un traslado (Inventario → Traslados).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <section className="grid content-start gap-2">
          <h3 className="font-medium text-sm">Ubicaciones</h3>
          <ul className="divide-y rounded-lg border">
            {(locations.data ?? []).map((l) => (
              <li
                key={l.id}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${l.active ? "" : "opacity-60"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{l.name}</span>
                  {l.active ? null : (
                    <Badge variant="outline" className="ml-2">
                      Inactiva
                    </Badge>
                  )}
                  <span className="block text-muted-foreground text-xs">
                    {LOCATION_KIND_LABEL[l.kind]} · {l.productsInStock} producto
                    {l.productsInStock === 1 ? "" : "s"} con existencia
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Editar ${l.name}`}
                  title="Editar"
                  onClick={() => setLocation(l)}
                >
                  <PencilIcon />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() => setLocation(null)}
          >
            <PlusIcon /> Nueva ubicación
          </Button>
        </section>

        <section className="grid content-start gap-2">
          <h3 className="font-medium text-sm">Cajas</h3>
          <ul className="divide-y rounded-lg border">
            {(terminals.data ?? []).map((t) => (
              <li
                key={t.id}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${t.active ? "" : "opacity-60"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{t.name}</span>{" "}
                  <span className="text-muted-foreground text-xs">({t.code})</span>
                  {t.shiftOpen ? (
                    <Badge variant="secondary" className="ml-2">
                      Turno abierto
                    </Badge>
                  ) : null}
                  {t.active ? null : (
                    <Badge variant="outline" className="ml-2">
                      Inactiva
                    </Badge>
                  )}
                  <span className="block text-muted-foreground text-xs">
                    Vende desde {t.locationName}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Editar ${t.name}`}
                  title="Editar"
                  onClick={() => setTerminal(t)}
                >
                  <PencilIcon />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() => setTerminal(null)}
            disabled={active.length === 0}
          >
            <PlusIcon /> Nueva caja
          </Button>
          {boot.data && boot.data.terminals.length > 1 ? (
            <Field
              label="Este equipo es"
              htmlFor="this-terminal"
              hint="Se recuerda en este navegador; en cada celular o PC se elige su caja."
            >
              <TerminalPicker boot={boot.data} id="this-terminal" className="w-full" />
            </Field>
          ) : null}
        </section>
      </CardContent>
      {location !== undefined ? (
        <LocationDialog location={location} onClose={() => setLocation(undefined)} />
      ) : null}
      {terminal !== undefined ? (
        <TerminalDialog
          terminal={terminal}
          locations={active}
          onClose={() => setTerminal(undefined)}
        />
      ) : null}
    </Card>
  )
}

function LocationDialog({
  location,
  onClose,
}: {
  location: StockLocation | null
  onClose: () => void
}) {
  const [name, setName] = useState(location?.name ?? "")
  const [kind, setKind] = useState<LocationKind>(location?.kind ?? "warehouse")
  const [active, setActive] = useState(location?.active ?? true)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      if (location) {
        await api(`/api/locations/${location.id}`, {
          method: "PATCH",
          body: { name: name.trim(), kind, active },
        })
      } else {
        await api("/api/locations", { body: { name: name.trim(), kind } })
      }
      await refresh()
      toast.success(location ? "Ubicación guardada" : `Ubicación «${name.trim()}» creada`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{location ? "Editar ubicación" : "Nueva ubicación"}</DialogTitle>
          <DialogDescription>
            Un sitio donde se guarda mercancía: el depósito, la cocina, otra tienda.
          </DialogDescription>
        </DialogHeader>
        <form id="location-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Nombre" htmlFor="loc-name">
            <Input
              id="loc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Depósito"
              required
              autoFocus
              maxLength={60}
            />
          </Field>
          <Field label="Tipo" htmlFor="loc-kind">
            <NativeSelect
              id="loc-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as LocationKind)}
            >
              {KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {location ? (
            <div className="flex items-start gap-3">
              <input
                id="loc-active"
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              <div className="grid gap-1">
                <Label htmlFor="loc-active">Activa</Label>
                <p className="text-muted-foreground text-xs">
                  Para desactivarla no puede tener existencia ni una caja que venda desde ella.
                </p>
              </div>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="location-form" disabled={busy || !name.trim()}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TerminalDialog({
  terminal,
  locations,
  onClose,
}: {
  terminal: TerminalInfo | null
  locations: StockLocation[]
  onClose: () => void
}) {
  const [name, setName] = useState(terminal?.name ?? "")
  const [locationId, setLocationId] = useState(terminal?.locationId ?? locations[0]?.id ?? "")
  const [active, setActive] = useState(terminal?.active ?? true)
  const [busy, setBusy] = useState(false)
  // Una caja desactivada puede estar en una ubicación que ya no está activa.
  const options =
    terminal && !locations.some((l) => l.id === terminal.locationId)
      ? [{ id: terminal.locationId, name: terminal.locationName }, ...locations]
      : locations

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      if (terminal) {
        await api(`/api/terminals/${terminal.id}`, {
          method: "PATCH",
          body: { name: name.trim(), locationId, active },
        })
      } else {
        await api("/api/terminals", { body: { name: name.trim(), locationId } })
      }
      await refresh()
      toast.success(terminal ? "Caja guardada" : `Caja «${name.trim()}» creada`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{terminal ? `Editar ${terminal.name}` : "Nueva caja"}</DialogTitle>
          <DialogDescription>
            {terminal
              ? `Sus documentos llevan el prefijo ${terminal.code}.`
              : "Vende de la existencia de su ubicación y cuenta su propia gaveta en cada turno."}
          </DialogDescription>
        </DialogHeader>
        <form id="terminal-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Nombre" htmlFor="term-name">
            <Input
              id="term-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Caja 2"
              required
              autoFocus
              maxLength={60}
            />
          </Field>
          <Field
            label="Vende desde"
            htmlFor="term-location"
            hint={terminal?.shiftOpen ? "Cierra su turno para cambiarla de ubicación." : undefined}
          >
            <NativeSelect
              id="term-location"
              value={locationId}
              disabled={terminal?.shiftOpen}
              onChange={(e) => setLocationId(e.target.value)}
            >
              {options.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {terminal ? (
            <div className="flex items-start gap-3">
              <input
                id="term-active"
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={active}
                disabled={terminal.shiftOpen}
                onChange={(e) => setActive(e.target.checked)}
              />
              <div className="grid gap-1">
                <Label htmlFor="term-active">Activa</Label>
                <p className="text-muted-foreground text-xs">
                  Lo ya registrado en ella no cambia. Tiene que quedar al menos una caja activa.
                </p>
              </div>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="terminal-form" disabled={busy || !name.trim() || !locationId}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
