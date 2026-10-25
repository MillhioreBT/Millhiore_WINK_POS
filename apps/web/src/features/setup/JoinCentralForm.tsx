import { Button, Field, Input } from "@millhiore/ui"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeftIcon, LinkIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { ApiError, api, errorMessage } from "../../lib/api"
import { healthQuery, queryClient } from "../../lib/queries"

/**
 * Una sucursal con su propio servidor: en vez de crear un negocio nuevo, esta PC se une al central
 * con su dirección y el código que muestra allá (Ajustes → Negocio → Sucursales). Baja el negocio,
 * el catálogo y los usuarios; después se entra con el mismo usuario del central.
 */
export function JoinCentralForm({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate()
  const [centralUrl, setCentralUrl] = useState("")
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    try {
      const r = await api<{ businessName: string; branchName: string }>("/api/setup/join", {
        body: { centralUrl, code, ...(name.trim() ? { name: name.trim() } : {}) },
      })
      queryClient.setQueryData(healthQuery.queryKey, { status: "ok", configured: true })
      toast.success(
        `Esta PC es ahora la sucursal ${r.branchName} de ${r.businessName}: entra con tu usuario del central`,
      )
      await navigate({ to: "/entrar" })
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
    <form onSubmit={submit} className="grid grid-cols-1 gap-5">
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
        <li>Las dos PC tienen Tailscale encendido, con la misma cuenta.</li>
        <li>
          En el central: Ajustes → Negocio → Sucursales → el botón del servidor junto a esta
          sucursal → «Crear código».
        </li>
        <li>Escribe aquí la dirección y el código que muestra.</li>
      </ol>
      <Field
        label="Dirección del central"
        htmlFor="join-url"
        hint="La que muestra el central, como http://100.101.102.103:3000"
        error={errors.centralUrl}
      >
        <Input
          id="join-url"
          value={centralUrl}
          onChange={(e) => setCentralUrl(e.target.value)}
          placeholder="http://100.101.102.103:3000"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          autoFocus
        />
      </Field>
      <Field label="Código" htmlFor="join-code" hint="Vale una hora" error={errors.code}>
        <Input
          id="join-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD-EFGH-JKLM"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="font-mono uppercase"
          required
        />
      </Field>
      <Field
        label="Nombre de esta PC"
        htmlFor="join-name"
        hint="Opcional: para reconocerla en el central"
        error={errors.name}
      >
        <Input
          id="join-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="PC de la caja"
          maxLength={60}
        />
      </Field>
      {errors.form ? <p className="text-destructive text-sm">{errors.form}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon /> Volver
        </Button>
        <Button type="submit" className="flex-1" disabled={busy}>
          <LinkIcon /> {busy ? "Uniendo… (baja el catálogo)" : "Unir como sucursal"}
        </Button>
      </div>
    </form>
  )
}
