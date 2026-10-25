import type { CatalogItem, PickedModifier, TabLine, TabSummary } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { LineExtras, TicketLine } from "../pos/store"

/** Lo que falta por cobrar: ni anulado ni pagado. */
export const isPending = (l: TabLine) => l.voidedAt === null && l.documentId === null

/** Cómo se nombra una mesa: «Mesa 4» si se llama con un número, si no, su nombre («Barra 2»). */
export function tableName(name: string): string {
  return /^\d/.test(name) ? `Mesa ${name}` : name
}

/** El nombre con que se habla de la cuenta: «Mesa 4», «Terraza 2», o el de una sin mesa. */
export function tabLabel(t: Pick<TabSummary, "tableName" | "label" | "number">): string {
  return t.tableName ? tableName(t.tableName) : (t.label ?? t.number)
}

/** Minutos desde que se abrió, para ver qué mesa lleva más tiempo. */
export function elapsed(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** Cuánto se toma de cada línea pendiente (por id); si falta, toda la línea. */
export type Takes = Readonly<Record<string, number>>

/**
 * Lo pendiente (o lo elegido de ello) como líneas de la caja, con su precio congelado: las del
 * mismo producto y precio se juntan, como en un recibo. `refs` es lo que la venta le dice al
 * servidor que cobra de la cuenta.
 */
export function chargeLines(
  lines: readonly TabLine[],
  takes?: Takes,
): { lines: TicketLine[]; refs: { lineId: string; qtyMilli: number }[] } {
  const refs: { lineId: string; qtyMilli: number }[] = []
  const grouped = new Map<string, TicketLine>()
  for (const l of lines) {
    if (!isPending(l)) continue
    const qtyMilli = Math.min(takes ? (takes[l.id] ?? 0) : l.qtyMilli, l.qtyMilli)
    if (qtyMilli <= 0) continue
    refs.push({ lineId: l.id, qtyMilli })
    const key = [l.variantId, l.priceMinor, l.priceCurrency, ...l.modifiers.map((m) => m.id)].join(
      "|",
    )
    const same = grouped.get(key)
    if (same) same.qtyMilli += qtyMilli
    else {
      grouped.set(key, {
        variantId: l.variantId,
        name: l.name,
        qtyMilli,
        priceMinor: l.priceMinor,
        priceCurrency: l.priceCurrency,
        taxId: l.taxId,
        fixedPrice: true,
        ...(l.modifiers.length ? { key, modifiers: l.modifiers } : {}),
      })
    }
  }
  return { lines: [...grouped.values()], refs }
}

/** Un producto del pedido que se está armando, aún sin enviar. */
export interface DraftLine {
  /** El id con que se guardará: reenviar el pedido no lo repite. */
  id: string
  variantId: string
  name: string
  qtyMilli: number
  priceMinor: number
  priceCurrency: string
  taxId: string | null
  note: string | null
  modifiers: PickedModifier[]
}

/**
 * Agrega un producto al pedido: suma al que ya está sin opciones ni indicaciones o abre una línea
 * nueva (con lo elegido, siempre aparte).
 */
export function addToDraft(
  draft: readonly DraftLine[],
  item: CatalogItem,
  extras?: LineExtras,
): DraftLine[] {
  const plain = !extras?.modifiers.length && !extras?.note
  const same = plain
    ? draft.find((l) => l.variantId === item.variantId && !l.note && !l.modifiers.length)
    : undefined
  if (same) {
    return draft.map((l) => (l === same ? { ...l, qtyMilli: l.qtyMilli + 1000 } : l))
  }
  return [
    ...draft,
    {
      id: uuidv7(),
      variantId: item.variantId,
      name: item.name,
      qtyMilli: 1000,
      priceMinor: item.priceMinor,
      priceCurrency: item.priceCurrency,
      taxId: item.taxId,
      note: extras?.note ?? null,
      modifiers: extras?.modifiers ?? [],
    },
  ]
}

interface DraftState {
  /** El pedido en curso de cada cuenta (sobrevive a una recarga o a cambiar de pantalla). */
  drafts: Record<string, DraftLine[]>
  add: (tabId: string, item: CatalogItem, extras?: LineExtras) => void
  setQty: (tabId: string, lineId: string, qtyMilli: number) => void
  setNote: (tabId: string, lineId: string, note: string | null) => void
  clear: (tabId: string) => void
}

export const useDrafts = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      add: (tabId, item, extras) =>
        set((s) => ({
          drafts: { ...s.drafts, [tabId]: addToDraft(s.drafts[tabId] ?? [], item, extras) },
        })),
      setQty: (tabId, lineId, qtyMilli) =>
        set((s) => ({
          drafts: {
            ...s.drafts,
            [tabId]: (s.drafts[tabId] ?? []).flatMap((l) =>
              l.id !== lineId ? [l] : qtyMilli > 0 ? [{ ...l, qtyMilli }] : [],
            ),
          },
        })),
      setNote: (tabId, lineId, note) =>
        set((s) => ({
          drafts: {
            ...s.drafts,
            [tabId]: (s.drafts[tabId] ?? []).map((l) =>
              l.id === lineId ? { ...l, note: note?.trim() || null } : l,
            ),
          },
        })),
      clear: (tabId) =>
        set((s) => {
          const { [tabId]: _, ...rest } = s.drafts
          return { drafts: rest }
        }),
    }),
    { name: "millhiore.tab-drafts", storage: createJSONStorage(() => localStorage) },
  ),
)
