import type { TaxBook } from "@millhiore/contracts"
import { business, contact, type Db, document, documentTax, fiscalInvoice } from "@millhiore/db"
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import { inBranches } from "../branches/service"

type Group = TaxBook["rows"][number]["groups"][number]

const KIND_ORDER = { taxed: 0, exempt: 1, exonerated: 2, not_subject: 3 } as const

/**
 * Libro de ventas o de compras de un rango, documento por documento, con la base y el IVA de cada
 * alícuota en moneda legal (cada documento a su tasa). Las devoluciones y las anulaciones entran
 * con signo contrario y dicen qué documento afectan. Es informativo: las notas de venta no son
 * facturas fiscales, y los gastos no entran porque se guardan sin separar el IVA.
 */
export function taxBook(
  db: Db,
  opts: {
    kind: "sales" | "purchases"
    from: number
    to: number
    branchIds?: readonly string[] | null
  },
): TaxBook {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const types =
    opts.kind === "sales"
      ? (["SALE", "RETURN"] as const)
      : (["PURCHASE", "PURCHASE_RETURN"] as const)
  const where = and(
    inArray(document.type, [...types]),
    gte(document.postedAt, opts.from),
    lt(document.postedAt, opts.to),
    inBranches(document.locationId, opts.branchIds ?? null),
  )
  const reversed = alias(document, "reversed")
  const returned = alias(document, "returned")
  const docs = db
    .select({
      id: document.id,
      number: document.number,
      type: document.type,
      postedAt: document.postedAt,
      reversesNumber: reversed.number,
      returnsNumber: returned.number,
      // Los datos que quedaron en el documento; los de antes de guardarlos, los de hoy.
      contactName: sql<string | null>`coalesce(${document.customerName}, ${contact.name})`,
      contactTaxId: sql<
        string | null
      >`case when ${document.customerName} is null then ${contact.taxId} else ${document.customerTaxId} end`,
      externalRef: document.externalRef,
      invoiceNumber: fiscalInvoice.invoiceNumber,
      controlNumber: fiscalInvoice.controlNumber,
      totalLegalMinor: document.totalLegalMinor,
      surchargeLegalMinor: document.surchargeLegalMinor,
    })
    .from(document)
    .leftJoin(contact, eq(contact.id, document.contactId))
    .leftJoin(fiscalInvoice, eq(fiscalInvoice.documentId, document.id))
    .leftJoin(reversed, eq(reversed.id, document.reversesDocumentId))
    .leftJoin(returned, eq(returned.id, document.returnsDocumentId))
    .where(where)
    .orderBy(asc(document.postedAt), asc(document.number))
    .all()

  const taxesByDoc = new Map<string, Group[]>()
  const rates = new Map<string, TaxBook["rates"][number]>()
  for (const t of db
    .select({
      documentId: documentTax.documentId,
      kind: documentTax.kind,
      rateBp: documentTax.rateBp,
      baseLegalMinor: documentTax.baseLegalMinor,
      taxLegalMinor: documentTax.taxLegalMinor,
    })
    .from(documentTax)
    .innerJoin(document, eq(document.id, documentTax.documentId))
    .where(where)
    .all()) {
    // Lo que no paga IVA va junto aunque tenga distintas alícuotas guardadas (siempre 0 %).
    const rateBp = t.kind === "taxed" ? t.rateBp : 0
    const key = `${t.kind}:${rateBp}`
    rates.set(key, { key, kind: t.kind, rateBp })
    const groups = taxesByDoc.get(t.documentId) ?? []
    const g = groups.find((x) => x.key === key)
    if (g) {
      g.baseLegalMinor += t.baseLegalMinor
      g.taxLegalMinor += t.taxLegalMinor
    } else {
      groups.push({ key, baseLegalMinor: t.baseLegalMinor, taxLegalMinor: t.taxLegalMinor })
    }
    taxesByDoc.set(t.documentId, groups)
  }

  const totals = new Map<string, Group>()
  let total = 0
  let surcharge = 0
  const rows = docs.map((d) => {
    // Una devolución resta lo que la venta sumó (se guarda en positivo); una anulación ya trae
    // sus montos con el signo contrario.
    const sign = d.type === "RETURN" || d.type === "PURCHASE_RETURN" ? -1 : 1
    const groups = (taxesByDoc.get(d.id) ?? []).map((g) => ({
      key: g.key,
      baseLegalMinor: sign * g.baseLegalMinor,
      taxLegalMinor: sign * g.taxLegalMinor,
    }))
    for (const g of groups) {
      const t = totals.get(g.key) ?? { key: g.key, baseLegalMinor: 0, taxLegalMinor: 0 }
      t.baseLegalMinor += g.baseLegalMinor
      t.taxLegalMinor += g.taxLegalMinor
      totals.set(g.key, t)
    }
    total += sign * d.totalLegalMinor
    surcharge += sign * d.surchargeLegalMinor
    return {
      id: d.id,
      number: d.number,
      type: d.type as TaxBook["rows"][number]["type"],
      postedAt: d.postedAt,
      voids: d.reversesNumber,
      returns: d.type === "RETURN" || d.type === "PURCHASE_RETURN" ? d.returnsNumber : null,
      contactName: d.contactName,
      contactTaxId: d.contactTaxId,
      externalRef: d.externalRef,
      invoiceNumber: d.invoiceNumber,
      controlNumber: d.controlNumber,
      totalLegalMinor: sign * d.totalLegalMinor,
      surchargeLegalMinor: sign * d.surchargeLegalMinor,
      groups,
    }
  })

  return {
    kind: opts.kind,
    from: opts.from,
    to: opts.to,
    legalCurrency: biz.legalCurrency,
    rates: [...rates.values()].sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.rateBp - a.rateBp,
    ),
    rows,
    totals: {
      totalLegalMinor: total,
      surchargeLegalMinor: surcharge,
      groups: [...totals.values()],
    },
  }
}
