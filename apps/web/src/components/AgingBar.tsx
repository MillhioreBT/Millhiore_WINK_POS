import type { Aging } from "@millhiore/contracts"
import { formatMoney } from "../lib/format"

const BUCKETS = [
  { key: "current", label: "Sin vencer", color: "bg-success" },
  { key: "d1_30", label: "1–30 días", color: "bg-warning" },
  { key: "d31_60", label: "31–60 días", color: "bg-destructive/50" },
  { key: "d61_90", label: "61–90 días", color: "bg-destructive/75" },
  { key: "d90plus", label: "Más de 90", color: "bg-destructive" },
] as const

/** Antigüedad de saldos: lo que se debe repartido por cuánto lleva vencido, en una barra y una lista. */
export function AgingBar({ aging, currency }: { aging: Aging; currency: string }) {
  const total = BUCKETS.reduce((acc, b) => acc + aging[b.key], 0)
  if (total <= 0) return null
  return (
    <div className="grid grid-cols-1 gap-2">
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label="Antigüedad de saldos"
      >
        {BUCKETS.filter((b) => aging[b.key] > 0).map((b) => (
          <span
            key={b.key}
            className={b.color}
            style={{ width: `${(aging[b.key] / total) * 100}%` }}
            title={`${b.label}: ${formatMoney(aging[b.key], currency)}`}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
        {BUCKETS.map((b) => (
          <li key={b.key} className="flex items-center gap-1.5 text-muted-foreground">
            <span className={`size-2 shrink-0 rounded-full ${b.color}`} />
            <span className="min-w-0">
              {b.label}
              <span className="tabular block font-medium text-foreground">
                {formatMoney(aging[b.key], currency)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
