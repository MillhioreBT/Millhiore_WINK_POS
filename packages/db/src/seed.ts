import { DEFAULT_ROLES, type TaxKind } from "@millhiore/domain"
import type { Db } from "./client"
import { currency, role, surcharge, tax } from "./schema"

export const DEFAULT_CURRENCIES = [
  { code: "USD", name: "Dólar estadounidense", symbol: "$", decimals: 2 },
  { code: "VES", name: "Bolívar", symbol: "Bs", decimals: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "USDT", name: "Tether", symbol: "₮", decimals: 2 },
] as const

/** Inserta las monedas base si no existen. Es idempotente. */
export function seedCurrencies(db: Db): void {
  db.insert(currency)
    .values(DEFAULT_CURRENCIES.map((c) => ({ ...c })))
    .onConflictDoNothing()
    .run()
}

/**
 * Alícuotas del IVA venezolano vigentes (Ley del IVA): general 16 %, reducida 8 % y general más
 * la adicional de 15 % para bienes y servicios de lujo (31 %). Las letras son las que usan las
 * facturas y las impresoras fiscales. Son editables: los documentos guardan la que aplicaron.
 */
export const DEFAULT_TAXES: readonly {
  id: string
  code: string
  name: string
  kind: TaxKind
  rateBp: number
}[] = [
  { id: "iva-general", code: "G", name: "IVA general", kind: "taxed", rateBp: 1600 },
  { id: "iva-reducido", code: "R", name: "IVA reducido", kind: "taxed", rateBp: 800 },
  {
    id: "iva-lujo",
    code: "A",
    name: "IVA general + adicional (lujo)",
    kind: "taxed",
    rateBp: 3100,
  },
  { id: "exento", code: "E", name: "Exento", kind: "exempt", rateBp: 0 },
]

/** Impuesto de los productos que no tienen uno asignado. */
export const DEFAULT_TAX_ID = "iva-general"

/** IGTF: 3 % sobre pagos en divisas o criptoactivos que percibe un sujeto pasivo especial. */
export const IGTF_SURCHARGE = {
  id: "igtf",
  code: "IGTF",
  name: "IGTF (pagos en divisas)",
  rateBp: 300,
} as const

/** Inserta las alícuotas de IVA y el IGTF si no existen. Es idempotente y no pisa cambios. */
export function seedTaxes(db: Db): void {
  db.insert(tax)
    .values(DEFAULT_TAXES.map((t) => ({ ...t })))
    .onConflictDoNothing()
    .run()
  db.insert(surcharge)
    .values({ ...IGTF_SURCHARGE })
    .onConflictDoNothing()
    .run()
}

/** Inserta los roles de fábrica si no existen. Es idempotente. */
export function seedRoles(db: Db): void {
  db.insert(role)
    .values(
      DEFAULT_ROLES.map((r) => ({
        id: r.id,
        name: r.name,
        permissions: [...r.permissions],
        isSystem: true,
      })),
    )
    .onConflictDoNothing()
    .run()
}
