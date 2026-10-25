import { Button, Field, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { MessageCircleIcon } from "lucide-react"
import { useState } from "react"
import { dayRange, daysBefore, todayInCaracas } from "../../lib/days"
import { bootstrapQuery } from "../../lib/queries"
import { useFeatures } from "../../lib/session"
import { previousRange } from "./compare"
import { FinanceTab } from "./FinanceTab"
import { InventoryTab } from "./InventoryTab"
import { MonthClosingDialog } from "./MonthClosingDialog"
import { monthLabel } from "./monthClosingText"
import { ResultsTab } from "./ResultsTab"
import { SalesTab } from "./SalesTab"
import { TaxBookTab } from "./TaxBookTab"
import { TipsTab } from "./TipsTab"

/** Meses y años que se piden más: se calculan sobre el día de hoy en Caracas. */
function presetRange(id: string, today: string) {
  const [y = "", m = ""] = today.split("-")
  const monthStart = `${y}-${m}-01`
  if (id === "today") return { from: today, to: today }
  if (id === "week") return { from: daysBefore(today, 6), to: today }
  if (id === "month") return { from: monthStart, to: today }
  if (id === "lastMonth") {
    const lastDay = daysBefore(monthStart, 1)
    return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay }
  }
  return { from: `${y}-01-01`, to: today }
}

const PRESETS = [
  { id: "today", label: "Hoy" },
  { id: "week", label: "7 días" },
  { id: "month", label: "Este mes" },
  { id: "lastMonth", label: "Mes pasado" },
  { id: "year", label: "Este año" },
] as const

const day = (date: string) => date.split("-").reverse().join("/")

/** Informes del negocio: resultados (utilidad), ventas, inventario valorado y finanzas. */
export function ReportsPage() {
  const boot = useQuery(bootstrapQuery)
  const features = useFeatures()
  const today = todayInCaracas()
  const [range, setRange] = useState(() => presetRange("month", today))
  const bounds = { from: dayRange(range.from).from, to: dayRange(range.to).to }
  const valid = range.from <= range.to
  const period =
    range.from === range.to ? day(range.from) : `${day(range.from)} al ${day(range.to)}`
  const business = boot.data?.business.name ?? ""
  const prev = previousRange(range)
  const compare = {
    bounds: { from: dayRange(prev.from).from, to: dayRange(prev.to).to },
    label: prev.label,
    period: prev.from === prev.to ? day(prev.from) : `${day(prev.from)} al ${day(prev.to)}`,
  }
  // Un mes (entero o lo que va): se puede mandar su cierre.
  const oneMonth =
    valid && range.from.endsWith("-01") && range.from.slice(0, 7) === range.to.slice(0, 7)
  const [closingMonth, setClosingMonth] = useState(false)
  const preset = PRESETS.find((p) => {
    const r = presetRange(p.id, today)
    return r.from === range.from && r.to === range.to
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <h1 className="mr-auto font-semibold text-xl">Informes</h1>
        {oneMonth ? (
          <Button variant="outline" size="sm" onClick={() => setClosingMonth(true)}>
            <MessageCircleIcon /> Cierre del mes
          </Button>
        ) : null}
      </div>
      {closingMonth && oneMonth ? (
        <MonthClosingDialog
          bounds={bounds}
          previous={compare.bounds}
          label={monthLabel(range)}
          onClose={() => setClosingMonth(false)}
        />
      ) : null}

      <Tabs defaultValue="resultados" className="grid grid-cols-1 gap-4">
        <TabsList className="h-auto flex-wrap print:hidden">
          <TabsTrigger value="resultados" className="h-8">
            Resultados
          </TabsTrigger>
          <TabsTrigger value="ventas" className="h-8">
            Ventas
          </TabsTrigger>
          <TabsTrigger value="libro" className="h-8">
            Libro de IVA
          </TabsTrigger>
          <TabsTrigger value="inventario" className="h-8">
            Inventario
          </TabsTrigger>
          <TabsTrigger value="finanzas" className="h-8">
            Finanzas
          </TabsTrigger>
          {features.tips ? (
            <TabsTrigger value="propinas" className="h-8">
              Propinas
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="resultados" className="grid grid-cols-1 gap-4">
          <Period range={range} setRange={setRange} today={today} preset={preset?.id} />
          {valid ? (
            <ResultsTab bounds={bounds} period={period} business={business} compare={compare} />
          ) : null}
        </TabsContent>
        <TabsContent value="ventas" className="grid grid-cols-1 gap-4">
          <Period range={range} setRange={setRange} today={today} preset={preset?.id} />
          {valid ? (
            <SalesTab bounds={bounds} period={period} business={business} compare={compare} />
          ) : null}
        </TabsContent>
        <TabsContent value="libro" className="grid grid-cols-1 gap-4">
          <Period range={range} setRange={setRange} today={today} preset={preset?.id} />
          {valid ? <TaxBookTab bounds={bounds} period={period} business={business} /> : null}
        </TabsContent>
        <TabsContent value="inventario">
          <InventoryTab business={business} today={day(today)} />
        </TabsContent>
        <TabsContent value="finanzas">
          <FinanceTab business={business} today={day(today)} />
        </TabsContent>
        {features.tips ? (
          <TabsContent value="propinas" className="grid grid-cols-1 gap-4">
            <Period range={range} setRange={setRange} today={today} preset={preset?.id} />
            {valid ? <TipsTab bounds={bounds} period={period} business={business} /> : null}
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

/** Desde, hasta y los períodos más pedidos. */
function Period({
  range,
  setRange,
  today,
  preset,
}: {
  range: { from: string; to: string }
  setRange: (r: { from: string; to: string }) => void
  today: string
  preset: string | undefined
}) {
  return (
    <div className="grid grid-cols-1 gap-3 print:hidden">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[auto_auto_1fr]">
        <Field label="Desde" htmlFor="rep-from">
          <Input
            id="rep-from"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })}
          />
        </Field>
        <Field label="Hasta" htmlFor="rep-to">
          <Input
            id="rep-to"
            type="date"
            value={range.to}
            min={range.from}
            max={today}
            onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={preset === p.id ? "default" : "outline"}
            onClick={() => setRange(presetRange(p.id, today))}
          >
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
