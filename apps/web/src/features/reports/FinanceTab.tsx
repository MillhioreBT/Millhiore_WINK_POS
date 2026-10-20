import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { formatMoney } from "../../lib/format"
import {
  accountsQuery,
  bootstrapQuery,
  payablesQuery,
  rateStatusQuery,
  receivablesQuery,
} from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { bold, downloadXlsx, fileName, moneyCell } from "../../lib/xlsx"
import { ExportButtons, Line, PrintHeader } from "./parts"

/** Dónde está el dinero hoy y lo que falta cobrar y pagar. No depende del período. */
export function FinanceTab({ business, today }: { business: string; today: string }) {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const accounts = useQuery(accountsQuery())
  const owed = useQuery({
    ...receivablesQuery,
    enabled: can(me, "payment.receive", "finance.view"),
  })
  const owing = useQuery({ ...payablesQuery, enabled: can(me, "payable.manage", "finance.view") })
  const legal = boot.data?.business.legalCurrency ?? "VES"
  const current = rate.data?.current
  const factor = current && current.quote === legal ? Number(current.value) : null

  const list = accounts.data ?? []
  const byCurrency = new Map<string, { accounts: number; receivable: number; payable: number }>()
  const slot = (currency: string) => {
    const row = byCurrency.get(currency) ?? { accounts: 0, receivable: 0, payable: 0 }
    byCurrency.set(currency, row)
    return row
  }
  for (const a of list) slot(a.currency).accounts += a.balanceMinor
  for (const t of owed.data?.totals ?? []) slot(t.currency).receivable += t.outstandingMinor
  for (const t of owing.data?.totals ?? []) slot(t.currency).payable += t.outstandingMinor
  const currencies = [...byCurrency.keys()].sort()

  // Todo a moneda legal con la tasa vigente, para tener una sola cifra
  const inLegal = (minor: number, currency: string) =>
    currency === legal ? minor : factor ? Math.round(minor * factor) : null
  const totalLegal = (
    pick: (r: { accounts: number; receivable: number; payable: number }) => number,
  ) => {
    let sum = 0
    for (const [currency, row] of byCurrency) {
      const v = inLegal(pick(row), currency)
      if (v === null) return null
      sum += v
    }
    return sum
  }
  const money = (minor: number | null) => (minor === null ? "—" : formatMoney(minor, legal))

  const exportXlsx = () =>
    downloadXlsx(fileName("finanzas", today), [
      {
        name: "Cuentas",
        widths: [30, 10, 12, 18],
        rows: [
          [bold(`${business} · Finanzas al ${today}`)],
          [],
          [bold("Cuenta"), bold("Moneda"), bold("Tipo"), bold("Saldo")],
          ...list.map((a) => [a.name, a.currency, a.kind, moneyCell(a.balanceMinor)]),
        ],
      },
      {
        name: "Resumen por moneda",
        widths: [12, 18, 18, 18, 18],
        rows: [
          [bold("Moneda"), bold("En cuentas"), bold("Por cobrar"), bold("Por pagar"), bold("Neto")],
          ...currencies.map((cur) => {
            const r = byCurrency.get(cur)
            return [
              cur,
              moneyCell(r?.accounts ?? 0),
              moneyCell(r?.receivable ?? 0),
              moneyCell(r?.payable ?? 0),
              moneyCell((r?.accounts ?? 0) + (r?.receivable ?? 0) - (r?.payable ?? 0), 2, true),
            ]
          }),
        ],
      },
    ])

  const net = totalLegal((r) => r.accounts + r.receivable - r.payable)

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-sm print:hidden">
          Hoy, {today}
          {factor && legal ? ` · a la tasa ${new Intl.NumberFormat("es-VE").format(factor)}` : ""}
        </p>
        <div className="ml-auto">
          <ExportButtons onExcel={exportXlsx} />
        </div>
      </div>
      <PrintHeader business={business} title="Finanzas" period={`al ${today}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardHeader className="p-4">
            <CardDescription>En cuentas</CardDescription>
            <CardTitle className="tabular text-xl">
              {money(totalLegal((r) => r.accounts))}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Por cobrar</CardDescription>
            <CardTitle className="tabular text-xl">
              {money(totalLegal((r) => r.receivable))}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Por pagar</CardDescription>
            <CardTitle className="tabular text-xl">{money(totalLegal((r) => r.payable))}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Neto (cuentas + cobrar − pagar)</CardDescription>
            <CardTitle className="tabular text-xl">{money(net)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cuentas</CardTitle>
            <CardDescription>El efectivo es lo que debería haber en la gaveta</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {list.map((a) => (
              <Line
                key={a.id}
                label={a.name}
                hint={a.currency}
                value={formatMoney(a.balanceMinor, a.currency)}
                negative={a.balanceMinor < 0}
              />
            ))}
            {list.length === 0 ? (
              <p className="text-muted-foreground text-sm">No hay cuentas.</p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Por moneda</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Moneda</TableHead>
                  <TableHead className="text-right">Cuentas</TableHead>
                  <TableHead className="text-right">Cobrar</TableHead>
                  <TableHead className="text-right">Pagar</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {currencies.map((cur) => {
                  const r = byCurrency.get(cur)
                  return (
                    <TableRow key={cur}>
                      <TableCell className="font-medium">{cur}</TableCell>
                      <TableCell className="tabular text-right">
                        {formatMoney(r?.accounts ?? 0, cur)}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {formatMoney(r?.receivable ?? 0, cur)}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {formatMoney(r?.payable ?? 0, cur)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
