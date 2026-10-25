import type { DaySummary } from "@millhiore/contracts"
import { addDays, localDate } from "@millhiore/domain"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleIcon,
  PackageXIcon,
  ScrollTextIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react"
import { useState } from "react"
import { useBranchChoices } from "../../lib/branches"
import { formatDay, formatMoney, formatPercent, formatQty, formatTime } from "../../lib/format"
import {
  bootstrapQuery,
  daySummaryQuery,
  payablesQuery,
  receivablesQuery,
  recurringQuery,
} from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { ClosingDialog } from "./ClosingDialog"
import { OnboardingCard } from "./OnboardingCard"

const HOUR = 3_600_000

function Kpi({
  title,
  value,
  className,
  children,
}: {
  title: string
  value: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <Card className={className}>
      <CardHeader className="p-4 pb-1 sm:p-5 sm:pb-1">
        <CardDescription>{title}</CardDescription>
        <div className="tabular font-semibold text-lg tracking-tight sm:text-2xl">{value}</div>
      </CardHeader>
      <CardContent className="p-4 pt-0 text-muted-foreground text-xs sm:p-5 sm:pt-0 sm:text-sm">
        {children}
      </CardContent>
    </Card>
  )
}

/** Variación frente al día anterior, en la moneda de referencia si se puede (sin devaluación). */
function Trend({ s, isToday }: { s: DaySummary; isToday: boolean }) {
  const useRef = s.sales.totalReferenceMinor !== null && s.previous.totalReferenceMinor !== null
  const now = useRef ? (s.sales.totalReferenceMinor ?? 0) : s.sales.totalLegalMinor
  const before = useRef ? (s.previous.totalReferenceMinor ?? 0) : s.previous.totalLegalMinor
  const label = isToday ? "ayer" : "el día anterior"
  if (before <= 0) return <span>Sin ventas {label}</span>
  const pct = Math.round(((now - before) / before) * 10_000)
  const up = pct >= 0
  return (
    <span
      className={cn("inline-flex items-center gap-1", up ? "text-success" : "text-destructive")}
      title={
        useRef
          ? `Comparado en ${s.referenceCurrency} con la tasa de cada venta`
          : `Comparado en ${s.legalCurrency}`
      }
    >
      {up ? <TrendingUpIcon className="size-4" /> : <TrendingDownIcon className="size-4" />}
      {up ? "+" : "−"}
      {formatPercent(Math.abs(pct))} vs. {label}
    </span>
  )
}

function HourChart({ s }: { s: DaySummary }) {
  if (!s.byHour.length) {
    return <p className="py-8 text-center text-muted-foreground text-sm">Sin ventas este día.</p>
  }
  const first = Math.min(8, ...s.byHour.map((h) => h.hour))
  const last = Math.max(20, ...s.byHour.map((h) => h.hour))
  const byHour = new Map(s.byHour.map((h) => [h.hour, h]))
  const max = Math.max(1, ...s.byHour.map((h) => h.totalLegalMinor))
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  return (
    <div>
      <div className="flex h-40 items-end gap-1">
        {hours.map((hour) => {
          const h = byHour.get(hour)
          const total = Math.max(0, h?.totalLegalMinor ?? 0)
          return (
            <div
              key={hour}
              className="group relative flex h-full flex-1 flex-col justify-end"
              title={
                h
                  ? `${hour}:00 · ${h.count} venta${h.count === 1 ? "" : "s"} · ${formatMoney(h.totalLegalMinor, s.legalCurrency)}`
                  : `${hour}:00 · sin ventas`
              }
            >
              <div
                className={cn(
                  "w-full rounded-t-sm bg-primary/80 transition-colors group-hover:bg-primary",
                  total ? "" : "bg-muted",
                )}
                style={{ height: total ? `${Math.max(4, (total / max) * 100)}%` : "2px" }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground">
        {hours.map((hour) => (
          <div key={hour} className="flex-1 text-center">
            {hour % 2 === 0 ? hour : ""}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Lo que los clientes deben (fiado), con lo vencido aparte. */
function ReceivablesCard() {
  const owed = useQuery(receivablesQuery)
  const totals = owed.data?.totals ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Por cobrar
          {totals.some((t) => t.overdueMinor > 0) ? (
            <Badge variant="destructive">Vencido</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>Fiado pendiente de los clientes</CardDescription>
      </CardHeader>
      <CardContent>
        {totals.length ? (
          <ul className="grid grid-cols-1 gap-2 text-sm">
            {totals.map((t) => (
              <li key={t.currency} className="grid gap-0.5">
                <span className="tabular font-semibold text-xl">
                  {formatMoney(t.outstandingMinor, t.currency)}
                </span>
                <span className="text-muted-foreground">
                  {t.customers} cliente{t.customers === 1 ? "" : "s"}
                  {t.overdueMinor > 0 ? (
                    <span className="font-medium text-destructive">
                      {" "}
                      · {formatMoney(t.overdueMinor, t.currency)} vencido
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <BookOpenIcon className="size-4" />{" "}
            {owed.isLoading ? "Cargando…" : "Nadie te debe nada."}
          </p>
        )}
        <Link
          to="/fiado"
          className="mt-3 inline-block text-primary text-sm underline-offset-4 hover:underline"
        >
          Ver el fiado
        </Link>
      </CardContent>
    </Card>
  )
}

/** Lo que el negocio le debe a sus proveedores, con lo vencido aparte. */
function PayablesCard() {
  const owing = useQuery(payablesQuery)
  const totals = owing.data?.totals ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Por pagar
          {totals.some((t) => t.overdueMinor > 0) ? (
            <Badge variant="destructive">Vencido</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>Compras y gastos que debes a proveedores</CardDescription>
      </CardHeader>
      <CardContent>
        {totals.length ? (
          <ul className="grid grid-cols-1 gap-2 text-sm">
            {totals.map((t) => (
              <li key={t.currency} className="grid gap-0.5">
                <span className="tabular font-semibold text-xl">
                  {formatMoney(t.outstandingMinor, t.currency)}
                </span>
                <span className="text-muted-foreground">
                  {t.suppliers} proveedor{t.suppliers === 1 ? "" : "es"}
                  {t.overdueMinor > 0 ? (
                    <span className="font-medium text-destructive">
                      {" "}
                      · {formatMoney(t.overdueMinor, t.currency)} vencido
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <ScrollTextIcon className="size-4" />{" "}
            {owing.isLoading ? "Cargando…" : "No le debes nada a nadie."}
          </p>
        )}
        <Link
          to="/pagar"
          className="mt-3 inline-block text-primary text-sm underline-offset-4 hover:underline"
        >
          Ver lo que debes
        </Link>
      </CardContent>
    </Card>
  )
}

export function DashboardPage() {
  const me = useMe()
  const { data: boot } = useQuery(bootstrapQuery)
  const features = useFeatures()
  const [date, setDate] = useState<string | undefined>(undefined)
  const [closing, setClosing] = useState(false)
  // Con sucursales: todas (las de quien consulta) o una.
  const branches = useBranchChoices()
  const [branchId, setBranchId] = useState("")
  const summary = useQuery(daySummaryQuery(date, branchId || undefined))
  // Gastos recurrentes que vencieron y esperan que alguien los registre.
  const recurring = useQuery({
    ...recurringQuery,
    enabled: features.recurring && can(me, "expense.create", "finance.view", "report.view"),
  })
  const waiting = (recurring.data ?? []).filter((r) => r.due && (!r.auto || r.lastError)).length
  const s = summary.data
  const today = boot ? localDate(Date.now(), boot.business.timezone) : undefined
  const isToday = !date || date === today
  const go = (d: string) => setDate(d === today ? undefined : d)
  const netCount = s ? s.sales.count - s.sales.voided : 0

  return (
    <div className="grid grid-cols-1 gap-4">
      {can(me, "settings.manage") ? <OnboardingCard /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto font-semibold text-xl">
          {isToday ? "Hoy" : "Resumen"}
          {s ? (
            <span className="ml-2 font-normal text-base text-muted-foreground">
              {formatDay(s.from + 12 * HOUR).replace(/^./, (c) => c.toUpperCase())}
            </span>
          ) : null}
        </h1>
        <Button
          variant="outline"
          size="icon-sm"
          title="Día anterior"
          disabled={!s}
          onClick={() => s && go(addDays(s.date, -1))}
        >
          <ChevronLeftIcon />
          <span className="sr-only">Día anterior</span>
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          title="Día siguiente"
          disabled={!s || isToday}
          onClick={() => s && go(addDays(s.date, 1))}
        >
          <ChevronRightIcon />
          <span className="sr-only">Día siguiente</span>
        </Button>
        {isToday ? null : (
          <Button variant="outline" size="sm" onClick={() => setDate(undefined)}>
            Hoy
          </Button>
        )}
        {branches ? (
          <NativeSelect
            aria-label="Sucursal"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="h-8 w-auto py-1"
          >
            <option value="">Todas las sucursales</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <Button variant="outline" size="sm" disabled={!s} onClick={() => setClosing(true)}>
          <MessageCircleIcon /> <span className="hidden sm:inline">Cierre del día</span>
          <span className="sm:hidden">Cierre</span>
        </Button>
      </div>
      {closing && s ? (
        <ClosingDialog
          summary={s}
          branchName={branches?.find((b) => b.id === branchId)?.name}
          onClose={() => setClosing(false)}
        />
      ) : null}

      {!s ? (
        <p className="py-10 text-center text-muted-foreground">
          {summary.isError ? "No se pudo cargar el resumen." : "Cargando…"}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            <Kpi title="Ventas" value={formatMoney(s.sales.totalLegalMinor, s.legalCurrency)}>
              <div className="grid grid-cols-1 gap-0.5">
                {s.sales.totalReferenceMinor !== null ? (
                  <span className="tabular">
                    ≈ {formatMoney(s.sales.totalReferenceMinor, s.referenceCurrency)}
                  </span>
                ) : null}
                {s.sales.returnsLegalMinor !== 0 ? (
                  <span className="tabular">
                    Devoluciones {formatMoney(s.sales.returnsLegalMinor, s.legalCurrency)}
                  </span>
                ) : null}
                {s.sales.discountLegalMinor !== 0 ? (
                  <span className="tabular">
                    Descuentos {formatMoney(s.sales.discountLegalMinor, s.legalCurrency)}
                  </span>
                ) : null}
                {s.sales.creditLegalMinor !== 0 ? (
                  <span className="tabular">
                    Fiado {formatMoney(s.sales.creditLegalMinor, s.legalCurrency)}
                  </span>
                ) : null}
                <Trend s={s} isToday={isToday} />
              </div>
            </Kpi>
            <Kpi title="Tickets" value={String(s.sales.count)}>
              <div className="grid grid-cols-1 gap-0.5">
                <span className="tabular">
                  Promedio{" "}
                  {netCount > 0
                    ? formatMoney(Math.round(s.sales.totalLegalMinor / netCount), s.legalCurrency)
                    : "—"}
                </span>
                {s.sales.voided ? (
                  <span className="text-destructive">
                    {s.sales.voided} anulada{s.sales.voided === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span>Sin anulaciones</span>
                )}
              </div>
            </Kpi>
            <Kpi title="IVA cobrado" value={formatMoney(s.sales.taxLegalMinor, s.legalCurrency)}>
              <span className="tabular">
                IGTF {formatMoney(s.sales.surchargeLegalMinor, s.legalCurrency)}
              </span>
            </Kpi>
            <Kpi title="Compras" value={formatMoney(s.purchases.totalLegalMinor, s.legalCurrency)}>
              {s.purchases.count
                ? `${s.purchases.count} factura${s.purchases.count === 1 ? "" : "s"} de proveedor`
                : "Sin compras"}
            </Kpi>
            <Kpi
              title="Gastos"
              className="col-span-2 xl:col-span-1"
              value={formatMoney(s.expenses.totalLegalMinor, s.legalCurrency)}
            >
              {s.expenses.count
                ? `${s.expenses.count} gasto${s.expenses.count === 1 ? "" : "s"} pagado${s.expenses.count === 1 ? "" : "s"}`
                : "Sin gastos"}
              {s.inventoryLossLegalMinor ? (
                <Link
                  to="/inventario"
                  className="mt-1 block text-destructive underline-offset-4 hover:underline"
                >
                  Pérdidas de inventario{" "}
                  <span className="tabular">
                    {formatMoney(s.inventoryLossLegalMinor, s.legalCurrency)}
                  </span>
                </Link>
              ) : null}
              {waiting > 0 ? (
                <Link
                  to="/gastos"
                  className="mt-1 block font-medium text-primary underline-offset-4 hover:underline"
                >
                  {waiting} recurrente{waiting === 1 ? "" : "s"} por registrar
                </Link>
              ) : null}
            </Kpi>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Ventas por hora</CardTitle>
              </CardHeader>
              <CardContent>
                <HourChart s={s} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Cobrado por método</CardTitle>
                <CardDescription>
                  Con el vuelto ya restado
                  {s.collections.count
                    ? ` · incluye ${s.collections.count} abono${s.collections.count === 1 ? "" : "s"} de clientes`
                    : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {s.byMethod.length ? (
                  <ul className="grid grid-cols-1 gap-2 text-sm">
                    {s.byMethod.map((m) => (
                      <li
                        key={`${m.methodId}-${m.currency}`}
                        className="flex justify-between gap-3"
                      >
                        <span>
                          {m.methodName}
                          {m.commissionMinor ? (
                            <span className="block text-muted-foreground text-xs">
                              Comisión {formatMoney(m.commissionMinor, m.currency)} · te quedan{" "}
                              {formatMoney(m.amountMinor - m.commissionMinor, m.currency)}
                            </span>
                          ) : null}
                        </span>
                        <span className="tabular font-medium">
                          {formatMoney(m.amountMinor, m.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">Nada cobrado.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4">
            {can(me, "payment.receive", "finance.view") ? <ReceivablesCard /> : null}
            {can(me, "payable.manage", "finance.view") ? <PayablesCard /> : null}
            <Card>
              <CardHeader>
                <CardTitle>Lo más vendido</CardTitle>
              </CardHeader>
              <CardContent>
                {s.topProducts.length ? (
                  <ol className="grid grid-cols-1 gap-2 text-sm">
                    {s.topProducts.map((p, i) => (
                      <li key={p.variantId} className="flex items-baseline gap-2">
                        <span className="w-4 text-muted-foreground tabular">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <span className="text-muted-foreground tabular">
                          × {formatQty(p.qtyMilli)}
                        </span>
                        <span className="w-28 text-right font-medium tabular">
                          {formatMoney(p.totalLegalMinor, s.legalCurrency)}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-muted-foreground text-sm">Sin ventas este día.</p>
                )}
              </CardContent>
            </Card>

            {s.lowStock ? (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    Por reponer
                    {s.lowStock.length ? (
                      <Badge variant="warning">{s.lowStock.length}</Badge>
                    ) : null}
                  </CardTitle>
                  <CardDescription>Agotados o por debajo del mínimo (ahora mismo)</CardDescription>
                </CardHeader>
                <CardContent>
                  {s.lowStock.length ? (
                    <ul className="grid max-h-72 gap-2 overflow-y-auto text-sm">
                      {s.lowStock.map((p) => (
                        <li key={p.variantId} className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          <span
                            className={cn(
                              "tabular font-medium",
                              p.stockMilli <= 0 && "text-destructive",
                            )}
                          >
                            {formatQty(p.stockMilli)}
                          </span>
                          <span className="w-20 text-right text-muted-foreground text-xs">
                            {p.minStockMilli === null ? "" : `mín. ${formatQty(p.minStockMilli)}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="flex items-center gap-2 text-muted-foreground text-sm">
                      <PackageXIcon className="size-4" /> Nada por reponer.
                    </p>
                  )}
                  {s.expiry && (s.expiry.expiredLots || s.expiry.expiringLots) ? (
                    <Link
                      to="/vencimientos"
                      className="mt-3 block text-sm underline-offset-4 hover:underline"
                    >
                      {s.expiry.expiredLots ? (
                        <span className="font-medium text-destructive">
                          {s.expiry.expiredLots} lote{s.expiry.expiredLots === 1 ? "" : "s"} vencido
                          {s.expiry.expiredLots === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      {s.expiry.expiredLots && s.expiry.expiringLots ? " · " : null}
                      {s.expiry.expiringLots ? (
                        <span className="text-warning-foreground dark:text-warning">
                          {s.expiry.expiringLots} por vencer en {s.expiry.alertDays} días
                        </span>
                      ) : null}
                    </Link>
                  ) : null}
                  <Link
                    to="/productos"
                    className="mt-3 inline-block text-primary text-sm underline-offset-4 hover:underline"
                  >
                    Ver productos
                  </Link>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Cajas abiertas</CardTitle>
                <CardDescription>Ahora mismo</CardDescription>
              </CardHeader>
              <CardContent>
                {s.openShifts.length ? (
                  <ul className="grid grid-cols-1 gap-2 text-sm">
                    {s.openShifts.map((sh) => (
                      <li key={sh.id} className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{sh.terminalName}</span>
                        <span className="text-muted-foreground">
                          desde {formatTime(sh.openedAt)}
                          {Date.now() - sh.openedAt > 20 * HOUR ? " (de otro día)" : ""} ·{" "}
                          {sh.openedBy ?? "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">Ninguna caja abierta.</p>
                )}
                <Link
                  to="/ventas"
                  className="mt-3 inline-block text-primary text-sm underline-offset-4 hover:underline"
                >
                  Ver ventas y cierres
                </Link>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
