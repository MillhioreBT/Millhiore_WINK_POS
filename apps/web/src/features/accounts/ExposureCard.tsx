import { Card, CardContent, CardDescription, CardHeader } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { TrendingDownIcon } from "lucide-react"
import { formatMoney, formatPercent, formatRate } from "../../lib/format"
import { exposureQuery } from "../../lib/queries"

/** «−23,5 %»: cuánto cambió el valor en dólares respecto de lo que valía al entrar. */
const change = (difference: number, basis: number) =>
  basis > 0 ? formatPercent(Math.round((difference / basis) * 10_000)) : null

/**
 * Exposición cambiaria: cuánto valían en dólares los bolívares guardados cuando entraron y cuánto
 * valen hoy. Informativa: no toca los saldos. Sin bolívares guardados no se muestra.
 */
export function ExposureCard() {
  const { data } = useQuery(exposureQuery)
  if (!(data?.rate && data.accounts.length)) return null
  const ref = data.referenceCurrency
  const legal = data.legalCurrency
  const { totals } = data
  const lost = totals.differenceMinor < 0
  const totalChange = change(Math.abs(totals.differenceMinor), totals.basisMinor)

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardDescription className="flex items-center gap-2">
          <TrendingDownIcon className="size-4" /> Exposición cambiaria
        </CardDescription>
        <p className="text-muted-foreground text-xs">
          Lo que valían en {ref} los {legal === "VES" ? "bolívares" : legal} guardados cuando
          entraron, contra lo que valen hoy a {formatRate(data.rate.value)}. Es informativo: no
          cambia los saldos.
        </p>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-2 p-4 pt-0 text-sm">
        <ul className="divide-y rounded-lg border">
          {data.accounts.map((a) => (
            <li key={a.accountId} className="flex items-start justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium">{a.name}</span>
                <span className="tabular block text-muted-foreground text-xs">
                  <span className="whitespace-nowrap">{formatMoney(a.balanceMinor, legal)}</span> ·{" "}
                  <span className="whitespace-nowrap">entró {formatMoney(a.basisMinor, ref)}</span>{" "}
                  · <span className="whitespace-nowrap">hoy {formatMoney(a.valueMinor, ref)}</span>
                </span>
              </span>
              <span
                className={`tabular shrink-0 text-right ${a.differenceMinor < 0 ? "text-destructive" : "text-success"}`}
              >
                {formatMoney(a.differenceMinor, ref)}
                <span className="block text-xs">{change(a.differenceMinor, a.basisMinor)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className={`tabular font-medium ${lost ? "text-destructive" : "text-success"}`}>
          {lost ? "Se devaluaron" : "Ganaron"} {formatMoney(Math.abs(totals.differenceMinor), ref)}
          {totalChange ? ` (${totalChange})` : ""} mientras estaban guardados: hoy valen{" "}
          {formatMoney(totals.valueMinor, ref)}.
        </p>
      </CardContent>
    </Card>
  )
}
