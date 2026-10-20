import Big from "big.js"
import { roundToInteger } from "./money"

/** Las alícuotas se expresan en centésimas de punto porcentual: 1600 = 16 %, 300 = 3 %. */
export const BASIS_POINTS = 10_000

/**
 * Tratamiento de una línea frente al IVA. Los no gravados van a 0 % pero se distinguen porque el
 * libro de ventas y la factura los separan (exento, exonerado, no sujeto).
 */
export const TAX_KINDS = ["taxed", "exempt", "exonerated", "not_subject"] as const
export type TaxKind = (typeof TAX_KINDS)[number]

/**
 * Condición del negocio ante el SENIAT:
 * - ordinary: contribuyente ordinario, cobra IVA;
 * - special: sujeto pasivo especial, cobra IVA y además percibe el IGTF de los pagos en divisas;
 * - none: no cobra IVA (no inscrito como contribuyente del IVA).
 */
export const TAXPAYER_TYPES = ["ordinary", "special", "none"] as const
export type TaxpayerType = (typeof TAXPAYER_TYPES)[number]

/** Impuesto de una línea, congelado al contabilizar: si luego cambia la alícuota, el documento no. */
export interface LineTax {
  taxId: string
  kind: TaxKind
  rateBp: number
}

/** Una línea sin impuesto asignado (negocio que no cobra IVA) se agrupa como no sujeta. */
const UNTAXED = { taxId: null, kind: "not_subject", rateBp: 0 } as const

export function isValidRateBp(rateBp: number): boolean {
  return Number.isSafeInteger(rateBp) && rateBp >= 0 && rateBp <= BASIS_POINTS
}

/** Un impuesto gravado tiene alícuota positiva; uno no gravado, 0 %. */
export function isValidLineTax(tax: LineTax): boolean {
  return (
    (TAX_KINDS as readonly string[]).includes(tax.kind) &&
    isValidRateBp(tax.rateBp) &&
    (tax.kind === "taxed" ? tax.rateBp > 0 : tax.rateBp === 0)
  )
}

/** `amount × rateBp / 10 000`, redondeado a la unidad menor (mitad lejos de cero). */
export function applyRate(amountMinor: number, rateBp: number): number {
  return roundToInteger(new Big(amountMinor).times(rateBp).div(BASIS_POINTS), "half-up")
}

/**
 * Separa base e impuesto partiendo del monto que no se redondea (el ancla):
 * - si los precios incluyen el impuesto, el ancla es lo que paga el cliente y la base sale de
 *   dividir; el impuesto es la diferencia, así el total nunca se mueve un céntimo;
 * - si no lo incluyen, el ancla es la base y el impuesto sale de multiplicar.
 * Es simétrica: separar −x da exactamente lo contrario de separar x.
 */
export function splitTax(
  anchorMinor: number,
  rateBp: number,
  pricesIncludeTax: boolean,
): { baseMinor: number; taxMinor: number } {
  // -0 no es igual a 0 al comparar resultados: se normaliza.
  if (anchorMinor === 0) return { baseMinor: 0, taxMinor: 0 }
  if (rateBp === 0) return { baseMinor: anchorMinor, taxMinor: 0 }
  if (!pricesIncludeTax) return { baseMinor: anchorMinor, taxMinor: applyRate(anchorMinor, rateBp) }
  const baseMinor = roundToInteger(
    new Big(anchorMinor).times(BASIS_POINTS).div(BASIS_POINTS + rateBp),
    "half-up",
  )
  return { baseMinor, taxMinor: anchorMinor - baseMinor }
}

/** Desglose del documento por alícuota, en su moneda y en la legal. */
export interface TaxGroup {
  taxId: string | null
  kind: TaxKind
  rateBp: number
  baseMinor: number
  taxMinor: number
  baseLegalMinor: number
  taxLegalMinor: number
}

/** Convierte un monto de la moneda del documento a la legal (con su redondeo). */
export type ToLegal = (amountMinor: number) => number

/**
 * Agrupa las líneas por alícuota y calcula base e IVA de cada grupo.
 *
 * El impuesto se calcula sobre el grupo y no línea a línea, como en el libro de ventas.
 * En moneda legal no se convierten la base y el IVA ya redondeados: se convierte el ancla del
 * grupo y se vuelve a separar en bolívares. Con tasas de cientos de Bs por dólar, redondear el
 * IVA a céntimos de dólar antes de convertir descuadraría la factura en varios bolívares.
 */
export function computeTaxes(
  lines: readonly { lineTotalMinor: number; tax: LineTax | null }[],
  pricesIncludeTax: boolean,
  toLegal: ToLegal,
): TaxGroup[] {
  const groups = new Map<string, { tax: LineTax | typeof UNTAXED; anchorMinor: number }>()
  for (const line of lines) {
    const tax = line.tax ?? UNTAXED
    const key = `${tax.taxId ?? ""}|${tax.kind}|${tax.rateBp}`
    const group = groups.get(key) ?? { tax, anchorMinor: 0 }
    group.anchorMinor += line.lineTotalMinor
    groups.set(key, group)
  }
  return [...groups.values()].map(({ tax, anchorMinor }) => {
    const doc = splitTax(anchorMinor, tax.rateBp, pricesIncludeTax)
    const legal = splitTax(toLegal(anchorMinor), tax.rateBp, pricesIncludeTax)
    return {
      taxId: tax.taxId,
      kind: tax.kind,
      rateBp: tax.rateBp,
      baseMinor: doc.baseMinor,
      taxMinor: doc.taxMinor,
      baseLegalMinor: legal.baseMinor,
      taxLegalMinor: legal.taxMinor,
    }
  })
}

/** Recargo que un método de cobro añade al pago, p. ej. el IGTF en divisas. */
export interface PaymentSurcharge {
  surchargeId: string
  rateBp: number
}

export interface SurchargeGroup {
  surchargeId: string
  rateBp: number
  /** Parte del total del documento cubierta con pagos que llevan este recargo. */
  baseMinor: number
  amountMinor: number
  baseLegalMinor: number
  amountLegalMinor: number
}

/**
 * Recargos por método de cobro (IGTF). La base es la parte del total cubierta con esos pagos:
 * - los pagos sin recargo (bolívares) se aplican primero, así el cliente paga el mínimo;
 * - el vuelto no cambia la base: si paga 20 $ una cuenta de 15 $ y recibe el cambio en
 *   bolívares, el recargo es sobre 15 $, no sobre 20 $;
 * - el recargo no se cobra sobre sí mismo ni forma parte de la base del IVA.
 * `payments` llevan su monto ya convertido, sin redondear, a la moneda del documento.
 */
export function computeSurcharges(
  totalMinor: number,
  payments: readonly { amountMinor: Big; surcharge: PaymentSurcharge | null }[],
  toLegal: ToLegal,
): SurchargeGroup[] {
  if (totalMinor <= 0) return []
  let remaining = new Big(totalMinor)
  for (const p of payments) {
    if (!p.surcharge && p.amountMinor.gt(0)) remaining = remaining.minus(p.amountMinor)
  }

  const bases = new Map<string, { rateBp: number; base: Big }>()
  for (const p of payments) {
    if (!p.surcharge || p.amountMinor.lte(0) || remaining.lte(0)) continue
    const covered = p.amountMinor.lt(remaining) ? p.amountMinor : remaining
    remaining = remaining.minus(covered)
    const key = `${p.surcharge.surchargeId}|${p.surcharge.rateBp}`
    const group = bases.get(key) ?? { rateBp: p.surcharge.rateBp, base: new Big(0) }
    group.base = group.base.plus(covered)
    bases.set(key, group)
  }

  const out: SurchargeGroup[] = []
  for (const [key, { rateBp, base }] of bases) {
    const baseMinor = roundToInteger(base, "half-up")
    if (baseMinor === 0) continue
    const baseLegalMinor = toLegal(baseMinor)
    out.push({
      surchargeId: key.slice(0, key.lastIndexOf("|")),
      rateBp,
      baseMinor,
      amountMinor: applyRate(baseMinor, rateBp),
      baseLegalMinor,
      amountLegalMinor: applyRate(baseLegalMinor, rateBp),
    })
  }
  return out
}
