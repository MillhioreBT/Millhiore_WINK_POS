import type { PluginInfo, PluginManifest } from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
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
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { strFromU8, unzipSync } from "fflate"
import { PuzzleIcon, ScrollTextIcon, ShieldAlertIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime } from "../../lib/format"
import { PERMISSION_LABELS } from "../../lib/permissions"
import { pluginLogsQuery, pluginsQuery, queryClient } from "../../lib/queries"
import { EVENT_LABELS } from "./WebhooksCard"

const refresh = () => queryClient.invalidateQueries({ queryKey: ["plugins"] })

const permissionLabel = (p: string) => PERMISSION_LABELS[p as Permission] ?? p
const eventLabel = (e: string) => EVENT_LABELS[e as keyof typeof EVENT_LABELS] ?? e

/** El manifiesto del .zip, leído en el navegador para mostrar qué pide antes de instalarlo. */
function readManifest(bytes: Uint8Array): PluginManifest {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: (f) => f.name.endsWith("manifest.json") })
  } catch {
    throw new Error("No es un .zip válido")
  }
  const entry =
    files["manifest.json"] ?? Object.entries(files).find(([n]) => n.split("/").length === 2)?.[1]
  if (!entry) throw new Error("El .zip no trae manifest.json: no es un plugin")
  try {
    return JSON.parse(strFromU8(entry)) as PluginManifest
  } catch {
    throw new Error("manifest.json no es un JSON válido")
  }
}

/**
 * Plugins: paquetes que agregan funciones. Corren aislados, con los permisos que se les dan al
 * instalarlos, a nombre de quien los instala.
 */
export function PluginsCard() {
  const plugins = useQuery(pluginsQuery)
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ file: File; manifest: PluginManifest } | null>(null)
  const [logsOf, setLogsOf] = useState<PluginInfo | null>(null)
  const [removing, setRemoving] = useState<PluginInfo | null>(null)
  // Lo que se acaba de marcar se ve al instante, mientras el servidor lo carga o lo detiene.
  const [switching, setSwitching] = useState<Record<string, boolean>>({})

  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = ""
    if (!file) return
    try {
      setPending({ file, manifest: readManifest(new Uint8Array(await file.arrayBuffer())) })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const toggle = async (p: PluginInfo, enabled: boolean) => {
    setSwitching((s) => ({ ...s, [p.id]: enabled }))
    try {
      await api(`/api/plugins/${p.id}`, { method: "PATCH", body: { enabled } })
      await refresh()
      toast.success(`${p.name}: ${enabled ? "encendido" : "apagado"}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSwitching(({ [p.id]: _, ...rest }) => rest)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <CardTitle>Plugins</CardTitle>
          <CardDescription>
            Paquetes que agregan funciones a la app. Corren aislados: solo pueden lo que les des al
            instalarlos. Instala solo plugins de quien confíes.
          </CardDescription>
        </div>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          aria-label="Archivo del plugin"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <Button size="sm" onClick={() => input.current?.click()}>
          <UploadIcon /> Instalar plugin
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3 text-sm">
        {plugins.data?.length ? (
          <ul className="divide-y rounded-lg border">
            {plugins.data.map((p) => (
              <li
                key={p.id}
                className={`grid gap-1.5 px-3 py-2.5 ${p.enabled ? "" : "opacity-70"}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <PuzzleIcon className="size-4 text-muted-foreground" />
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {p.version}
                    {p.author ? ` · ${p.author}` : ""}
                  </span>
                  {!p.enabled ? (
                    <Badge variant="outline">Apagado</Badge>
                  ) : p.running ? null : (
                    <Badge variant="destructive">No corre</Badge>
                  )}
                  <label className="ml-auto flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={switching[p.id] ?? p.enabled}
                      disabled={p.id in switching}
                      onChange={(e) => void toggle(p, e.target.checked)}
                      aria-label={`Encender ${p.name}`}
                    />
                    Encendido
                  </label>
                </div>
                {p.description ? <p className="text-muted-foreground">{p.description}</p> : null}
                <p className="text-muted-foreground text-xs">
                  {p.permissions.length
                    ? `Puede: ${p.permissions.map(permissionLabel).join(", ")}.`
                    : "No usa la API."}
                  {p.events.length ? ` Recibe: ${p.events.map(eventLabel).join(", ")}.` : ""}
                  {p.network.length ? ` Se conecta a: ${p.network.join(", ")}.` : ""}
                  {p.page ? ` Pantalla: «${p.page.title}» en el menú.` : ""}
                </p>
                {p.lastError ? (
                  <p className="text-destructive text-xs">
                    {p.lastErrorAt ? `${formatDateTime(p.lastErrorAt)}: ` : ""}
                    {p.lastError}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setLogsOf(p)}>
                    <ScrollTextIcon /> Registro
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(p)}>
                    <Trash2Icon /> Desinstalar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            {plugins.isPending ? "Cargando…" : "No hay plugins instalados."}
          </p>
        )}
      </CardContent>
      {pending ? (
        <InstallDialog
          file={pending.file}
          manifest={pending.manifest}
          current={plugins.data?.find((p) => p.id === pending.manifest.id) ?? null}
          onClose={() => setPending(null)}
        />
      ) : null}
      {logsOf ? <LogsDialog plugin={logsOf} onClose={() => setLogsOf(null)} /> : null}
      {removing ? <RemoveDialog plugin={removing} onClose={() => setRemoving(null)} /> : null}
    </Card>
  )
}

function InstallDialog({
  file,
  manifest,
  current,
  onClose,
}: {
  file: File
  manifest: PluginManifest
  current: PluginInfo | null
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const permissions = manifest.permissions ?? []
  const events = manifest.events ?? []
  const network = manifest.network ?? []
  const added = current ? permissions.filter((p) => !current.permissions.includes(p)) : []
  const install = async () => {
    setBusy(true)
    try {
      await api("/api/plugins", { body: new Blob([file], { type: "application/zip" }) })
      await refresh()
      toast.success(current ? `${manifest.name} actualizado` : `${manifest.name} instalado`)
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
          <DialogTitle>
            {current ? "Actualizar" : "Instalar"} {manifest.name}
          </DialogTitle>
          <DialogDescription>
            {current
              ? `De la versión ${current.version} a la ${manifest.version}.`
              : `Versión ${manifest.version}${manifest.author ? `, de ${manifest.author}` : ""}.`}
          </DialogDescription>
        </DialogHeader>
        {manifest.description ? <p className="text-sm">{manifest.description}</p> : null}
        <div className="grid gap-3 text-sm">
          <section className="grid gap-1">
            <p className="font-medium">Podrá</p>
            {permissions.length ? (
              <ul className="list-disc pl-5">
                {permissions.map((p) => (
                  <li key={p}>
                    {permissionLabel(p)}
                    {added.includes(p) ? (
                      <Badge variant="warning" className="ml-2">
                        Nuevo
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">Nada de la API: solo sus propias cosas.</p>
            )}
            <p className="text-muted-foreground text-xs">
              Siempre como mucho lo que tú puedes: actúa a tu nombre.
            </p>
          </section>
          {events.length ? (
            <section className="grid gap-1">
              <p className="font-medium">Recibirá</p>
              <p>{events.map(eventLabel).join(", ")}</p>
            </section>
          ) : null}
          {network.length ? (
            <section className="grid gap-1">
              <p className="font-medium">Se conectará a</p>
              <p className="break-all font-mono">{network.join(", ")}</p>
            </section>
          ) : null}
          {manifest.page ? (
            <p>
              Agrega la pantalla <span className="font-medium">«{manifest.page.title}»</span> al
              menú.
            </p>
          ) : null}
          <p className="flex items-start gap-2 text-warning-foreground text-xs dark:text-warning">
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
            Instala solo plugins de quien confíes: con estos permisos puede ver y registrar lo que
            dicen arriba.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={() => void install()} disabled={busy}>
            {busy ? "Instalando…" : current ? "Actualizar" : "Instalar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LogsDialog({ plugin, onClose }: { plugin: PluginInfo; onClose: () => void }) {
  const logs = useQuery(pluginLogsQuery(plugin.id))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Registro de {plugin.name}</DialogTitle>
          <DialogDescription>
            Lo último que hizo, de lo más nuevo a lo más viejo (se borra al reiniciar el servidor).
          </DialogDescription>
        </DialogHeader>
        {logs.data?.length ? (
          <ul className="grid max-h-96 gap-1 overflow-y-auto font-mono text-xs">
            {logs.data.map((l) => (
              <li
                key={`${l.at}-${l.message}`}
                className={l.level === "error" ? "text-destructive" : undefined}
              >
                <span className="text-muted-foreground">{formatDateTime(l.at)}</span>{" "}
                <span className="break-words">{l.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Todavía no registró nada.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RemoveDialog({ plugin, onClose }: { plugin: PluginInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try {
      await api(`/api/plugins/${plugin.id}`, { method: "DELETE" })
      await refresh()
      toast.success(`${plugin.name} desinstalado`)
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
          <DialogTitle>Desinstalar {plugin.name}</DialogTitle>
          <DialogDescription>
            Se borra con lo que guardó. Lo que registró en la app (ventas, productos…) no cambia.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
            Desinstalar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
