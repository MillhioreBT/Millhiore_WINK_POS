import type { ShiftReport } from "@millhiore/contracts"
import { formatDateTime, formatMoney } from "../../lib/format"
import { BusinessHeader, type BusinessInfo } from "../sales/ReceiptDialog"

function Row({ label, value, bold }: { label: React.ReactNode; value: string; bold?: boolean }) {
  return (
    <p className={`flex justify-between gap-4 ${bold ? "font-bold" : ""}`}>
      <span>{label}</span>
      <span className="text-right">{value}</span>
    </p>
  )
}

const Hr = () => <hr className="my-2 border-dashed border-current" />

/** Cierre de caja imprimible (80 mm): ventas, cobrado por método, movimientos y arqueo. */
export function ShiftReportView({
  report,
  business,
}: {
  report: ShiftReport
  business: BusinessInfo | undefined
}) {
  const legal = report.legalCurrency
  return (
    <div id="receipt" className="mx-auto w-full max-w-[340px] font-mono text-[12px] leading-snug">
      <div className="text-center">
        <BusinessHeader business={business} />
        <p className="mt-1">
          {report.status === "closed" ? "CIERRE DE CAJA" : "CORTE PARCIAL (TURNO ABIERTO)"}
        </p>
        <p>{report.terminalName}</p>
        <p>
          Abrió: {formatDateTime(report.openedAt)}
          {report.openedBy ? ` · ${report.openedBy}` : ""}
        </p>
        {report.closedAt ? (
          <p>
            Cerró: {formatDateTime(report.closedAt)}
            {report.closedBy ? ` · ${report.closedBy}` : ""}
          </p>
        ) : null}
      </div>
      <Hr />
      <p className="font-bold">VENTAS</p>
      <Row label="Ventas cobradas" value={String(report.sales.count - report.sales.voided)} />
      {report.sales.voided ? <Row label="Anuladas" value={String(report.sales.voided)} /> : null}
      <Row label="Total vendido" value={formatMoney(report.sales.totalLegalMinor, legal)} bold />
      <Row label="IVA" value={formatMoney(report.sales.taxLegalMinor, legal)} />
      {report.sales.surchargeLegalMinor ? (
        <Row label="IGTF percibido" value={formatMoney(report.sales.surchargeLegalMinor, legal)} />
      ) : null}
      {report.sales.returnsLegalMinor ? (
        <Row label="Devoluciones" value={formatMoney(report.sales.returnsLegalMinor, legal)} />
      ) : null}
      {report.sales.discountLegalMinor ? (
        <Row label="Descuentos dados" value={formatMoney(report.sales.discountLegalMinor, legal)} />
      ) : null}
      {report.sales.creditLegalMinor ? (
        <Row label="Fiado (a deber)" value={formatMoney(report.sales.creditLegalMinor, legal)} />
      ) : null}
      {report.expenses.count ? (
        <Row
          label={`Gastos pagados (${report.expenses.count})`}
          value={formatMoney(report.expenses.totalLegalMinor, legal)}
        />
      ) : null}
      {report.supplierPayments.count ? (
        <Row
          label={`Pagos a proveedores (${report.supplierPayments.count})`}
          value={formatMoney(report.supplierPayments.totalLegalMinor, legal)}
        />
      ) : null}
      {report.supplierReturns.count ? (
        <Row
          label={`Devoluciones a proveedores (${report.supplierReturns.count})`}
          value={formatMoney(report.supplierReturns.totalLegalMinor, legal)}
        />
      ) : null}
      {report.collections.count ? (
        <Row
          label={`Abonos de clientes (${report.collections.count})`}
          value={formatMoney(report.collections.totalLegalMinor, legal)}
        />
      ) : null}
      <Hr />
      <p className="font-bold">COBRADO POR MÉTODO</p>
      {report.byMethod.length === 0 ? <p>Sin cobros</p> : null}
      {report.byMethod.map((m) => (
        <div key={`${m.methodId}-${m.currency}`}>
          <Row label={m.methodName} value={formatMoney(m.amountMinor, m.currency)} />
          {m.commissionMinor ? (
            <Row label="  comisión" value={`-${formatMoney(m.commissionMinor, m.currency)}`} />
          ) : null}
        </div>
      ))}
      {report.tips.length ? (
        <>
          <Hr />
          <p className="font-bold">PROPINAS</p>
          {report.tips.map((t) => (
            <Row
              key={t.userId ?? "equipo"}
              label={t.name}
              value={formatMoney(t.totalLegalMinor, legal)}
            />
          ))}
          <p>Ya están en lo cobrado: se entregan con un retiro de caja.</p>
        </>
      ) : null}
      {report.cashMovements.length ? (
        <>
          <Hr />
          <p className="font-bold">INGRESOS Y RETIROS</p>
          {report.cashMovements.map((m) => (
            <Row
              key={m.id}
              label={`${m.type === "CASH_IN" ? "+" : "−"} ${m.note ?? (m.type === "CASH_IN" ? "Ingreso" : "Retiro")}`}
              value={formatMoney(m.totalMinor, m.currency)}
            />
          ))}
        </>
      ) : null}
      <Hr />
      <p className="font-bold">ARQUEO DE EFECTIVO</p>
      {report.accounts.map((a) => (
        <div key={a.accountId} className="mb-1.5">
          <p className="underline">{a.accountName}</p>
          <Row label="Apertura" value={formatMoney(a.openingCountedMinor, a.currency)} />
          {a.closingExpectedMinor !== null ? (
            <>
              <Row label="Esperado" value={formatMoney(a.closingExpectedMinor, a.currency)} />
              <Row label="Contado" value={formatMoney(a.closingCountedMinor ?? 0, a.currency)} />
              <Row
                label={
                  (a.differenceMinor ?? 0) > 0
                    ? "Sobrante"
                    : (a.differenceMinor ?? 0) < 0
                      ? "Faltante"
                      : "Diferencia"
                }
                value={formatMoney(Math.abs(a.differenceMinor ?? 0), a.currency)}
                bold
              />
            </>
          ) : null}
        </div>
      ))}
      {report.closingNote ? <p className="mt-2">Nota: {report.closingNote}</p> : null}
      <p className="mt-6 text-center">______________________</p>
      <p className="text-center">Firma</p>
    </div>
  )
}
