import { passwordProblem, temporaryPassword } from "@millhiore/domain"
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
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { CopyIcon, RefreshCwIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { bootstrapQuery, queryClient, rolesQuery, type UserRow } from "../../lib/queries"
import { BranchAccess } from "./BranchAccess"

const refreshUsers = () => queryClient.invalidateQueries({ queryKey: ["users"] })

/**
 * Nombre, rol, estado y sucursales. El servidor impide dejar el negocio sin un dueño activo.
 */
export function EditUserDialog({ target, onClose }: { target: UserRow; onClose: () => void }) {
  const roles = useQuery(rolesQuery)
  const branchesOn = useQuery(bootstrapQuery).data?.features.branches ?? false
  const [form, setForm] = useState({
    name: target.name,
    roleId: target.roleId ?? "",
    active: target.active,
    branchIds: target.branchIds,
  })
  const [busy, setBusy] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/api/users/${target.id}`, {
        method: "PATCH",
        body: {
          name: form.name.trim(),
          roleId: form.roleId || undefined,
          active: form.active,
          ...(branchesOn ? { branchIds: form.roleId === "owner" ? null : form.branchIds } : {}),
        },
      })
      toast.success("Usuario guardado")
      await refreshUsers()
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar a {target.name}</DialogTitle>
          <DialogDescription>Usuario: {target.username}</DialogDescription>
        </DialogHeader>
        <form id="user-form" onSubmit={save} className="grid grid-cols-1 gap-4">
          <Field label="Nombre" htmlFor="eu-name">
            <Input
              id="eu-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Field>
          <Field label="Rol" htmlFor="eu-role">
            <NativeSelect
              id="eu-role"
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
          <BranchAccess
            id="eu-branches"
            value={form.branchIds}
            roleId={form.roleId}
            onChange={(branchIds) => setForm({ ...form, branchIds })}
          />
          <div className="flex items-start gap-3">
            <input
              id="eu-active"
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            <div className="grid gap-1">
              <Label htmlFor="eu-active">Activo</Label>
              <p className="text-muted-foreground text-xs">
                Un usuario inactivo no puede entrar y se le cierran las sesiones abiertas.
              </p>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="user-form"
            disabled={busy || (form.branchIds !== null && form.branchIds.length === 0)}
          >
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * El dueño pone una contraseña temporal: se cierran las sesiones de esa persona y, al entrar con
 * la temporal, debe elegir la suya. Así el dueño nunca conoce la definitiva.
 */
export function ResetPasswordDialog({ target, onClose }: { target: UserRow; onClose: () => void }) {
  const { data: boot } = useQuery(bootstrapQuery)
  const [password, setPassword] = useState(temporaryPassword)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const problem = passwordProblem(password, {
    username: target.username,
    name: target.name,
    businessName: boot?.business.name ?? null,
  })

  const reset = async () => {
    setBusy(true)
    try {
      await api(`/api/users/${target.id}/password`, { body: { temporaryPassword: password } })
      await refreshUsers()
      setDone(true)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password)
      toast.success("Copiada")
    } catch {
      toast.error("No se pudo copiar: anótala")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restablecer la contraseña de {target.name}</DialogTitle>
          <DialogDescription>
            {done
              ? "Listo. Dale esta contraseña temporal; al entrar tendrá que elegir una propia."
              : "Se cierran todas sus sesiones. Al entrar con la temporal, tendrá que elegir una propia antes de usar el sistema."}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="grid gap-2 rounded-lg border bg-muted/40 p-4 text-center">
            <span className="text-muted-foreground text-sm">Usuario: {target.username}</span>
            <code className="font-mono font-semibold text-2xl tracking-wider">{password}</code>
          </div>
        ) : (
          <Field
            label="Contraseña temporal"
            htmlFor="rp-pass"
            hint="Ya viene una generada, fácil de dictar. Puedes cambiarla."
            error={problem}
          >
            <div className="flex gap-2">
              <Input
                id="rp-pass"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
                autoComplete="off"
              />
              <Button
                variant="outline"
                size="icon"
                title="Generar otra"
                onClick={() => setPassword(temporaryPassword())}
              >
                <RefreshCwIcon />
                <span className="sr-only">Generar otra</span>
              </Button>
            </div>
          </Field>
        )}
        <DialogFooter>
          {done ? (
            <>
              <Button variant="outline" onClick={copy}>
                <CopyIcon /> Copiar
              </Button>
              <Button onClick={onClose}>Listo</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={reset} disabled={busy || problem !== null}>
                {busy ? "Restableciendo…" : "Restablecer"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
