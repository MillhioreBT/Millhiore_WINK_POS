import { Label } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useMyBranchIds } from "../../lib/branches"
import { bootstrapQuery } from "../../lib/queries"

/**
 * Dónde trabaja alguien: en todas las sucursales o solo en las marcadas (null = todas). El dueño
 * trabaja siempre en todas; quien trabaja en algunas reparte solo esas. Nada si el negocio no
 * usa sucursales.
 */
export function BranchAccess({
  id,
  value,
  onChange,
  roleId,
}: {
  id: string
  value: string[] | null
  onChange: (next: string[] | null) => void
  roleId: string
}) {
  const boot = useQuery(bootstrapQuery)
  const mine = useMyBranchIds()
  if (!boot.data?.features.branches || boot.data.branches.length < 2) return null
  if (roleId === "owner") {
    return (
      <p className="text-muted-foreground text-xs">El dueño trabaja en todas las sucursales.</p>
    )
  }
  const branches = mine ? boot.data.branches.filter((b) => mine.has(b.id)) : boot.data.branches
  const all = value === null
  const toggle = (branchId: string, on: boolean) => {
    const next = new Set(value ?? [])
    if (on) next.add(branchId)
    else next.delete(branchId)
    onChange([...next])
  }
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 font-medium text-sm">Sucursales</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${id}-scope`}
          className="size-4 accent-[var(--primary)]"
          checked={all}
          disabled={mine !== null}
          onChange={() => onChange(null)}
        />
        Todas
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${id}-scope`}
          className="size-4 accent-[var(--primary)]"
          checked={!all}
          onChange={() => onChange(branches[0] ? [branches[0].id] : [])}
        />
        Solo en:
      </label>
      {all ? null : (
        <div className="flex flex-wrap gap-x-4 gap-y-2 pl-6">
          {branches.map((b) => (
            <div key={b.id} className="flex items-center gap-2">
              <input
                id={`${id}-${b.id}`}
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={value?.includes(b.id) ?? false}
                onChange={(e) => toggle(b.id, e.target.checked)}
              />
              <Label htmlFor={`${id}-${b.id}`} className="font-normal">
                {b.name}
              </Label>
            </div>
          ))}
        </div>
      )}
      {!all && value?.length === 0 ? (
        <p className="text-destructive text-xs">Marca al menos una sucursal.</p>
      ) : null}
    </fieldset>
  )
}
