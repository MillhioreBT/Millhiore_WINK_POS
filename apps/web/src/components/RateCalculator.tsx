import {
  badgeVariants,
  cn,
  Input,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRightIcon, ArrowUpDownIcon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import {
  currencySymbol,
  formatDateTime,
  formatRate,
  parseAmount,
  timeAgo,
  toInputAmount,
} from "../lib/format"
import { rateStatusQuery } from "../lib/queries"
import { can, useMe } from "../lib/session"

const SOURCE: Record<string, string> = { bcv: "BCV", dolarapi: "BCV (espejo)", manual: "manual" }
const NAME: Record<string, string> = { USD: "Dólares", EUR: "Euros", VES: "Bolívares" }
const QUICK = [100, 500, 1000, 2000]

/**
 * La tasa del día en la barra de arriba. Al tocarla abre una calculadora: lo que se escribe en
 * dólares se ve en bolívares y al revés, con la tasa vigente.
 */
export function RateCalculator({ className }: { className?: string }) {
  const me = useMe()
  const { data } = useQuery(rateStatusQuery)
  const [open, setOpen] = useState(false)
  // Lo último que se escribió y en qué campo: el otro campo se calcula siempre.
  const [typed, setTyped] = useState<{ field: "base" | "quote"; text: string }>({
    field: "base",
    text: "",
  })
  if (!data) return null
  if (!data.current) {
    return (
      <Link
        to="/ajustes"
        className={cn(badgeVariants({ variant: "destructive" }), "py-1", className)}
      >
        <TriangleAlertIcon /> Sin tasa del día
      </Link>
    )
  }
  const { base, quote, value, source, effectiveAt } = data.current
  const factor = Number(value)
  const sourceName = SOURCE[source] ?? source

  const typedMinor = parseAmount(typed.text)
  const converted =
    typedMinor === null
      ? ""
      : toInputAmount(
          typed.field === "base"
            ? Math.round(typedMinor * factor)
            : Math.round(typedMinor / factor),
        )
  const baseText = typed.field === "base" ? typed.text : converted
  const quoteText = typed.field === "quote" ? typed.text : converted

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          badgeVariants({ variant: data.stale ? "warning" : "outline" }),
          "tabular cursor-pointer whitespace-nowrap py-1 text-sm transition-colors hover:bg-accent",
          className,
        )}
        title={`Vigente desde ${formatDateTime(effectiveAt)} · fuente ${sourceName}${data.stale ? " · desactualizada" : ""}. Toca para abrir la calculadora`}
      >
        {data.stale ? <TriangleAlertIcon /> : null}1 {base} = {formatRate(value)}{" "}
        {quote === "VES" ? "Bs" : quote}
        <span className="font-normal text-muted-foreground">· {sourceName}</span>
      </PopoverTrigger>
      <PopoverContent className="grid w-80 gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-semibold text-sm">Calculadora</h2>
          <span className="text-muted-foreground text-xs">
            {sourceName} · {timeAgo(effectiveAt)}
          </span>
        </div>
        {data.stale ? (
          <p className="rounded-md bg-warning/15 px-2 py-1 text-xs">
            La tasa está desactualizada: revísala antes de cobrar.
          </p>
        ) : null}
        <label className="grid gap-1 text-muted-foreground text-xs" htmlFor="calc-base">
          {NAME[base] ?? base}
          <span className="relative block">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
              {currencySymbol(base)}
            </span>
            <Input
              id="calc-base"
              inputMode="decimal"
              autoFocus
              value={baseText}
              onChange={(e) => setTyped({ field: "base", text: e.target.value })}
              placeholder="0,00"
              className="tabular pl-9 text-right text-foreground"
            />
          </span>
        </label>
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <span className="h-px flex-1 bg-border" />
          <span className="tabular inline-flex items-center gap-1 rounded-full border px-2 py-0.5">
            <ArrowUpDownIcon className="size-3" />
            {currencySymbol(quote)} {formatRate(value)} por {currencySymbol(base)}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
        <label className="grid gap-1 text-muted-foreground text-xs" htmlFor="calc-quote">
          {NAME[quote] ?? quote}
          <span className="relative block">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
              {currencySymbol(quote)}
            </span>
            <Input
              id="calc-quote"
              inputMode="decimal"
              value={quoteText}
              onChange={(e) => setTyped({ field: "quote", text: e.target.value })}
              placeholder="0,00"
              className="tabular pl-9 text-right text-foreground"
            />
          </span>
        </label>
        <div className="grid grid-cols-4 gap-1.5">
          {QUICK.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setTyped({ field: "base", text: toInputAmount(n) })}
              className="tabular h-8 cursor-pointer rounded-md border text-xs transition-colors hover:bg-accent"
            >
              {currencySymbol(base)} {toInputAmount(n)}
            </button>
          ))}
        </div>
        {can(me, "rate.manage") ? (
          <div className="border-t pt-3">
            <PopoverClose asChild>
              <Link
                to="/ajustes"
                className="inline-flex items-center gap-1 text-primary text-sm hover:underline"
              >
                Cambiar tasa en Ajustes <ArrowRightIcon className="size-4" />
              </Link>
            </PopoverClose>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
