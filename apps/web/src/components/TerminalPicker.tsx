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
  const locationName = (locationId: string) => boot.locations.find((l) => l.id === locationId)?.name
  return (
    <NativeSelect
      id={id}
      aria-label="Caja de este equipo"
      value={current?.id ?? ""}
      onChange={(e) => chooseTerminal(e.target.value)}
      className={cn("w-auto", className)}
    >
      {boot.terminals.map((t) => {
        const where = locationName(t.locationId)
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
