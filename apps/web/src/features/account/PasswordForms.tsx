import { passwordProblem } from "@millhiore/domain"
import {
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
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { bootstrapQuery, meQuery, queryClient } from "../../lib/queries"
import { signOut, useMe } from "../../lib/session"

/** Formulario de cambio de la propia contraseña (lo usan el diálogo y la pantalla obligatoria). */
function useChangePassword(onDone: () => void) {
  const me = useMe()
  const { data: boot } = useQuery(bootstrapQuery)
  const [form, setForm] = useState({ current: "", next: "", repeat: "", signOutOthers: true })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = form.next
    ? passwordProblem(form.next, {
        username: me.username,
        name: me.name,
        businessName: boot?.business.name ?? null,
      })
    : null
  const mismatch = form.repeat !== "" && form.repeat !== form.next
  const ready = form.current !== "" && form.next !== "" && !problem && form.repeat === form.next

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await api("/api/me/password", {
        body: {
          currentPassword: form.current,
          newPassword: form.next,
          signOutOthers: form.signOutOthers,
        },
      })
      toast.success("Contraseña cambiada")
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey })
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return { form, setForm, error, busy, problem, mismatch, ready, submit }
}

function Fields({
  state,
  currentLabel,
  showSignOut,
}: {
  state: ReturnType<typeof useChangePassword>
  currentLabel: string
  showSignOut: boolean
}) {
  const { form, setForm, problem, mismatch, error } = state
  return (
    <>
      <Field label={currentLabel} htmlFor="pw-current">
        <Input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={form.current}
          onChange={(e) => setForm({ ...form, current: e.target.value })}
          autoFocus
          required
        />
      </Field>
      <Field
        label="Nueva contraseña"
        htmlFor="pw-next"
        hint="Mínimo 8 caracteres. Mejor una frase corta que puedas recordar."
        error={problem ?? undefined}
      >
        <Input
          id="pw-next"
          type="password"
          autoComplete="new-password"
          value={form.next}
          onChange={(e) => setForm({ ...form, next: e.target.value })}
          required
        />
      </Field>
      <Field
        label="Repite la nueva"
        htmlFor="pw-repeat"
        error={mismatch ? "No coincide" : undefined}
      >
        <Input
          id="pw-repeat"
          type="password"
          autoComplete="new-password"
          value={form.repeat}
          onChange={(e) => setForm({ ...form, repeat: e.target.value })}
          required
        />
      </Field>
      {showSignOut ? (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={form.signOutOthers}
            onChange={(e) => setForm({ ...form, signOutOthers: e.target.checked })}
          />
          <span>Cerrar mi sesión en los demás equipos (celulares, otras PC)</span>
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </>
  )
}

/** «Mi cuenta → Cambiar contraseña». */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const state = useChangePassword(onClose)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cambiar mi contraseña</DialogTitle>
          <DialogDescription>
            Necesitas la actual: así nadie puede cambiarla desde una sesión que dejaste abierta.
          </DialogDescription>
        </DialogHeader>
        <form id="pw-form" onSubmit={state.submit} className="grid grid-cols-1 gap-4">
          <Fields state={state} currentLabel="Contraseña actual" showSignOut />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="pw-form" disabled={!state.ready || state.busy}>
            {state.busy ? "Guardando…" : "Cambiar contraseña"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Pantalla obligatoria cuando se entra con una contraseña temporal (la puso el dueño o se
 * recuperó desde la PC del servidor): hasta elegir una propia no se puede usar nada más.
 */
export function ForcedPasswordChange() {
  const me = useMe()
  const state = useChangePassword(() => undefined)
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <img src="/favicon.svg" alt="" className="mb-2 size-10" />
          <CardTitle className="text-xl">Elige tu contraseña</CardTitle>
          <CardDescription>
            {me.name}, entraste con una contraseña temporal. Elige una propia para seguir: solo tú
            la sabrás.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={state.submit} className="grid grid-cols-1 gap-4">
            <Fields state={state} currentLabel="Contraseña temporal" showSignOut={false} />
            <Button type="submit" size="lg" disabled={!state.ready || state.busy}>
              {state.busy ? "Guardando…" : "Guardar y entrar"}
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                await signOut()
                window.location.assign("/entrar")
              }}
            >
              Salir
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
