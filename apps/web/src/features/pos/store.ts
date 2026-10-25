import type { CatalogItem, Contact, PickedModifier, ProductUnit } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { type DiscountSpec, lineKey, type TicketCharge } from "./compute"

export interface TicketLine {
  variantId: string
  name: string
  qtyMilli: number
  /** Por kilo, litro o metro: la cantidad lleva decimales y se cambia escribiéndola. */
  unit?: ProductUnit | undefined
  /** Precio del catálogo en su moneda; se pasa a Bs con la tasa al cobrar. */
  priceMinor: number
  priceCurrency: string
  taxId: string | null
  /** Descuento dado a esta línea; exige el permiso de dar descuentos. */
  discount?: DiscountSpec | undefined
  /** Precio congelado de una cotización: no le aplica la lista de precios. */
  fixedPrice?: boolean | undefined
  /** Clave propia de una línea con opciones (cada combinación va aparte); si falta, el producto. */
  key?: string | undefined
  /** Opciones y extras elegidos (término, queso extra). */
  modifiers?: PickedModifier[] | undefined
  /** Indicaciones para la cocina. */
  note?: string | null | undefined
}

/** Lo que se eligió al agregar un producto con opciones. */
export interface LineExtras {
  modifiers: PickedModifier[]
  note: string | null
}

/** La cotización que se está vendiendo: la venta la deja convertida. */
export interface PosQuote {
  id: string
  number: string
  contact: Contact | null
  validUntil: number
}

/** El pedido del catálogo en línea que se está cobrando: la venta lo deja atendido. */
export interface PosOrder {
  id: string
  number: string
  customerName: string
  customerPhone: string
}

/**
 * La cuenta de una mesa que se está cobrando (toda o una parte): qué productos de la cuenta, y
 * cuánto de cada uno, paga esta venta.
 */
export interface PosTab {
  id: string
  number: string
  /** «Mesa 4», «Juan (barra)». */
  label: string
  lines: { lineId: string; qtyMilli: number }[]
  /** Quien atiende la mesa: a quien va la propina, si no se elige otro. */
  waiterId?: string | null
}

/** Un ticket aparcado mientras se atiende a otro cliente. */
export interface HeldTicket {
  saleId: string
  heldAt: number
  lines: TicketLine[]
  saleDiscount?: DiscountSpec | null | undefined
  priceListId?: string | null | undefined
  charges?: TicketCharge[] | null | undefined
  quote?: PosQuote | null | undefined
  tab?: PosTab | null | undefined
  order?: PosOrder | null | undefined
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
  /** Lista de precios de la venta (al mayor…); null = precios normales. */
  priceListId: string | null
  /** Recargos elegidos (delivery, servicio…); null = los que se agregan solos. */
  charges: TicketCharge[] | null
  /** Cotización que se está vendiendo; null si la venta no sale de una. */
  quote: PosQuote | null
  /** Cuenta de una mesa que se está cobrando; sus productos no se tocan en la caja. */
  tab: PosTab | null
  /** Pedido del catálogo que se está cobrando; null si la venta no sale de uno. */
  order: PosOrder | null
  held: HeldTicket[]
  /**
   * Carga una cotización en la caja con sus precios congelados. Si había otra venta en curso,
   * queda en espera.
   */
  loadQuote: (
    quote: PosQuote,
    ticket: { lines: TicketLine[]; saleDiscount: DiscountSpec | null; charges: TicketCharge[] },
  ) => void
  /** Carga lo que se cobra de una mesa; si había otra venta en curso, queda en espera. */
  loadTab: (tab: PosTab, lines: TicketLine[]) => void
  /** Deja de vender la cotización (la venta sigue como una normal). */
  detachQuote: () => void
  /**
   * Carga un pedido del catálogo con la lista de precios con que se pidió. Si había otra venta en
   * curso, queda en espera.
   */
  loadOrder: (order: PosOrder, lines: TicketLine[], priceListId: string | null) => void
  /** Deja de cobrar el pedido (la venta sigue como una normal). */
  detachOrder: () => void
  setPriceList: (priceListId: string | null) => void
  setCharges: (charges: TicketCharge[]) => void
  setLineDiscount: (key: string, discount: DiscountSpec | null) => void
  setSaleDiscount: (discount: DiscountSpec | null) => void
  /** Agrega un producto: con opciones o indicaciones va en una línea aparte. */
  add: (item: CatalogItem, qtyMilli?: number, extras?: LineExtras) => void
  setQty: (key: string, qtyMilli: number) => void
  remove: (key: string) => void
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
      priceListId: null,
      charges: null,
      quote: null,
      tab: null,
      order: null,
      loadQuote: (quote, ticket) =>
        set((s) => ({
          held: s.lines.length
            ? [
                ...s.held,
                {
                  saleId: s.saleId,
                  heldAt: Date.now(),
                  lines: s.lines,
                  saleDiscount: s.saleDiscount,
                  priceListId: s.priceListId,
                  charges: s.charges,
                  quote: s.quote,
                  tab: s.tab,
                  order: s.order,
                },
              ]
            : s.held,
          saleId: uuidv7(),
          lines: ticket.lines,
          saleDiscount: ticket.saleDiscount,
          priceListId: null,
          charges: ticket.charges,
          quote,
          tab: null,
          order: null,
        })),
      loadTab: (tab, lines) =>
        set((s) => ({
          held:
            s.lines.length && s.tab?.id !== tab.id
              ? [
                  ...s.held,
                  {
                    saleId: s.saleId,
                    heldAt: Date.now(),
                    lines: s.lines,
                    saleDiscount: s.saleDiscount,
                    priceListId: s.priceListId,
                    charges: s.charges,
                    quote: s.quote,
                    tab: s.tab,
                    order: s.order,
                  },
                ]
              : s.held,
          saleId: uuidv7(),
          lines,
          saleDiscount: null,
          priceListId: null,
          charges: null,
          quote: null,
          tab,
          order: null,
        })),
      detachQuote: () => set({ quote: null }),
      loadOrder: (order, lines, priceListId) =>
        set((s) => ({
          held: s.lines.length
            ? [
                ...s.held,
                {
                  saleId: s.saleId,
                  heldAt: Date.now(),
                  lines: s.lines,
                  saleDiscount: s.saleDiscount,
                  priceListId: s.priceListId,
                  charges: s.charges,
                  quote: s.quote,
                  tab: s.tab,
                  order: s.order,
                },
              ]
            : s.held,
          saleId: uuidv7(),
          lines,
          saleDiscount: null,
          priceListId,
          charges: null,
          quote: null,
          tab: null,
          order,
        })),
      detachOrder: () => set({ order: null }),
      setPriceList: (priceListId) => set({ priceListId }),
      setCharges: (charges) => set({ charges }),
      setLineDiscount: (key, discount) =>
        set((s) => ({
          lines: s.lines.map((l) => {
            if (lineKey(l) !== key) return l
            const { discount: _old, ...rest } = l
            return discount ? { ...rest, discount } : rest
          }),
        })),
      setSaleDiscount: (discount) => set({ saleDiscount: discount }),
      add: (item, qtyMilli = 1000, extras) =>
        set((s) => {
          const plain = !extras?.modifiers.length && !extras?.note
          const existing = plain
            ? s.lines.find((l) => l.variantId === item.variantId && !l.key)
            : undefined
          if (existing) {
            return {
              lines: s.lines.map((l) =>
                l === existing ? { ...l, qtyMilli: l.qtyMilli + qtyMilli } : l,
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
                ...(item.unit !== "unit" ? { unit: item.unit } : {}),
                priceMinor: item.priceMinor,
                priceCurrency: item.priceCurrency,
                taxId: item.taxId,
                ...(plain
                  ? {}
                  : {
                      key: uuidv7(),
                      modifiers: extras?.modifiers ?? [],
                      note: extras?.note ?? null,
                    }),
              },
            ],
          }
        }),
      setQty: (key, qtyMilli) =>
        set((s) => ({
          lines:
            qtyMilli > 0
              ? s.lines.map((l) => (lineKey(l) === key ? { ...l, qtyMilli } : l))
              : s.lines.filter((l) => lineKey(l) !== key),
        })),
      remove: (key) =>
        set((s) => {
          const lines = s.lines.filter((l) => lineKey(l) !== key)
          return { lines, ...(lines.length ? {} : { saleDiscount: null }) }
        }),
      reset: () =>
        set({
          saleId: uuidv7(),
          lines: [],
          saleDiscount: null,
          priceListId: null,
          charges: null,
          quote: null,
          tab: null,
          order: null,
        }),
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
                    priceListId: s.priceListId,
                    charges: s.charges,
                    quote: s.quote,
                    tab: s.tab,
                    order: s.order,
                  },
                ],
                saleId: uuidv7(),
                lines: [],
                saleDiscount: null,
                priceListId: null,
                charges: null,
                quote: null,
                tab: null,
                order: null,
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
                    priceListId: s.priceListId,
                    charges: s.charges,
                    quote: s.quote,
                    tab: s.tab,
                    order: s.order,
                  },
                ]
              : others,
            saleId: ticket.saleId,
            lines: ticket.lines,
            saleDiscount: ticket.saleDiscount ?? null,
            priceListId: ticket.priceListId ?? null,
            charges: ticket.charges ?? null,
            quote: ticket.quote ?? null,
            tab: ticket.tab ?? null,
            order: ticket.order ?? null,
          }
        }),
      discardHeld: (saleId) => set((s) => ({ held: s.held.filter((t) => t.saleId !== saleId) })),
    }),
    { name: "millhiore.pos", storage: createJSONStorage(() => localStorage) },
  ),
)
