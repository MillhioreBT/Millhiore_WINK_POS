import type { CatalogItem } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { DiscountSpec } from "./compute"

export interface TicketLine {
  variantId: string
  name: string
  qtyMilli: number
  /** Precio del catálogo en su moneda; se pasa a Bs con la tasa al cobrar. */
  priceMinor: number
  priceCurrency: string
  taxId: string | null
  /** Descuento dado a esta línea; exige el permiso de dar descuentos. */
  discount?: DiscountSpec | undefined
}

/** Un ticket aparcado mientras se atiende a otro cliente. */
export interface HeldTicket {
  saleId: string
  heldAt: number
  lines: TicketLine[]
  saleDiscount?: DiscountSpec | null | undefined
}

interface PosState {
  /**
   * Id de la venta en curso, generado aquí: si la red falla y se reintenta, el servidor reconoce
   * la venta y no la cobra dos veces.
   */
  saleId: string
  lines: TicketLine[]
  /** Descuento a toda la venta (se reparte entre las líneas al cobrar). */
  saleDiscount: DiscountSpec | null
  held: HeldTicket[]
  setLineDiscount: (variantId: string, discount: DiscountSpec | null) => void
  setSaleDiscount: (discount: DiscountSpec | null) => void
  add: (item: CatalogItem, qtyMilli?: number) => void
  setQty: (variantId: string, qtyMilli: number) => void
  remove: (variantId: string) => void
  /** Vacía el ticket y prepara una venta nueva. */
  reset: () => void
  /** Aparca el ticket actual (conserva su id) y deja la caja libre. */
  hold: () => void
  /** Retoma un ticket aparcado; si había otro en curso, ese pasa a espera. */
  resume: (saleId: string) => void
  discardHeld: (saleId: string) => void
}

/** El ticket sobrevive a una recarga o un corte de luz (PLAN §5: Zustand persistido). */
export const usePos = create<PosState>()(
  persist(
    (set) => ({
      saleId: uuidv7(),
      lines: [],
      saleDiscount: null,
      setLineDiscount: (variantId, discount) =>
        set((s) => ({
          lines: s.lines.map((l) => {
            if (l.variantId !== variantId) return l
            const { discount: _old, ...rest } = l
            return discount ? { ...rest, discount } : rest
          }),
        })),
      setSaleDiscount: (discount) => set({ saleDiscount: discount }),
      add: (item, qtyMilli = 1000) =>
        set((s) => {
          const existing = s.lines.find((l) => l.variantId === item.variantId)
          if (existing) {
            return {
              lines: s.lines.map((l) =>
                l.variantId === item.variantId ? { ...l, qtyMilli: l.qtyMilli + qtyMilli } : l,
              ),
            }
          }
          return {
            lines: [
              ...s.lines,
              {
                variantId: item.variantId,
                name: item.name,
                qtyMilli,
                priceMinor: item.priceMinor,
                priceCurrency: item.priceCurrency,
                taxId: item.taxId,
              },
            ],
          }
        }),
      setQty: (variantId, qtyMilli) =>
        set((s) => ({
          lines:
            qtyMilli > 0
              ? s.lines.map((l) => (l.variantId === variantId ? { ...l, qtyMilli } : l))
              : s.lines.filter((l) => l.variantId !== variantId),
        })),
      remove: (variantId) =>
        set((s) => {
          const lines = s.lines.filter((l) => l.variantId !== variantId)
          return { lines, ...(lines.length ? {} : { saleDiscount: null }) }
        }),
      reset: () => set({ saleId: uuidv7(), lines: [], saleDiscount: null }),
      held: [],
      hold: () =>
        set((s) =>
          s.lines.length
            ? {
                held: [
                  ...s.held,
                  {
                    saleId: s.saleId,
                    heldAt: Date.now(),
                    lines: s.lines,
                    saleDiscount: s.saleDiscount,
                  },
                ],
                saleId: uuidv7(),
                lines: [],
                saleDiscount: null,
              }
            : {},
        ),
      resume: (saleId) =>
        set((s) => {
          const ticket = s.held.find((t) => t.saleId === saleId)
          if (!ticket) return {}
          const others = s.held.filter((t) => t.saleId !== saleId)
          return {
            held: s.lines.length
              ? [
                  ...others,
                  {
                    saleId: s.saleId,
                    heldAt: Date.now(),
                    lines: s.lines,
                    saleDiscount: s.saleDiscount,
                  },
                ]
              : others,
            saleId: ticket.saleId,
            lines: ticket.lines,
            saleDiscount: ticket.saleDiscount ?? null,
          }
        }),
      discardHeld: (saleId) => set((s) => ({ held: s.held.filter((t) => t.saleId !== saleId) })),
    }),
    { name: "millhiore.pos", storage: createJSONStorage(() => localStorage) },
  ),
)
