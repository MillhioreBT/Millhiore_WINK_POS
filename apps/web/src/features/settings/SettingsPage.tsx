import type { Backup, BackupList, BusinessProfile, PrinterSettings } from "@millhiore/contracts"
import { passwordProblem } from "@millhiore/domain"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@millhiore/ui"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { useSearch } from "@tanstack/react-router"
import {
  DatabaseBackupIcon,
  DownloadIcon,
  HistoryIcon,
  KeyRoundIcon,
  PencilIcon,
  PrinterIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { ApiError, api, errorMessage } from "../../lib/api"
import { formatDateTime, formatPercent, formatRate } from "../../lib/format"
import {
  bootstrapQuery,
  fiscalQuery,
  queryClient,
  rateStatusQuery,
  ratesHistoryQuery,
  rolesQuery,
  type Tax,
  taxesQuery,
  type UserRow,
  usersQuery,
} from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { SessionsPanel } from "../account/SessionsPanel"
import { EditUserDialog, ResetPasswordDialog } from "../account/UserDialogs"
import { BusinessHeader } from "../sales/ReceiptDialog"
import { AuditTab } from "./AuditTab"
import { ChargesCard } from "./ChargesCard"
import { FeaturesCard } from "./FeaturesCard"
import { LocationsCard } from "./LocationsCard"

const SOURCE: Record<string, string> = {
  bcv: "BCV",
  dolarapi: "BCV (espejo dolarapi)",
  manual: "Manual",
}

/** "877,9023" o "1.018,5" → "877.9023" / "1018.5"; null si no es un número. */
function parseRateText(text: string): string | null {
  const t = text.trim()
  const normalized = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t
  return /^\d{1,12}(\.\d{1,8})?$/.test(normalized) && Number(normalized) > 0 ? normalized : null
}

/** "16" o "16,5" → centésimas de punto (1600 / 1650). */
function parsePercent(text: string): number | null {
  const n = Number(text.trim().replace(",", "."))
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null
}

function RateTab({ editable }: { editable: boolean }) {
  const status = useQuery(rateStatusQuery)
  const history = useQuery(ratesHistoryQuery)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["rates"] }),
      queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
    ])

  const refresh = async () => {
    setBusy(true)
    try {
      const r = await api<{
        ok: boolean
        error: string | null
        recorded: unknown[]
        source: string | null
      }>("/api/rates/refresh", { body: {} })
      if (r.ok)
        toast.success(
          r.recorded.length
            ? `Tasa actualizada (${SOURCE[r.source ?? ""] ?? r.source})`
            : "La tasa ya estaba al día",
        )
      else toast.error(`No se pudo consultar: ${r.error ?? "error desconocido"}`)
      await refreshAll()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveManual = async (e: React.FormEvent) => {
    e.preventDefault()
    const v = parseRateText(value)
    if (!v) {
      toast.error("Escribe la tasa, p. ej. 877,9023")
      return
    }
    try {
      await api("/api/rates", { body: { value: v } })
      toast.success("Tasa manual guardada; rige desde ahora")
      setValue("")
      await refreshAll()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const current = status.data?.current
  const last = status.data?.lastCheck
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription>Tasa vigente</CardDescription>
          <CardTitle className="tabular text-3xl">
            {current ? `${formatRate(current.value)} Bs/${current.base}` : "Sin tasa"}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 text-sm">
          {current ? (
            <p className="text-muted-foreground">
              Fuente: {SOURCE[current.source] ?? current.source} · vigente desde{" "}
              {formatDateTime(current.effectiveAt)}
            </p>
          ) : null}
          {status.data?.stale ? (
            <Badge variant="warning">Desactualizada: revisa la conexión o cárgala a mano</Badge>
          ) : null}
          {last ? (
            <p className="text-muted-foreground">
              Última consulta automática: {formatDateTime(last.at)} ·{" "}
              {last.ok ? "correcta" : `falló (${last.error ?? "sin detalle"})`}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            El servidor consulta el BCV al arrancar y cada 2 horas. El BCV publica en la tarde la
            tasa que rige al día siguiente.
          </p>
          {editable ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" onClick={refresh} disabled={busy}>
                <RefreshCwIcon className={busy ? "animate-spin" : ""} /> Consultar BCV ahora
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {editable ? (
        <Card>
          <CardHeader>
            <CardTitle>Tasa manual</CardTitle>
            <CardDescription>
              Para cuando no hay internet o el BCV no responde. Rige desde ahora y queda auditada.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveManual} className="flex items-end gap-2">
              <Field label="Bs por dólar" htmlFor="manual-rate" className="flex-1">
                <Input
                  id="manual-rate"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="877,9023"
                  className="tabular"
                />
              </Field>
              <Button type="submit">Guardar</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Historial</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vigente desde</TableHead>
                <TableHead>Par</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead>Fuente</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(history.data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.effectiveAt)}</TableCell>
                  <TableCell>
                    {r.base}/{r.quote}
                  </TableCell>
                  <TableCell className="tabular text-right">{formatRate(r.value)}</TableCell>
                  <TableCell>{SOURCE[r.source] ?? r.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

const surchargesQuery = queryOptions({
  queryKey: ["surcharges"],
  queryFn: () =>
    api<{ id: string; code: string; name: string; rateBp: number; active: boolean }[]>(
      "/api/surcharges",
    ),
})

function RateEditor({
  rateBp,
  disabled,
  onSave,
}: {
  rateBp: number
  disabled?: boolean
  onSave: (rateBp: number) => Promise<void>
}) {
  const [text, setText] = useState(String(rateBp / 100).replace(".", ","))
  const parsed = parsePercent(text)
  return (
    <form
      className="flex items-center justify-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        if (parsed !== null) await onSave(parsed)
      }}
    >
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="tabular h-8 w-20 text-right"
        inputMode="decimal"
        disabled={disabled}
        aria-label="Alícuota en %"
      />
      <span className="text-muted-foreground">%</span>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={disabled || parsed === null || parsed === rateBp}
      >
        Guardar
      </Button>
    </form>
  )
}

function TaxesTab() {
  const bootFeatures = useFeatures()
  const fiscal = useQuery(fiscalQuery)
  const taxes = useQuery(taxesQuery)
  const surcharges = useQuery(surchargesQuery)
  const invalidate = () =>
    Promise.all(
      ["fiscal", "taxes", "surcharges", "bootstrap", "products"].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    )

  const saveFiscal = async (patch: Record<string, unknown>) => {
    try {
      await api("/api/settings/fiscal", { method: "PUT", body: patch })
      toast.success("Configuración fiscal guardada")
      await invalidate()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const patchRate = (path: string) => async (rateBp: number) => {
    try {
      await api(path, { method: "PATCH", body: { rateBp } })
      toast.success("Alícuota guardada. Las ventas ya hechas no cambian.")
      await invalidate()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const f = fiscal.data
  const KIND: Record<Tax["kind"], string> = {
    taxed: "Gravado",
    exempt: "Exento",
    exonerated: "Exonerado",
    not_subject: "No sujeto",
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Condición fiscal</CardTitle>
          <CardDescription>
            Detalles y fuentes en docs/fiscal-venezuela.md. Ante la duda, consulta a tu contador.
          </CardDescription>
        </CardHeader>
        {f ? (
          <CardContent className="grid grid-cols-1 gap-4">
            <Field
              label="Ante el SENIAT soy"
              htmlFor="f-taxpayer"
              hint="Al pasar a sujeto pasivo especial, los cobros en divisas (efectivo $, Zelle) empiezan a llevar IGTF."
            >
              <NativeSelect
                id="f-taxpayer"
                value={f.taxpayer}
                onChange={(e) => saveFiscal({ taxpayer: e.target.value })}
              >
                <option value="ordinary">Contribuyente ordinario (cobra IVA)</option>
                <option value="special">Sujeto pasivo especial (IVA + IGTF)</option>
                <option value="none">No cobro IVA</option>
              </NativeSelect>
            </Field>
            <div className="flex items-start gap-3">
              <input
                id="f-incl"
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={f.pricesIncludeTax}
                onChange={(e) => saveFiscal({ pricesIncludeTax: e.target.checked })}
              />
              <div className="grid grid-cols-1 gap-1">
                <Label htmlFor="f-incl">Mis precios de venta ya incluyen el IVA</Label>
                <p className="text-muted-foreground text-xs">
                  Si lo desmarcas, el IVA se suma al cobrar.
                </p>
              </div>
            </div>
            <Field label="IVA por defecto de los productos" htmlFor="f-default">
              <NativeSelect
                id="f-default"
                value={f.defaultTaxId}
                onChange={(e) => saveFiscal({ defaultTaxId: e.target.value })}
              >
                {(taxes.data ?? [])
                  .filter((t) => t.active)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} {t.kind === "taxed" ? formatPercent(t.rateBp) : ""}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </CardContent>
        ) : null}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Alícuotas</CardTitle>
          <CardDescription>
            Si la ley cambia, se editan aquí. Cada venta guarda la que aplicó.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Alícuota</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(taxes.data ?? []).map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.code}</TableCell>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>{KIND[t.kind]}</TableCell>
                  <TableCell>
                    <RateEditor
                      rateBp={t.rateBp}
                      disabled={t.kind !== "taxed"}
                      onSave={patchRate(`/api/taxes/${t.id}`)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {(surcharges.data ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.code}</TableCell>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>Recargo</TableCell>
                  <TableCell>
                    <RateEditor rateBp={s.rateBp} onSave={patchRate(`/api/surcharges/${s.id}`)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {bootFeatures.charges ? <ChargesCard canManage /> : null}
    </div>
  )
}

function UsersTab() {
  const me = useMe()
  const users = useQuery(usersQuery)
  const roles = useQuery(rolesQuery)
  const [form, setForm] = useState({ name: "", username: "", password: "", roleId: "cashier" })
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [resetting, setResetting] = useState<UserRow | null>(null)
  const roleName = (id: string | null) => roles.data?.find((r) => r.id === id)?.name ?? id ?? "—"

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api("/api/users", { body: { ...form, username: form.username.trim().toLowerCase() } })
      toast.success(`Usuario ${form.username} creado`)
      setForm({ name: "", username: "", password: "", roleId: form.roleId })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden sm:table-cell">Usuario</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead className="hidden md:table-cell">Estado</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users.data ?? []).map((u) => (
                <TableRow key={u.id} className={u.active ? "" : "opacity-60"}>
                  <TableCell className="whitespace-normal font-medium">
                    {u.name}
                    <span className="block font-normal text-muted-foreground text-xs sm:hidden">
                      {u.username}
                    </span>
                    {u.mustChangePassword ? (
                      <Badge
                        variant="warning"
                        className="ml-2"
                        title="Debe elegir la suya al entrar"
                      >
                        Clave temporal
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{u.username}</TableCell>
                  <TableCell>{roleName(u.roleId)}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {u.active ? (
                      <Badge variant="success">Activo</Badge>
                    ) : (
                      <Badge variant="outline">Inactivo</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5 sm:gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 sm:px-3"
                        aria-label={`Editar a ${u.name}`}
                        title="Editar"
                        onClick={() => setEditing(u)}
                      >
                        <PencilIcon /> <span className="hidden lg:inline">Editar</span>
                      </Button>
                      {u.id !== me.id ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2 sm:px-3"
                          aria-label={`Restablecer la contraseña de ${u.name}`}
                          title="Restablecer contraseña"
                          onClick={() => setResetting(u)}
                        >
                          <KeyRoundIcon /> <span className="hidden lg:inline">Contraseña</span>
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {editing ? <EditUserDialog target={editing} onClose={() => setEditing(null)} /> : null}
      {resetting ? (
        <ResetPasswordDialog target={resetting} onClose={() => setResetting(null)} />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Nuevo usuario</CardTitle>
          <CardDescription>Un cajero puede vender, pero no anular ni ver ajustes.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid grid-cols-1 gap-3">
            <Field label="Nombre" htmlFor="u-name">
              <Input
                id="u-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
            <Field label="Usuario" htmlFor="u-user" hint="Minúsculas, números, punto o guion bajo">
              <Input
                id="u-user"
                autoCapitalize="none"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
              />
            </Field>
            <Field
              label="Contraseña"
              htmlFor="u-pass"
              hint="Mínimo 8 caracteres"
              error={
                form.password
                  ? passwordProblem(form.password, {
                      username: form.username,
                      name: form.name,
                      businessName: null,
                    })
                  : null
              }
            >
              <Input
                id="u-pass"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                minLength={8}
                required
              />
            </Field>
            <Field label="Rol" htmlFor="u-role">
              <NativeSelect
                id="u-role"
                value={form.roleId}
                onChange={(e) => setForm({ ...form, roleId: e.target.value })}
              >
                {(roles.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" disabled={busy}>
              {busy ? "Creando…" : "Crear usuario"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

const businessQuery = queryOptions({
  queryKey: ["business"],
  queryFn: () => api<BusinessProfile>("/api/settings/business"),
})

function BusinessTab() {
  const profile = useQuery(businessQuery)
  const features = useFeatures()
  if (!profile.data) return <p className="text-muted-foreground">Cargando…</p>
  return (
    <div className="grid grid-cols-1 gap-4">
      <BusinessForm key={JSON.stringify(profile.data)} profile={profile.data} />
      <FeaturesCard />
      {features.locations ? <LocationsCard /> : null}
      <SecurityCard />
    </div>
  )
}

const LOCK_OPTIONS = [0, 1, 2, 5, 10, 15, 30, 60]

/** Bloqueo automático de la pantalla de quienes tienen PIN. */
function SecurityCard() {
  const boot = useQuery(bootstrapQuery)
  const minutes = boot.data?.security.autoLockMinutes ?? 0
  const save = async (next: number) => {
    try {
      await api("/api/settings/security", { method: "PUT", body: { autoLockMinutes: next } })
      await queryClient.invalidateQueries({ queryKey: ["bootstrap"] })
      toast.success(next ? `Se bloqueará tras ${next} min sin uso` : "Bloqueo automático apagado")
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bloqueo de pantalla</CardTitle>
        <CardDescription>
          Cada persona puede poner un PIN (4 a 6 números) y bloquear la caja con el candado de la
          barra superior. Aquí eliges si se bloquea sola cuando no se usa.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field
          label="Bloquear sola tras"
          htmlFor="auto-lock"
          hint="Solo aplica a quienes tienen PIN"
        >
          <NativeSelect
            id="auto-lock"
            value={minutes}
            disabled={!boot.data}
            onChange={(e) => save(Number(e.target.value))}
            className="max-w-xs"
          >
            {LOCK_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m === 0
                  ? "Nunca"
                  : m === 60
                    ? "1 hora sin usar"
                    : `${m} minuto${m === 1 ? "" : "s"} sin usar`}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </CardContent>
    </Card>
  )
}

/** Si el negocio vende a crédito. Desactivarlo no borra lo que ya se debe. */
function BusinessForm({ profile }: { profile: BusinessProfile }) {
  const [form, setForm] = useState({
    name: profile.name,
    taxId: profile.taxId ?? "",
    address: profile.address ?? "",
    phone: profile.phone ?? "",
    receiptFooter: profile.receiptFooter ?? "",
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    try {
      await api("/api/settings/business", {
        method: "PUT",
        body: {
          name: form.name.trim(),
          taxId: form.taxId.trim() || null,
          address: form.address.trim() || null,
          phone: form.phone.trim() || null,
          receiptFooter: form.receiptFooter.trim() || null,
        },
      })
      toast.success("Datos del negocio guardados")
      await Promise.all(
        ["business", "bootstrap"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      )
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])))
      } else {
        toast.error(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Datos del negocio</CardTitle>
          <CardDescription>
            Salen en el encabezado de los recibos y de los cierres de caja.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="business-form" onSubmit={save} className="grid grid-cols-1 gap-4">
            <Field label="Nombre del negocio" htmlFor="b-name" error={errors.name}>
              <Input id="b-name" value={form.name} onChange={set("name")} required />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="RIF"
                htmlFor="b-taxid"
                hint="J-12345678-9 · opcional"
                error={errors.taxId}
              >
                <Input
                  id="b-taxid"
                  value={form.taxId}
                  onChange={set("taxId")}
                  autoCapitalize="characters"
                />
              </Field>
              <Field label="Teléfono" htmlFor="b-phone" error={errors.phone}>
                <Input id="b-phone" type="tel" value={form.phone} onChange={set("phone")} />
              </Field>
            </div>
            <Field label="Dirección" htmlFor="b-address" error={errors.address}>
              <Input id="b-address" value={form.address} onChange={set("address")} />
            </Field>
            <Field
              label="Mensaje al pie del recibo"
              htmlFor="b-footer"
              hint="Si lo dejas vacío: «¡Gracias por su compra!»"
              error={errors.receiptFooter}
            >
              <Input
                id="b-footer"
                value={form.receiptFooter}
                onChange={set("receiptFooter")}
                placeholder="¡Gracias por su compra!"
              />
            </Field>
            <Button type="submit" disabled={busy} className="justify-self-start">
              {busy ? "Guardando…" : "Guardar"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Así se ve en el recibo</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border bg-white p-4 text-center font-mono text-[12px] text-black leading-snug">
            <BusinessHeader
              business={{
                name: form.name || "Nombre del negocio",
                taxId: form.taxId.trim().toUpperCase() || null,
                address: form.address.trim() || null,
                phone: form.phone.trim() || null,
                receiptFooter: null,
                referenceCurrency: "",
                legalCurrency: "",
                timezone: "",
              }}
            />
            <p className="mt-1">NOTA DE VENTA · NO FISCAL</p>
            <hr className="my-2 border-current border-dashed" />
            <p>…</p>
            <hr className="my-2 border-current border-dashed" />
            <p className="whitespace-pre-line">
              {form.receiptFooter.trim() || "¡Gracias por su compra!"}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

const printerQuery = queryOptions({
  queryKey: ["printer"],
  queryFn: () => api<PrinterSettings>("/api/settings/printer"),
})

const MODES: { id: PrinterSettings["mode"]; label: string }[] = [
  { id: "browser", label: "Desde el navegador (cualquier impresora instalada)" },
  { id: "network", label: "Impresora térmica con red (cable o Wi-Fi)" },
  { id: "windows", label: "Impresora térmica USB en la PC del servidor (Windows)" },
  { id: "device", label: "Impresora térmica USB en el servidor (Linux)" },
]

function PrinterTab() {
  const printer = useQuery(printerQuery)
  if (!printer.data) return <p className="text-muted-foreground">Cargando…</p>
  return <PrinterForm key={JSON.stringify(printer.data)} saved={printer.data} />
}

function PrinterForm({ saved }: { saved: PrinterSettings }) {
  const [form, setForm] = useState({
    ...saved,
    host: saved.host ?? "",
    share: saved.share ?? "",
    device: saved.device ?? "",
    port: String(saved.port),
  })
  const [busy, setBusy] = useState<"save" | "test" | null>(null)
  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({
        ...f,
        [k]:
          e.target instanceof HTMLInputElement && e.target.type === "checkbox"
            ? e.target.checked
            : e.target.value,
      }))
  const thermal = form.mode !== "browser"
  const body = (): PrinterSettings => ({
    mode: form.mode,
    host: form.host.trim() || null,
    port: Number.parseInt(form.port, 10) || 9100,
    share: form.share.trim() || null,
    device: form.device.trim() || null,
    paperWidth: Number(form.paperWidth) === 58 ? 58 : 80,
    autoPrint: form.autoPrint,
    openDrawer: thermal && form.openDrawer,
  })

  const run = async (what: "save" | "test") => {
    setBusy(what)
    try {
      if (what === "test") {
        await api("/api/print/test", { body: body() })
        toast.success("Página de prueba enviada a la impresora")
      } else {
        await api("/api/settings/printer", { method: "PUT", body: body() })
        toast.success("Impresora guardada")
        await Promise.all(
          ["printer", "bootstrap"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
        )
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Impresora de recibos</CardTitle>
        <CardDescription>
          Con una térmica manejada por el servidor se imprime sin diálogos, también desde el
          celular, y se puede abrir la gaveta.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <Field label="¿Cómo imprimes?" htmlFor="pr-mode">
          <NativeSelect id="pr-mode" value={form.mode} onChange={set("mode")}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </NativeSelect>
        </Field>

        {form.mode === "browser" ? (
          <p className="rounded-lg bg-muted/60 p-3 text-muted-foreground text-sm">
            Al imprimir se abre el diálogo del navegador: elige la impresora y el papel. Para que
            imprima directo, sin preguntar, abre Chrome en la caja con la opción{" "}
            <code className="rounded bg-card px-1">--kiosk-printing</code> (en el acceso directo,
            después de <code className="rounded bg-card px-1">chrome.exe</code>) y deja la térmica
            como impresora predeterminada.
          </p>
        ) : null}

        {form.mode === "network" ? (
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field
              label="IP de la impresora"
              htmlFor="pr-host"
              hint="Sale en su hoja de autoprueba"
            >
              <Input
                id="pr-host"
                value={form.host}
                onChange={set("host")}
                placeholder="192.168.0.50"
                inputMode="decimal"
              />
            </Field>
            <Field label="Puerto" htmlFor="pr-port">
              <Input id="pr-port" value={form.port} onChange={set("port")} inputMode="numeric" />
            </Field>
          </div>
        ) : null}

        {form.mode === "windows" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Nombre compartido" htmlFor="pr-share">
                <Input
                  id="pr-share"
                  value={form.share}
                  onChange={set("share")}
                  placeholder="POS80"
                />
              </Field>
              <Field label="Equipo" htmlFor="pr-whost" hint="Vacío = esta misma PC">
                <Input
                  id="pr-whost"
                  value={form.host}
                  onChange={set("host")}
                  placeholder="localhost"
                />
              </Field>
            </div>
            <p className="rounded-lg bg-muted/60 p-3 text-muted-foreground text-sm">
              En Windows: Configuración → Impresoras → tu térmica → Propiedades de impresora →
              Compartir → «Compartir esta impresora» y ponle un nombre corto, sin espacios (p. ej.
              POS80). Ese nombre va aquí.
            </p>
          </>
        ) : null}

        {form.mode === "device" ? (
          <Field label="Dispositivo" htmlFor="pr-device" hint="Normalmente /dev/usb/lp0">
            <Input
              id="pr-device"
              value={form.device}
              onChange={set("device")}
              placeholder="/dev/usb/lp0"
            />
          </Field>
        ) : null}

        <Field label="Ancho del papel" htmlFor="pr-paper">
          <NativeSelect
            id="pr-paper"
            value={String(form.paperWidth)}
            onChange={(e) =>
              setForm((f) => ({ ...f, paperWidth: e.target.value === "58" ? 58 : 80 }))
            }
            className="sm:w-60"
          >
            <option value="80">80 mm (48 columnas)</option>
            <option value="58">58 mm (32 columnas)</option>
          </NativeSelect>
        </Field>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={form.autoPrint}
            onChange={set("autoPrint")}
          />
          <span>Imprimir el recibo al terminar cada venta, sin preguntar</span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={thermal && form.openDrawer}
            disabled={!thermal}
            onChange={set("openDrawer")}
          />
          <span className={thermal ? "" : "text-muted-foreground"}>
            Abrir la gaveta al cobrar en efectivo (conectada a la impresora)
            {thermal ? "" : " — necesita una térmica manejada por el servidor"}
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          {thermal ? (
            <Button variant="outline" onClick={() => run("test")} disabled={busy !== null}>
              <PrinterIcon /> {busy === "test" ? "Imprimiendo…" : "Imprimir prueba"}
            </Button>
          ) : null}
          <Button onClick={() => run("save")} disabled={busy !== null}>
            {busy === "save" ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

const backupsQuery = queryOptions({
  queryKey: ["backups"],
  queryFn: () => api<BackupList>("/api/backups"),
})

const BACKUP_LABEL: Record<Backup["label"], string> = {
  daily: "Diario",
  "shift-close": "Cierre de turno",
  manual: "Manual",
  "pre-migrate": "Antes de actualizar",
  "pre-restore": "Antes de restaurar",
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`
}

function BackupsTab() {
  const list = useQuery(backupsQuery)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<Backup | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["backups"] })

  const backupNow = async () => {
    setBusy(true)
    try {
      await api("/api/backups", { body: {} })
      toast.success("Respaldo creado")
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const restore = async (b: Backup) => {
    try {
      await api(`/api/backups/${b.name}/restore`, { body: {} })
      toast.success("Restauración anotada: reinicia el programa para aplicarla")
      setConfirming(null)
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const cancel = async () => {
    try {
      await api("/api/backups/restore", { method: "DELETE" })
      toast.success("Restauración cancelada")
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const data = list.data
  const pending = data?.backups.find((b) => b.name === data.pendingRestore)
  return (
    <div className="grid grid-cols-1 gap-4">
      {data?.pendingRestore ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/50 bg-warning/15 p-3 text-sm">
          <TriangleAlertIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Al reiniciar el programa se restaurará el respaldo del{" "}
            <strong>{pending ? formatDateTime(pending.at) : data.pendingRestore}</strong>. Lo que se
            haya registrado después se guardará aparte, como «Antes de restaurar».
          </span>
          <Button variant="outline" size="sm" onClick={cancel}>
            Cancelar
          </Button>
        </div>
      ) : null}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="grid min-w-0 flex-1 gap-1">
            <CardTitle>Respaldos en este equipo</CardTitle>
            <CardDescription>
              Se hace uno al día, otro en cada cierre de turno y otro antes de cada actualización.
              Se conservan los últimos {data?.keep ?? 14} de cada tipo. Descarga uno de vez en
              cuando y guárdalo fuera de la PC (pendrive, Drive): si el disco falla, es lo que te
              salva.
            </CardDescription>
            {data?.dir ? (
              <p className="break-all text-muted-foreground text-xs">
                Carpeta: <code>{data.dir}</code>
              </p>
            ) : null}
          </div>
          <Button onClick={backupNow} disabled={busy}>
            <DatabaseBackupIcon /> {busy ? "Respaldando…" : "Respaldar ahora"}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Tamaño</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.backups ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    {list.isLoading
                      ? "Cargando…"
                      : list.isError
                        ? errorMessage(list.error)
                        : "Aún no hay respaldos."}
                  </TableCell>
                </TableRow>
              ) : null}
              {(data?.backups ?? []).map((b) => (
                <TableRow key={b.name}>
                  <TableCell className="tabular">{formatDateTime(b.at)}</TableCell>
                  <TableCell>
                    <Badge variant={b.label === "manual" ? "secondary" : "outline"}>
                      {BACKUP_LABEL[b.label]}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
                    {formatSize(b.sizeBytes)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button asChild variant="ghost" size="sm" className="px-2 sm:px-3">
                        <a href={`/api/backups/${b.name}`} download aria-label="Descargar">
                          <DownloadIcon /> <span className="hidden sm:inline">Descargar</span>
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 sm:px-3"
                        aria-label="Restaurar"
                        onClick={() => setConfirming(b)}
                        disabled={data?.pendingRestore === b.name}
                      >
                        <HistoryIcon /> <span className="hidden sm:inline">Restaurar</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {confirming ? (
        <Dialog open onOpenChange={(o) => !o && setConfirming(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>¿Restaurar este respaldo?</DialogTitle>
              <DialogDescription>
                Volverás a los datos del {formatDateTime(confirming.at)}. Se aplica al reiniciar el
                programa. Antes, la base actual se guarda como respaldo «Antes de restaurar», así
                que no se pierde nada y se puede deshacer.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={() => restore(confirming)}>
                Restaurar al reiniciar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}

export function SettingsPage() {
  const me = useMe()
  const { tab } = useSearch({ from: "/app/ajustes" })
  const tabs = [
    { id: "negocio", label: "Negocio", show: can(me, "settings.manage") },
    { id: "tasa", label: "Tasa de cambio", show: true },
    { id: "impuestos", label: "Impuestos", show: can(me, "settings.manage") },
    { id: "usuarios", label: "Usuarios", show: can(me, "user.manage") },
    { id: "impresora", label: "Impresora", show: can(me, "settings.manage") },
    { id: "respaldos", label: "Respaldos", show: can(me, "settings.manage") },
    { id: "sesiones", label: "Sesiones", show: can(me, "user.manage") },
    { id: "bitacora", label: "Bitácora", show: can(me, "audit.view") },
  ].filter((t) => t.show)
  return (
    <div className="grid grid-cols-1 gap-4">
      <h1 className="font-semibold text-xl">Ajustes</h1>
      <Tabs
        key={tab ?? ""}
        defaultValue={tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id ?? "tasa"}
      >
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {can(me, "settings.manage") ? (
          <TabsContent value="negocio">
            <BusinessTab />
          </TabsContent>
        ) : null}
        <TabsContent value="tasa">
          <RateTab editable={can(me, "rate.manage")} />
        </TabsContent>
        {can(me, "settings.manage") ? (
          <TabsContent value="impuestos">
            <TaxesTab />
          </TabsContent>
        ) : null}
        {can(me, "user.manage") ? (
          <TabsContent value="usuarios">
            <UsersTab />
          </TabsContent>
        ) : null}
        {can(me, "settings.manage") ? (
          <TabsContent value="impresora">
            <PrinterTab />
          </TabsContent>
        ) : null}
        {can(me, "settings.manage") ? (
          <TabsContent value="respaldos">
            <BackupsTab />
          </TabsContent>
        ) : null}
        {can(me, "user.manage") ? (
          <TabsContent value="sesiones">
            <SessionsPanel all />
          </TabsContent>
        ) : null}
        {can(me, "audit.view") ? (
          <TabsContent value="bitacora">
            <AuditTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}
