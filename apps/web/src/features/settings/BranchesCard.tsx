import type { BranchInfo, PairingCode, SyncPeer } from "@millhiore/contracts"
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
import { PencilIcon, PlusIcon, ServerIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime, timeAgo } from "../../lib/format"
import { branchesQuery, priceListsQuery, queryClient, syncStatusQuery } from "../../lib/queries"
import { useFeatures } from "../../lib/session"

const refresh = () =>
  Promise.all(
    ["branches", "locations", "terminals", "bootstrap", "users"].map((k) =>
      queryClient.invalidateQueries({ queryKey: [k] }),
    ),
  )

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Los locales del negocio contra este servidor. Cada uno tiene sus ubicaciones y sus cajas, su
 * lista de precios y su dirección en el recibo; el personal se asigna en Usuarios.
 */
export function BranchesCard() {
  const branches = useQuery(branchesQuery({ all: true }))
  const lists = useQuery(priceListsQuery())
  const sync = useQuery(syncStatusQuery)
  const [editing, setEditing] = useState<BranchInfo | null | undefined>(undefined)
  const [connecting, setConnecting] = useState<BranchInfo | null>(null)
  const listName = (id: string | null) => lists.data?.find((l) => l.id === id)?.name
  const peerOf = (id: string) => sync.data?.peers.find((p) => p.branchId === id)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sucursales</CardTitle>
        <CardDescription>
          Cada sucursal tiene sus ubicaciones y sus cajas, su inventario, sus turnos y sus informes;
          comparten el catálogo, los clientes y las cuentas. En Usuarios se elige dónde trabaja cada
          quien.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <ul className="divide-y rounded-lg border">
          {(branches.data ?? []).map((b) => (
            <li
              key={b.id}
              className={`flex items-center gap-2 px-3 py-2 text-sm ${b.active ? "" : "opacity-60"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{b.name}</span>
                {b.active ? null : (
                  <Badge variant="outline" className="ml-2">
                    Inactiva
                  </Badge>
                )}
                <span className="block text-muted-foreground text-xs">
                  {plural(b.locations, "ubicación", "ubicaciones")} ·{" "}
                  {plural(b.terminals, "caja", "cajas")}
                  {b.priceListId ? ` · precios ${listName(b.priceListId) ?? ""}` : ""}
                  {b.address ? ` · ${b.address}` : ""}
                </span>
                <PeerLine peer={peerOf(b.id)} />
              </span>
              {b.id !== "main" && b.active ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Servidor propio de ${b.name}`}
                  title="Servidor propio"
                  onClick={() => setConnecting(b)}
                >
                  <ServerIcon />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Editar ${b.name}`}
                title="Editar"
                onClick={() => setEditing(b)}
              >
                <PencilIcon />
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="outline" className="justify-self-start" onClick={() => setEditing(null)}>
          <PlusIcon /> Nueva sucursal
        </Button>
      </CardContent>
      {editing !== undefined ? (
        <BranchDialog branch={editing} onClose={() => setEditing(undefined)} />
      ) : null}
      {connecting ? (
        <ConnectDialog
          branch={connecting}
          peer={peerOf(connecting.id)}
          onClose={() => setConnecting(null)}
        />
      ) : null}
    </Card>
  )
}

/** Si la sucursal tiene su propio servidor, cuándo se supo de él por última vez. */
function PeerLine({ peer }: { peer: SyncPeer | undefined }) {
  if (!peer) return null
  // Una vuelta cada 30 s: más de 5 minutos sin saber de ella es que está apagada o sin red.
  const late = !peer.lastSeenAt || Date.now() - peer.lastSeenAt > 5 * 60_000
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
      <Badge variant={late ? "outline" : "secondary"}>Servidor propio</Badge>
      <span className="text-muted-foreground">
        {peer.name} ·{" "}
        {peer.lastSeenAt ? `visto ${timeAgo(peer.lastSeenAt)}` : "todavía no se conecta"}
      </span>
    </span>
  )
}

/**
 * Conectar el servidor de una sucursal: un código de una hora que se escribe en la PC de allá al
 * instalar la app («Unir esta PC como sucursal»). Desde entonces se vende allá, no aquí.
 */
function ConnectDialog({
  branch,
  peer,
  onClose,
}: {
  branch: BranchInfo
  peer: SyncPeer | undefined
  onClose: () => void
}) {
  const [pairing, setPairing] = useState<PairingCode | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      setPairing(await api<PairingCode>("/api/sync/codes", { body: { branchId: branch.id } }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await api(`/api/sync/peers/${branch.id}`, { method: "DELETE" })
      await queryClient.invalidateQueries({ queryKey: ["sync"] })
      toast.success(`${branch.name} ya no tiene servidor propio: se vuelve a vender desde aquí`)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Servidor propio de {branch.name}</DialogTitle>
          <DialogDescription>
            Para una sucursal con su propia PC: vende aunque se corte internet, y lo que registra
            llega aquí solo. Desde aquí se manejan el catálogo, los clientes, los usuarios y los
            ajustes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3 text-sm">
          {peer ? (
            <p className="rounded-lg border bg-muted/40 p-3">
              Conectada con <span className="font-medium">{peer.name}</span> desde el{" "}
              {formatDateTime(peer.pairedAt)} · {peer.documentsReceived}{" "}
              {peer.documentsReceived === 1 ? "documento recibido" : "documentos recibidos"}.
              Conectar otra PC reemplaza a esta.
            </p>
          ) : null}
          {pairing ? (
            <>
              <div className="grid gap-1 rounded-lg border p-3 text-center">
                <span className="text-muted-foreground text-xs">Código (vale una hora)</span>
                <span
                  className="font-mono font-semibold text-2xl tracking-wider"
                  data-testid="pairing-code"
                >
                  {pairing.code}
                </span>
              </div>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>
                  Instala la app en la PC de {branch.name} y enciende Tailscale con la misma cuenta.
                </li>
                <li>En el asistente inicial, toca «Unir esta PC como sucursal».</li>
                <li>
                  Escribe la dirección de esta PC y el código.
                  {pairing.urls.length ? (
                    <span className="mt-1 grid gap-0.5">
                      {pairing.urls.map((u) => (
                        <code key={u} className="break-all font-mono text-xs">
                          {u}
                        </code>
                      ))}
                    </span>
                  ) : (
                    <span className="mt-1 block text-muted-foreground text-xs">
                      Enciende Tailscale en esta PC para ver su dirección (Ajustes → Equipos).
                    </span>
                  )}
                </li>
              </ol>
              <p className="text-muted-foreground text-xs">
                Desde que se une, sus cajas venden allá (aquí ya no se abre turno en ellas).
              </p>
            </>
          ) : null}
        </div>
        <DialogFooter className="flex-wrap gap-2">
          {peer ? (
            <Button variant="outline" onClick={() => void disconnect()} disabled={busy}>
              Desconectar
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
          {pairing ? null : (
            <Button onClick={() => void create()} disabled={busy}>
              {busy ? "Creando…" : peer ? "Conectar otra PC" : "Crear código"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BranchDialog({ branch, onClose }: { branch: BranchInfo | null; onClose: () => void }) {
  const features = useFeatures()
  const lists = useQuery({ ...priceListsQuery(), enabled: features.priceLists })
  const [name, setName] = useState(branch?.name ?? "")
  const [address, setAddress] = useState(branch?.address ?? "")
  const [phone, setPhone] = useState(branch?.phone ?? "")
  const [priceListId, setPriceListId] = useState(branch?.priceListId ?? "")
  const [active, setActive] = useState(branch?.active ?? true)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const body = {
      name: name.trim(),
      address: address.trim() || null,
      phone: phone.trim() || null,
      priceListId: priceListId || null,
    }
    try {
      if (branch) {
        await api(`/api/branches/${branch.id}`, { method: "PATCH", body: { ...body, active } })
      } else {
        await api("/api/branches", { body })
      }
      await refresh()
      toast.success(
        branch
          ? "Sucursal guardada"
          : `Sucursal «${body.name}» creada con su tienda y su caja: elige esa caja en el equipo de allá`,
      )
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
          <DialogTitle>{branch ? `Editar ${branch.name}` : "Nueva sucursal"}</DialogTitle>
          <DialogDescription>
            {branch
              ? "Su dirección y su teléfono salen en el recibo de lo que se vende allí."
              : "Llega con su tienda y su primera caja, lista para abrir el turno y vender."}
          </DialogDescription>
        </DialogHeader>
        <form id="branch-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Nombre" htmlFor="branch-name">
            <Input
              id="branch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Centro"
              required
              autoFocus
              maxLength={60}
            />
          </Field>
          <Field
            label="Dirección"
            htmlFor="branch-address"
            hint="Vacía, la del negocio. Sale en el recibo."
          >
            <Input
              id="branch-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="Teléfono" htmlFor="branch-phone" hint="Vacío, el del negocio.">
            <Input
              id="branch-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              inputMode="tel"
            />
          </Field>
          {features.priceLists ? (
            <Field
              label="Precios"
              htmlFor="branch-list"
              hint="Una lista de precios propia para esta sucursal (un cliente con la suya la usa igual)."
            >
              <NativeSelect
                id="branch-list"
                value={priceListId}
                onChange={(e) => setPriceListId(e.target.value)}
              >
                <option value="">Precio base</option>
                {(lists.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          {branch ? (
            <div className="flex items-start gap-3">
              <input
                id="branch-active"
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              <div className="grid gap-1">
                <Label htmlFor="branch-active">Activa</Label>
                <p className="text-muted-foreground text-xs">
                  Para desactivarla, desactiva antes sus cajas. Lo registrado en ella no cambia.
                </p>
              </div>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="branch-form" disabled={busy || !name.trim()}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
