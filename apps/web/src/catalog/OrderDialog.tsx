import type { PlacedOrder, PublicCatalog } from "@millhiore/contracts"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
} from "@millhiore/ui"
import { CheckCircle2Icon, MessageCircleIcon, MinusIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useState } from "react"
import { formatMoney, formatQtyUnit } from "../lib/format"
import {
  type CartLine,
  type Customer,
  lineTotal,
  loadCustomer,
  newOrderId,
  parseQty,
  priced,
  saveCustomer,
  setLineQty,
  whatsappText,
} from "./cart"

async function placeOrder(body: unknown): Promise<PlacedOrder> {
  let res: Response
  try {
    res = await fetch("/api/public/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error("No hay conexión con la tienda. Revisa tu internet y vuelve a intentar.")
  }
  const data = (await res.json().catch(() => null)) as
    | (PlacedOrder & { error?: undefined })
    | { error?: { message?: string; issues?: { message: string }[] } }
    | null
  if (res.ok && data && !data.error) return data as PlacedOrder
  const error = data?.error
  throw new Error(error?.issues?.[0]?.message ?? error?.message ?? "No se pudo mandar el pedido")
}

/** El pedido del cliente: lo que lleva, sus datos y mandarlo (a la tienda y por WhatsApp). */
export function OrderDialog({
  catalog,
  lines,
  onChange,
  onClose,
  onPlaced,
}: {
  catalog: PublicCatalog
  lines: CartLine[]
  onChange: (lines: CartLine[]) => void
  onClose: () => void
  onPlaced: () => void
}) {
  const orders = catalog.orders
  const saved = loadCustomer()
  const [customer, setCustomer] = useState<Customer>({
    name: saved.name ?? "",
    phone: saved.phone ?? "",
    delivery: "pickup",
    address: saved.address ?? "",
    payment: "",
    note: "",
  })
  // El mismo id en cada reintento: si la respuesta se pierde, el pedido no se anota dos veces.
  const [orderId] = useState(newOrderId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState<PlacedOrder | null>(null)
  const set = <K extends keyof Customer>(key: K, value: Customer[K]) =>
    setCustomer((c) => ({ ...c, [key]: value }))
  const p = priced(lines, catalog)
  // La línea del pedido guardado que corresponde a una con precio (por producto e indicaciones).
  const at = (l: CartLine) =>
    lines.findIndex((x) => x.variantId === l.variantId && (x.note ?? "") === (l.note ?? ""))
  const money = (ref: number | null, legal: number | null) =>
    ref !== null && catalog.currencies !== "legal"
      ? formatMoney(ref, catalog.referenceCurrency)
      : legal !== null
        ? formatMoney(legal, catalog.legalCurrency)
        : ""

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const order = await placeOrder({
        id: orderId,
        name: customer.name,
        phone: customer.phone,
        delivery: customer.delivery,
        address: customer.delivery === "delivery" ? customer.address : null,
        payment: customer.payment || null,
        note: customer.note || null,
        lines: p.lines.map((l) => ({ variantId: l.variantId, qtyMilli: l.qtyMilli, note: l.note })),
      })
      saveCustomer(customer)
      setPlaced(order)
      onPlaced()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (placed) {
    const wa = catalog.whatsapp
      ? `https://wa.me/${catalog.whatsapp}?text=${encodeURIComponent(whatsappText(placed, customer))}`
      : null
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2Icon className="size-5 text-success" /> Pedido {placed.number}
            </DialogTitle>
            <DialogDescription>
              {wa
                ? "Quedó anotado en la tienda. Mándalo por WhatsApp para que te confirmen y te digan cómo pagar."
                : "Quedó anotado en la tienda: te van a contactar al teléfono que dejaste."}
            </DialogDescription>
          </DialogHeader>
          <p className="font-semibold text-lg tabular">
            Total: {money(placed.totalReferenceMinor, placed.totalLegalMinor)}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Seguir viendo
            </Button>
            {wa ? (
              <Button asChild className="bg-[#25d366] text-white hover:bg-[#1ebe5a]">
                <a href={wa} target="_blank" rel="noreferrer">
                  <MessageCircleIcon /> Enviar por WhatsApp
                </a>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mi pedido</DialogTitle>
          <DialogDescription>
            Revisa lo que llevas y deja tus datos: la tienda te confirma por WhatsApp.
          </DialogDescription>
        </DialogHeader>
        {p.lines.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground text-sm">Tu pedido está vacío.</p>
        ) : (
          <form id="order-form" onSubmit={submit} className="grid min-w-0 grid-cols-1 gap-4">
            <ul className="grid gap-2">
              {p.lines.map((l) => (
                <li
                  key={`${l.variantId}-${l.note ?? ""}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{l.name}</span>
                    {l.note ? (
                      <span className="block truncate text-muted-foreground text-xs">{l.note}</span>
                    ) : null}
                    {!l.available ? (
                      <span className="block text-destructive text-xs">Se acabó: quítalo</span>
                    ) : null}
                  </span>
                  {l.unit === "unit" ? (
                    <span className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        aria-label={`Uno menos de ${l.name}`}
                        onClick={() => onChange(setLineQty(lines, at(l), l.qtyMilli - 1000))}
                      >
                        <MinusIcon />
                      </Button>
                      <span className="w-6 text-center tabular">{l.qtyMilli / 1000}</span>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        aria-label={`Uno más de ${l.name}`}
                        onClick={() => onChange(setLineQty(lines, at(l), l.qtyMilli + 1000))}
                      >
                        <PlusIcon />
                      </Button>
                    </span>
                  ) : (
                    <span className="tabular">{formatQtyUnit(l.qtyMilli, l.unit)}</span>
                  )}
                  <span className="w-20 text-right tabular">
                    {money(
                      l.referenceMinor === null ? null : lineTotal(l.referenceMinor, l.qtyMilli),
                      l.legalMinor === null ? null : lineTotal(l.legalMinor, l.qtyMilli),
                    )}
                  </span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Quitar ${l.name}`}
                    onClick={() => onChange(setLineQty(lines, at(l), 0))}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
            <p className="flex justify-between border-t pt-2 font-semibold tabular">
              <span>Total</span>
              <span>{money(p.reference, p.legal)}</span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Tu nombre" htmlFor="o-name">
                <Input
                  id="o-name"
                  value={customer.name}
                  onChange={(e) => set("name", e.target.value)}
                  maxLength={80}
                  required
                  autoComplete="name"
                />
              </Field>
              <Field label="Tu teléfono" htmlFor="o-phone">
                <Input
                  id="o-phone"
                  value={customer.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  maxLength={40}
                  required
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="0414-1234567"
                />
              </Field>
            </div>
            <fieldset className="grid min-w-0 gap-2 text-sm">
              <legend className="mb-1 font-medium text-sm">Entrega</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="delivery"
                  className="size-4 accent-[var(--primary)]"
                  checked={customer.delivery === "pickup"}
                  onChange={() => set("delivery", "pickup")}
                />
                Lo retiro en la tienda
              </label>
              {orders?.delivery ? (
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="delivery"
                    className="size-4 accent-[var(--primary)]"
                    checked={customer.delivery === "delivery"}
                    onChange={() => set("delivery", "delivery")}
                  />
                  Delivery
                </label>
              ) : null}
            </fieldset>
            {customer.delivery === "delivery" ? (
              <Field label="Dirección" htmlFor="o-address">
                <Input
                  id="o-address"
                  value={customer.address}
                  onChange={(e) => set("address", e.target.value)}
                  maxLength={200}
                  required
                  autoComplete="street-address"
                />
              </Field>
            ) : null}
            {orders?.payments.length ? (
              <Field label="¿Cómo vas a pagar?" htmlFor="o-payment">
                <NativeSelect
                  id="o-payment"
                  value={customer.payment}
                  onChange={(e) => set("payment", e.target.value)}
                >
                  <option value="">Lo veo con la tienda</option>
                  {orders.payments.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            <Field label="Nota" htmlFor="o-note" hint="Opcional">
              <Textarea
                id="o-note"
                rows={2}
                maxLength={300}
                value={customer.note}
                onChange={(e) => set("note", e.target.value)}
              />
            </Field>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </form>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Seguir viendo
          </Button>
          <Button
            type="submit"
            form="order-form"
            disabled={busy || p.lines.length === 0 || p.lines.some((l) => !l.available)}
          >
            {busy ? "Mandando…" : "Hacer el pedido"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Cuánto agregar: unidades con − y +, o el peso escrito (0,5 kg). */
export function QuantityInput({
  unit,
  value,
  onChange,
}: {
  unit: CartLine["unit"]
  value: string
  onChange: (text: string) => void
}) {
  if (unit === "unit") {
    const n = Math.max(1, Number.parseInt(value, 10) || 1)
    return (
      <span className="flex items-center gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label="Uno menos"
          disabled={n <= 1}
          onClick={() => onChange(String(n - 1))}
        >
          <MinusIcon />
        </Button>
        <span className="w-8 text-center tabular" data-testid="cantidad">
          {n}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label="Uno más"
          onClick={() => onChange(String(n + 1))}
        >
          <PlusIcon />
        </Button>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5">
      <Input
        aria-label="Cantidad"
        inputMode="decimal"
        className="h-8 w-20 tabular"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="text-muted-foreground text-sm">{unit}</span>
      {parseQty(value) === null ? (
        <span className="text-destructive text-xs">Escribe cuánto, p. ej. 0,5</span>
      ) : null}
    </span>
  )
}
