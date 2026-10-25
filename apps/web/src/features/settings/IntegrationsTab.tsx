import type { ApiKey, CreatedApiKey } from "@millhiore/contracts"
import { API_KEY_PERMISSIONS, type Permission } from "@millhiore/domain"
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
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { CopyIcon, ExternalLinkIcon, KeyRoundIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime } from "../../lib/format"
import { PERMISSION_LABELS } from "../../lib/permissions"
import { apiKeysQuery, queryClient } from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { PluginsCard } from "./PluginsCard"
import { StorefrontCard } from "./StorefrontCard"
import { TelegramCard } from "./TelegramCard"
import { WebhooksCard } from "./WebhooksCard"

/** Los usos más comunes, para no marcar permiso por permiso. */
const PRESETS: { label: string; permissions: Permission[] }[] = [
  { label: "Solo leer productos", permissions: ["inventory.view"] },
  {
    label: "Tienda en línea",
    permissions: ["inventory.view", "sale.create", "contact.manage"],
  },
  { label: "Contabilidad", permissions: ["report.view", "finance.view", "cost.view"] },
]

/**
 * Integraciones: el catálogo en línea, alertas al dueño por Telegram y, para otros sistemas,
 * claves de la API y webhooks.
 */
export function IntegrationsTab() {
  const features = useFeatures()
  return (
    <div className="grid grid-cols-1 gap-4">
      {features.catalog ? <StorefrontCard /> : null}
      <TelegramCard />
      <ApiKeysCard />
      <WebhooksCard />
      <PluginsCard />
    </div>
  )
}

function ApiKeysCard() {
  const keys = useQuery(apiKeysQuery)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  const revoke = async (k: ApiKey) => {
    try {
      await api(`/api/api-keys/${k.id}/revoke`, { method: "POST" })
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] })
      toast.success(`La clave «${k.name}» ya no funciona`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setRevoking(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        {/* En el celular los botones bajan en vez de apretar el título. */}
        <div className="grid min-w-56 flex-1 gap-1.5">
          <CardTitle>Claves de la API</CardTitle>
          <CardDescription>
            Para conectar otros sistemas: una tienda en línea, la contabilidad o un script. Cada
            clave actúa como quien la crea, solo con los permisos que le des.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/api/docs" target="_blank" rel="noreferrer">
              <ExternalLinkIcon /> Documentación
            </a>
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon /> Nueva clave
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {keys.data?.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
            Todavía no hay claves.
          </p>
        ) : null}
        <ul className="divide-y rounded-lg border empty:hidden">
          {(keys.data ?? []).map((k) => (
            <li
              key={k.id}
              className={`grid grid-cols-[1fr_auto] items-start gap-2 px-3 py-2.5 text-sm ${k.revokedAt ? "opacity-60" : ""}`}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{k.name}</span>
                  <code className="text-muted-foreground text-xs">{k.prefix}…</code>
                  {k.revokedAt ? <Badge variant="outline">Revocada</Badge> : null}
                </p>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  {k.permissions.map((p) => PERMISSION_LABELS[p]).join(" · ")}
                </p>
                <p className="text-muted-foreground text-xs">
                  De {k.userName} · creada {formatDateTime(k.createdAt)} ·{" "}
                  {k.revokedAt
                    ? `revocada ${formatDateTime(k.revokedAt)}`
                    : k.lastUsedAt
                      ? `usada ${formatDateTime(k.lastUsedAt)}`
                      : "nunca usada"}
                </p>
              </div>
              {k.revokedAt ? null : revoking === k.id ? (
                <span className="flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="destructive" onClick={() => void revoke(k)}>
                    Revocar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>
                    No
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setRevoking(k.id)}>
                  Revocar…
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      {creating ? <NewKeyDialog onClose={() => setCreating(false)} /> : null}
    </Card>
  )
}

function NewKeyDialog({ onClose }: { onClose: () => void }) {
  const me = useMe()
  // Solo se puede dar lo que uno mismo tiene.
  const grantable = API_KEY_PERMISSIONS.filter((p) => can(me, p))
  const [name, setName] = useState("")
  const [chosen, setChosen] = useState<Set<Permission>>(new Set(["inventory.view"]))
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const toggle = (p: Permission) =>
    setChosen((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api<CreatedApiKey>("/api/api-keys", {
        body: { name: name.trim(), permissions: grantable.filter((p) => chosen.has(p)) },
      })
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] })
      setCreated(res)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Copiada")
    } catch {
      toast.error("No se pudo copiar: selecciónala y cópiala a mano")
    }
  }

  if (created) {
    const example = `curl -H "Authorization: Bearer ${created.secret}" ${window.location.origin}/api/products`
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clave «{created.key.name}» creada</DialogTitle>
            <DialogDescription>
              Cópiala ahora y guárdala en el otro sistema: no se vuelve a mostrar. Si se pierde,
              revócala y crea otra.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-w-0 gap-2">
            <div className="flex min-w-0 gap-2">
              <Input
                readOnly
                value={created.secret}
                aria-label="Clave"
                className="min-w-0 font-mono text-xs"
                onFocus={(e) => e.target.select()}
              />
              <Button variant="outline" onClick={() => void copy(created.secret)}>
                <CopyIcon /> Copiar
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">Ejemplo, para probarla:</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-xs">
              {example}
            </pre>
          </div>
          <DialogFooter>
            <Button onClick={onClose}>Listo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva clave de la API</DialogTitle>
          <DialogDescription>
            Actúa como tú, solo con lo que marques. Nunca puede manejar usuarios ni ajustes.
          </DialogDescription>
        </DialogHeader>
        <form id="api-key-form" onSubmit={submit} className="grid min-w-0 gap-4">
          <Field label="Para qué es" htmlFor="key-name">
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tienda en línea"
              required
              autoFocus
            />
          </Field>
          <fieldset className="grid min-w-0 gap-2">
            <legend className="mb-1.5 font-medium text-sm">Qué puede hacer</legend>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Button
                  key={p.label}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-xs"
                  onClick={() => setChosen(new Set(p.permissions.filter((x) => can(me, x))))}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
              {grantable.map((p) => (
                <label
                  key={p}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    checked={chosen.has(p)}
                    onChange={() => toggle(p)}
                  />
                  {PERMISSION_LABELS[p]}
                </label>
              ))}
            </div>
          </fieldset>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="api-key-form"
            disabled={busy || !name.trim() || chosen.size === 0}
          >
            Crear clave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
