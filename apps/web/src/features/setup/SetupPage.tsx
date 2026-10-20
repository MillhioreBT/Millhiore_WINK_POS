import { passwordProblem } from "@millhiore/domain"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useNavigate } from "@tanstack/react-router"
import { RocketIcon } from "lucide-react"
import { useState } from "react"
import { ApiError, api, errorMessage } from "../../lib/api"
import { healthQuery, queryClient } from "../../lib/queries"
import { signIn } from "../../lib/session"

const TAXPAYER_HELP: Record<string, string> = {
  ordinary: "Cobra IVA. No cobra IGTF.",
  special: "Cobra IVA y además el IGTF (3 %) en los pagos en divisas: efectivo en dólares, Zelle.",
  none: "No cobra IVA (no está inscrito como contribuyente del IVA).",
}

export function SetupPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    businessName: "",
    businessTaxId: "",
    ownerName: "",
    username: "",
    password: "",
    confirm: "",
    taxpayer: "ordinary",
    pricesIncludeTax: true,
    terminalCode: "C1",
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({
        ...f,
        [k]:
          e.target instanceof HTMLInputElement && e.target.type === "checkbox"
            ? e.target.checked
            : e.target.value,
      }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (form.password !== form.confirm) {
      setErrors({ confirm: "Las contraseñas no coinciden" })
      return
    }
    setBusy(true)
    setErrors({})
    const username = form.username.trim().toLowerCase()
    try {
      await api("/api/setup", {
        body: {
          business: { name: form.businessName, taxId: form.businessTaxId.trim() || null },
          owner: { name: form.ownerName, username, password: form.password },
          taxpayer: form.taxpayer,
          pricesIncludeTax: form.pricesIncludeTax,
          terminalCode: form.terminalCode.trim().toUpperCase() || "C1",
        },
      })
      queryClient.setQueryData(healthQuery.queryKey, { status: "ok", configured: true })
      await signIn(username, form.password)
      await navigate({ to: "/" })
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        const map: Record<string, string> = {}
        for (const i of err.issues) map[i.path] = i.message
        setErrors(map)
      } else {
        setErrors({ form: errorMessage(err) })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <img src="/favicon.svg" alt="" className="mb-2 size-10" />
          <CardTitle className="text-xl">Te damos la bienvenida a Millhiore WINK POS</CardTitle>
          <CardDescription>
            Configura tu negocio. Se crean la caja, los métodos de cobro (efectivo $ y Bs, pago
            móvil, punto de venta, Zelle) y tu usuario de dueño. La tasa del BCV se consulta sola.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 gap-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <Field label="Nombre del negocio" htmlFor="biz" error={errors["business.name"]}>
                <Input
                  id="biz"
                  value={form.businessName}
                  onChange={set("businessName")}
                  required
                  autoFocus
                />
              </Field>
              <Field label="RIF" htmlFor="biz-rif" hint="Opcional" error={errors["business.taxId"]}>
                <Input
                  id="biz-rif"
                  value={form.businessTaxId}
                  onChange={set("businessTaxId")}
                  placeholder="J-12345678-9"
                  autoCapitalize="characters"
                />
              </Field>
            </div>

            <fieldset className="grid grid-cols-1 gap-4 rounded-lg border p-4">
              <legend className="px-1 font-medium text-sm">Tu usuario (dueño)</legend>
              <Field label="Tu nombre" htmlFor="owner" error={errors["owner.name"]}>
                <Input id="owner" value={form.ownerName} onChange={set("ownerName")} required />
              </Field>
              <Field
                label="Usuario"
                htmlFor="user"
                hint="Minúsculas, números, punto o guion bajo"
                error={errors["owner.username"]}
              >
                <Input
                  id="user"
                  autoCapitalize="none"
                  autoComplete="username"
                  value={form.username}
                  onChange={set("username")}
                  required
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Contraseña"
                  htmlFor="pass"
                  hint="Mínimo 8 caracteres"
                  error={
                    errors["owner.password"] ??
                    (form.password
                      ? passwordProblem(form.password, {
                          username: form.username,
                          name: form.ownerName,
                          businessName: form.businessName,
                        })
                      : null)
                  }
                >
                  <Input
                    id="pass"
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={set("password")}
                    required
                    minLength={8}
                  />
                </Field>
                <Field label="Repite la contraseña" htmlFor="confirm" error={errors.confirm}>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    value={form.confirm}
                    onChange={set("confirm")}
                    required
                  />
                </Field>
              </div>
            </fieldset>

            <fieldset className="grid grid-cols-1 gap-4 rounded-lg border p-4">
              <legend className="px-1 font-medium text-sm">Impuestos</legend>
              <Field
                label="Condición ante el SENIAT"
                htmlFor="taxpayer"
                hint={TAXPAYER_HELP[form.taxpayer]}
              >
                <NativeSelect id="taxpayer" value={form.taxpayer} onChange={set("taxpayer")}>
                  <option value="ordinary">Contribuyente ordinario</option>
                  <option value="special">Sujeto pasivo especial</option>
                  <option value="none">No cobro IVA</option>
                </NativeSelect>
              </Field>
              <div className="flex items-start gap-3">
                <input
                  id="incl"
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                  checked={form.pricesIncludeTax}
                  onChange={set("pricesIncludeTax")}
                />
                <div className="grid grid-cols-1 gap-1">
                  <Label htmlFor="incl">Mis precios ya incluyen el IVA</Label>
                  <p className="text-muted-foreground text-xs">
                    Es lo normal en la vitrina: el cliente paga el precio que ve. Si lo desmarcas,
                    el IVA se suma al cobrar.
                  </p>
                </div>
              </div>
            </fieldset>

            <Field
              label="Código de la caja"
              htmlFor="term"
              hint="Prefijo de los números de venta: C1-000001"
            >
              <Input
                id="term"
                value={form.terminalCode}
                onChange={set("terminalCode")}
                maxLength={6}
                className="w-32 uppercase"
              />
            </Field>

            {errors.form ? <p className="text-destructive text-sm">{errors.form}</p> : null}
            <Button type="submit" size="lg" disabled={busy}>
              <RocketIcon /> {busy ? "Configurando…" : "Empezar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
