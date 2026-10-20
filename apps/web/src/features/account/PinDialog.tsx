import { pinProblem } from "@millhiore/domain"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@millhiore/ui"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { meQuery, queryClient } from "../../lib/queries"
import { useMe } from "../../lib/session"

/** Pone, cambia o quita el PIN de caja: lo que desbloquea la pantalla sin escribir la contraseña. */
export function PinDialog({ onClose }: { onClose: () => void }) {
  const me = useMe()
  const [form, setForm] = useState({ password: "", pin: "", repeat: "" })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = form.pin ? pinProblem(form.pin) : null
  const mismatch = form.repeat !== "" && form.repeat !== form.pin
  const ready = form.password !== "" && form.pin !== "" && !problem && form.repeat === form.pin
  const digits = (e: React.ChangeEvent<HTMLInputElement>) => e.target.value.replace(/\D/g, "")

  const save = async (pin: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await api("/api/me/pin", { method: "PUT", body: { currentPassword: form.password, pin } })
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey })
      toast.success(pin ? "PIN guardado" : "PIN quitado")
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{me.hasPin ? "Cambiar mi PIN" : "Poner un PIN"}</DialogTitle>
          <DialogDescription>
            El PIN (4 a 6 números) desbloquea la pantalla cuando te alejas de la caja. No sustituye
            a tu contraseña para entrar.
          </DialogDescription>
        </DialogHeader>
        <form
          id="pin-form"
          className="grid grid-cols-1 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) void save(form.pin)
          }}
        >
          <Field label="Tu contraseña" htmlFor="pin-password" hint="Para confirmar que eres tú">
            <Input
              id="pin-password"
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              autoFocus
            />
          </Field>
          <Field label="PIN nuevo" htmlFor="pin-new" error={problem ?? undefined}>
            <Input
              id="pin-new"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={form.pin}
              onChange={(e) => setForm((f) => ({ ...f, pin: digits(e) }))}
              className="tabular tracking-widest"
            />
          </Field>
          <Field
            label="Repite el PIN"
            htmlFor="pin-repeat"
            error={mismatch ? "No coincide" : undefined}
          >
            <Input
              id="pin-repeat"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={form.repeat}
              onChange={(e) => setForm((f) => ({ ...f, repeat: digits(e) }))}
              className="tabular tracking-widest"
            />
          </Field>
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          {me.hasPin ? (
            <Button
              variant="outline"
              className="mr-auto text-destructive"
              disabled={busy || form.password === ""}
              onClick={() => void save(null)}
              title={form.password === "" ? "Escribe tu contraseña para quitarlo" : undefined}
            >
              Quitar PIN
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="pin-form" disabled={busy || !ready}>
            {busy ? "Guardando…" : "Guardar PIN"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
