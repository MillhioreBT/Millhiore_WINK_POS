import type { Bootstrap } from "@millhiore/contracts"
import { cn, NativeSelect } from "@millhiore/ui"
import { chooseTerminal, deviceTerminal } from "../lib/terminal"

/**
 * En qué caja trabaja este equipo, si el negocio tiene varias. Cada caja vende de su ubicación y
 * tiene su propio turno; la elección se recuerda en este navegador.
 */
export function TerminalPicker({
  boot,
  id = "terminal-picker",
  className,
}: {
  boot: Bootstrap
  id?: string
  className?: string
}) {
  if (boot.terminals.length < 2) return null
  const current = deviceTerminal(boot)
  // Con sucursales, de cuál es cada caja; si no, de qué ubicación vende.
  const branches = boot.features.branches && boot.branches.length > 1
  const whereOf = (t: Bootstrap["terminals"][number]) =>
    branches
      ? boot.branches.find((b) => b.id === t.branchId)?.name
      : boot.locations.find((l) => l.id === t.locationId)?.name
  return (
    <NativeSelect
      id={id}
      aria-label="Caja de este equipo"
      value={current?.id ?? ""}
      onChange={(e) => chooseTerminal(e.target.value)}
      className={cn("w-auto", className)}
    >
      {boot.terminals.map((t) => {
        const where = whereOf(t)
        return (
          <option key={t.id} value={t.id}>
            {t.name}
            {where ? ` · ${where}` : ""}
          </option>
        )
      })}
    </NativeSelect>
  )
}
