import type { ServeResult, StorefrontSettings, StorefrontStatus } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import {
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MessageCircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { QrCode } from "../../components/QrCode"
import { api, errorMessage } from "../../lib/api"
import {
  bootstrapQuery,
  categoriesQuery,
  priceListsQuery,
  queryClient,
  storefrontQuery,
} from "../../lib/queries"

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Dirección copiada")
  } catch {
    toast.error("No se pudo copiar: selecciónala y cópiala a mano")
  }
}

/**
 * El catálogo en línea: por dónde se abre, cómo se ve y publicarlo en internet. Se publica solo
 * el puerto del catálogo, nunca la caja.
 */
export function StorefrontCard() {
  const status = useQuery(storefrontQuery)
  const st = status.data
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Catálogo en línea
            {st?.publicUrl ? <Badge variant="success">Publicado en internet</Badge> : null}
          </CardTitle>
          <CardDescription>
            Tus productos con sus fotos y sus precios en $ y Bs, para compartir por WhatsApp o
            Instagram. Lo ve cualquiera: nunca muestra costos, códigos ni cuánto hay.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          <RefreshCwIcon /> Revisar de nuevo
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-5 text-sm">
        {!st ? (
          <p className="text-muted-foreground">
            {status.isError ? errorMessage(status.error) : "Revisando…"}
          </p>
        ) : (
          <>
            <Links status={st} />
            <Publish status={st} />
            <SettingsForm key={JSON.stringify(st.settings)} settings={st.settings} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Links({ status }: { status: StorefrontStatus }) {
  const lan = status.urls[0] ?? null
  return (
    <section className="grid min-w-0 gap-3">
      <p>
        {status.products === 0
          ? "Todavía no sale ningún producto: revisa que estén activos y marcados para el catálogo."
          : `Salen ${status.products} ${status.products === 1 ? "producto" : "productos"}, ${status.withImage} con foto.`}{" "}
        <span className="text-muted-foreground">
          La foto y la descripción se ponen en cada producto; lo que no quieras mostrar se desmarca
          allí o se esconde por categoría aquí abajo.
        </span>
      </p>
      <div className="flex flex-wrap items-start gap-4">
        {lan ? <QrCode value={lan} label={`Código QR de ${lan}`} size={120} /> : null}
        <div className="grid min-w-48 flex-1 gap-2">
          <p className="font-medium">En la red del local</p>
          {lan ? <code className="break-all font-mono">{lan}</code> : null}
          <p className="text-muted-foreground text-xs">
            Para probarlo desde un celular conectado al wifi del negocio.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a href="/catalogo" target="_blank" rel="noreferrer">
                <ExternalLinkIcon /> Ver el catálogo
              </a>
            </Button>
            {lan ? (
              <Button size="sm" variant="ghost" onClick={() => void copy(lan)}>
                <CopyIcon /> Copiar
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

function Publish({ status }: { status: StorefrontStatus }) {
  const [busy, setBusy] = useState(false)
  const [approve, setApprove] = useState<string | null>(null)
  const run = async (path: "publish" | "unpublish") => {
    setBusy(true)
    try {
      const r = await api<ServeResult>(`/api/storefront/${path}`, { method: "POST" })
      setApprove(r.approveUrl)
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
      await queryClient.invalidateQueries({ queryKey: ["storefront"] })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const url = status.publicUrl
  return (
    <section className="grid min-w-0 gap-3 rounded-lg border p-3">
      <p className="flex items-center gap-2 font-medium">
        <GlobeIcon className="size-4" /> En internet
      </p>
      {url ? (
        <div className="flex flex-wrap items-start gap-4">
          <QrCode value={url} label={`Código QR de ${url}`} size={120} />
          <div className="grid min-w-48 flex-1 gap-2">
            <code className="break-all font-mono">{url}</code>
            <p className="text-muted-foreground text-xs">
              Cualquiera lo abre con este enlace mientras esta PC esté prendida. La caja no se
              publica: solo el catálogo.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void copy(url)}>
                <CopyIcon /> Copiar
              </Button>
              <Button asChild size="sm" variant="outline">
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(`Mira nuestro catálogo: ${url}`)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <MessageCircleIcon /> Compartir por WhatsApp
                </a>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run("unpublish")}
              >
                Dejar de publicarlo
              </Button>
            </div>
          </div>
        </div>
      ) : status.port === null ? (
        <p className="text-muted-foreground">
          El puerto del catálogo está apagado en este servidor (<code>CATALOG=off</code>).
        </p>
      ) : status.tailscale === "running" ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground">
            Con Tailscale Funnel el catálogo queda en una dirección https://…ts.net que abre
            cualquiera, sin abrir puertos en el router. Solo se publica el catálogo (puerto{" "}
            {status.port}), nunca la caja.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run("publish")}>
              Publicar el catálogo en internet
            </Button>
            {approve ? (
              <Button asChild size="sm" variant="outline">
                <a href={approve} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon /> Permitirlo en la cuenta
                </a>
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            O en esta PC: <code>tailscale funnel --bg --https=8443 {status.port}</code>
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground">
          Para publicarlo, instala y conecta Tailscale en esta PC (Ajustes → Equipos → Acceso
          remoto) y vuelve aquí.
        </p>
      )}
      {status.port !== null ? (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">
            Otra opción: Cloudflare Tunnel con tu dominio
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Crea un túnel en el panel de Cloudflare (Zero Trust → Redes → Túneles).</li>
            <li>
              Apúntalo a <code>http://localhost:{status.port}</code> (el del catálogo, no el de la
              caja) e instala <code>cloudflared</code> en esta PC con el comando que te da.
            </li>
          </ol>
        </details>
      ) : null}
    </section>
  )
}

function SettingsForm({ settings }: { settings: StorefrontSettings }) {
  const boot = useQuery(bootstrapQuery)
  const features = boot.data?.features
  const categories = useQuery(categoriesQuery())
  const lists = useQuery({ ...priceListsQuery(), enabled: !!features?.priceLists })
  const [form, setForm] = useState(settings)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof StorefrontSettings>(key: K, value: StorefrontSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }))
  const hidden = new Set(form.hiddenCategoryIds)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api("/api/storefront", { method: "PUT", body: form })
      await queryClient.invalidateQueries({ queryKey: ["storefront"] })
      toast.success("Catálogo guardado")
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="grid min-w-0 grid-cols-1 gap-4">
      <p className="font-medium">Cómo se ve</p>
      <Field
        label="Aviso arriba del catálogo"
        htmlFor="sf-message"
        hint="Horario, zonas de delivery, formas de pago…"
      >
        <Textarea
          id="sf-message"
          rows={2}
          maxLength={300}
          value={form.message ?? ""}
          onChange={(e) => set("message", e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="WhatsApp"
          htmlFor="sf-whatsapp"
          hint={`Vacío: el teléfono del negocio${boot.data?.business.phone ? ` (${boot.data.business.phone})` : ""}`}
        >
          <Input
            id="sf-whatsapp"
            inputMode="tel"
            maxLength={40}
            placeholder="0414-1234567"
            value={form.whatsapp ?? ""}
            onChange={(e) => set("whatsapp", e.target.value)}
          />
        </Field>
        <Field label="Precios en" htmlFor="sf-currencies">
          <NativeSelect
            id="sf-currencies"
            value={form.currencies}
            onChange={(e) => set("currencies", e.target.value as StorefrontSettings["currencies"])}
          >
            <option value="both">Dólares y bolívares</option>
            <option value="reference">Solo dólares</option>
            <option value="legal">Solo bolívares</option>
          </NativeSelect>
        </Field>
        {features?.priceLists ? (
          <Field label="Lista de precios" htmlFor="sf-list">
            <NativeSelect
              id="sf-list"
              value={form.priceListId ?? ""}
              onChange={(e) => set("priceListId", e.target.value || null)}
            >
              <option value="">El precio normal</option>
              {(lists.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        <Field label="Lo que se acabó" htmlFor="sf-soldout">
          <NativeSelect
            id="sf-soldout"
            value={form.soldOut}
            onChange={(e) => set("soldOut", e.target.value as StorefrontSettings["soldOut"])}
          >
            <option value="mark">Sale como «Agotado»</option>
            <option value="hide">No sale</option>
            <option value="ignore">Sale igual (no miro la existencia)</option>
          </NativeSelect>
        </Field>
        {features?.branches && (boot.data?.branches.length ?? 0) > 1 ? (
          <Field label="Existencia de" htmlFor="sf-branch" hint="Para saber qué se acabó">
            <NativeSelect
              id="sf-branch"
              value={form.branchId}
              onChange={(e) => set("branchId", e.target.value)}
            >
              {(boot.data?.branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
      </div>
      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1 font-medium text-sm">Pedidos</legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={form.orders}
            onChange={(e) => set("orders", e.target.checked)}
          />
          <span>
            Recibir pedidos desde el catálogo
            <span className="block text-muted-foreground text-xs">
              El cliente arma su pedido, llega a Ventas → Pedidos y te lo manda por WhatsApp.
            </span>
          </span>
        </label>
        {form.orders ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={form.delivery}
              onChange={(e) => set("delivery", e.target.checked)}
            />
            Ofrecer delivery (además de retirar en la tienda)
          </label>
        ) : null}
      </fieldset>
      {categories.data?.length ? (
        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-1 font-medium text-sm">Categorías que salen</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {categories.data.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={!hidden.has(c.id)}
                  onChange={(e) =>
                    set(
                      "hiddenCategoryIds",
                      e.target.checked
                        ? form.hiddenCategoryIds.filter((id) => id !== c.id)
                        : [...form.hiddenCategoryIds, c.id],
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <Button type="submit" className="justify-self-start" disabled={busy}>
        {busy ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  )
}
