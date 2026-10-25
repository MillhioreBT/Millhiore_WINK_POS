import { describe, expect, test } from "bun:test"
import type { Bootstrap } from "@millhiore/contracts"
import {
  amountToSettle,
  autoCharges,
  buildCart,
  type CartLine,
  changeIn,
  computeCheckout,
  computeTicket,
  creditToLeave,
  creditUsable,
  lineKey,
  makeContext,
  type PaymentEntry,
  qtyForMoney,
  type StoredLine,
  unitPriceInDoc,
  unitWithModifiers,
} from "./compute"

const bootstrap = (taxpayer: "ordinary" | "special" | "none" = "special"): Bootstrap => ({
  business: {
    name: "B",
    referenceCurrency: "USD",
    legalCurrency: "VES",
    timezone: "America/Caracas",
    taxId: null,
    address: null,
    phone: null,
    receiptFooter: null,
  },
  terminals: [{ id: "t", code: "C1", name: "Caja 1", locationId: "l", branchId: "main" }],
  branches: [{ id: "main", name: "Principal", address: null, phone: null, priceListId: null }],
  locations: [{ id: "l", name: "Tienda", kind: "store", branchId: "main" }],
  discountCodes: 0,
  features: {
    quotes: true,
    priceLists: true,
    charges: true,
    recurring: true,
    payables: true,
    locations: false,
    lots: false,
    variants: false,
    tables: false,
    modifiers: false,
    kitchen: false,
    recipes: false,
    tips: false,
    scale: false,
    branches: false,
    catalog: false,
  },
  scale: null,
  staff: [],
  modifierGroups: [],
  charges: [
    {
      id: "delivery",
      name: "Delivery",
      kind: "fixed",
      rateBp: 0,
      amountMinor: 200,
      currency: "USD",
      taxId: null,
      auto: false,
    },
    {
      id: "servicio",
      name: "Servicio",
      kind: "percent",
      rateBp: 1000,
      amountMinor: 0,
      currency: null,
      taxId: null,
      auto: true,
    },
  ],
  priceLists: [
    {
      id: "mayor",
      name: "Al mayor",
      adjustBp: -1000,
      prices: [{ variantId: "own", priceMinor: 50, priceCurrency: "USD" }],
    },
  ],
  printer: { mode: "browser", paperWidth: 80, autoPrint: false, openDrawer: false },
  currencies: [
    { code: "USD", name: "Dólar", symbol: "$", decimals: 2 },
    { code: "VES", name: "Bolívar", symbol: "Bs", decimals: 2 },
  ],
  paymentMethods: [
    {
      id: "usd",
      accountId: "a-usd",
      name: "Efectivo USD",
      currency: "USD",
      kind: "cash",
      requiresReference: false,
      surcharge: taxpayer === "special" ? { id: "igtf", name: "IGTF", rateBp: 300 } : null,
    },
    {
      id: "ves",
      accountId: "a-ves",
      name: "Efectivo VES",
      currency: "VES",
      kind: "cash",
      requiresReference: false,
      surcharge: null,
    },
    {
      id: "pm",
      accountId: "a-pm",
      name: "Pago móvil",
      currency: "VES",
      kind: "mobile",
      requiresReference: true,
      surcharge: null,
    },
  ],
  taxes: [
    {
      id: "iva-general",
      code: "G",
      name: "IVA general",
      kind: "taxed",
      rateBp: 1600,
      active: true,
    },
    { id: "exento", code: "E", name: "Exento", kind: "exempt", rateBp: 0, active: true },
  ],
  fiscal: { taxpayer, pricesIncludeTax: true, defaultTaxId: "iva-general", invoices: false },
  credit: { enabled: true },
  security: { autoLockMinutes: 0 },
  central: null,
})

const ctx = makeContext(bootstrap(), "877.9023")
const pay = (methodId: string, currency: string, amountMinor: number): PaymentEntry => ({
  id: `${methodId}-${amountMinor}`,
  methodId,
  currency,
  amountMinor,
  reference: null,
})
const method = (id: string) => {
  const m = ctx.methods.find((x) => x.id === id)
  if (!m) throw new Error(id)
  return m
}

// Agua a 1,16 $ con IVA incluido → 1.018,37 Bs
const agua: CartLine = {
  variantId: "v",
  name: "Agua",
  qtyMilli: 1000,
  unitPriceMinor: unitPriceInDoc(ctx, 116, "USD") ?? 0,
  taxId: null,
}

describe("caja", () => {
  test("convierte el precio a Bs y desglosa el IVA incluido", () => {
    expect(agua.unitPriceMinor).toBe(101837)
    const t = computeTicket(ctx, [agua])
    expect(t.totalMinor).toBe(101837)
    expect(t.taxes[0]).toMatchObject({ baseMinor: 87791, taxMinor: 14046 })
  })

  test("pagar todo en dólares con IGTF: el monto sugerido salda la cuenta", () => {
    const t = computeTicket(ctx, [agua])
    const usd = amountToSettle(ctx, t, [], method("usd"))
    expect(usd).toBe(119) // 1,16 + IGTF 3 % ≈ 1,19 $
    const c = computeCheckout(ctx, t, [pay("usd", "USD", usd)])
    expect(c.settled).toBe(true)
    expect(c.surchargeMinor).toBe(3055) // 3 % de 1.018,37 Bs
  })

  test("pago mixto: el resto en Bs sin IGTF, luego vuelto", () => {
    const t = computeTicket(ctx, [agua, { ...agua, qtyMilli: 2000 }])
    const ves = amountToSettle(ctx, t, [], method("ves"))
    expect(ves).toBe(t.totalMinor)
    const partial = [pay("usd", "USD", 200)]
    const rest = amountToSettle(ctx, t, partial, method("pm"))
    const c = computeCheckout(ctx, t, [...partial, pay("pm", "VES", rest)])
    expect(c.settled).toBe(true)
    // Los Bs cubren primero; los 2 $ cubren el resto y solo esa parte paga IGTF.
    const base = c.surcharges[0]?.baseMinor ?? 0
    expect(base).toBeGreaterThan(0)
    expect(base).toBeLessThanOrEqual(t.totalMinor - rest + 1)
  })

  test("la propina se cobra aparte: suma a lo que se cobra pero no paga IGTF", () => {
    const t = { ...computeTicket(ctx, [agua]), tipMinor: 10_000 }
    expect(amountToSettle(ctx, t, [], method("ves"))).toBe(101837 + 10_000)
    const usd = amountToSettle(ctx, t, [], method("usd"))
    const c = computeCheckout(ctx, t, [pay("usd", "USD", usd)])
    expect(c.settled).toBe(true)
    // El IGTF sigue siendo el 3 % de la venta, no de la propina.
    expect(c.surchargeMinor).toBe(3055)
    expect(c.dueMinor).toBe(101837 + 3055 + 10_000)
  })

  test("pagar de más en dólares da vuelto en Bs que cuadra", () => {
    const t = computeTicket(ctx, [agua])
    const paid = [pay("usd", "USD", 500)]
    const c = computeCheckout(ctx, t, paid)
    expect(c.settled).toBe(false)
    const change = changeIn(ctx, c, "VES")
    expect(change).toBeGreaterThan(0)
    const after = computeCheckout(ctx, t, [...paid, pay("ves", "VES", -change)])
    expect(after.settled).toBe(true)
    // el IGTF es sobre la cuenta, no sobre los 5 $ entregados
    expect(after.surchargeMinor).toBe(3055)
  })

  test("quien no cobra IVA ni IGTF vende al precio sin desglose", () => {
    const c0 = makeContext(bootstrap("none"), "877.9023")
    const t = computeTicket(c0, [agua])
    expect(t.taxMinor).toBe(0)
    expect(amountToSettle(c0, t, [], method("usd"))).toBe(116)
  })

  test("sin tasa no se puede convertir un precio en divisas", () => {
    const noRate = makeContext(bootstrap(), null)
    expect(unitPriceInDoc(noRate, 116, "USD")).toBeNull()
    expect(unitPriceInDoc(noRate, 5000, "VES")).toBe(5000)
  })
})

describe("fiado en la caja", () => {
  // 3 aguas = 3.055,11 Bs; el dólar a 877,9023 Bs.
  const tres = computeTicket(ctx, [{ ...agua, qtyMilli: 3000 }])

  test("lo que falta se deja a deber en dólares y la cuenta cuadra", () => {
    const partial = [pay("pm", "VES", 100000)] // 1.000 Bs
    const credit = creditToLeave(ctx, tres, partial, "USD")
    expect(credit).toBe(234) // 2.055,11 Bs ≈ 2,34 $
    const c = computeCheckout(ctx, tres, partial, { currency: "USD", amountMinor: credit })
    expect(c.settled).toBe(true)
    expect(c.creditDocMinor).toBe(Math.round((234 * 877.9023 * 100) / 100))
    // Sin el fiado, la cuenta no estaba saldada.
    expect(computeCheckout(ctx, tres, partial).settled).toBe(false)
  })

  test("todo a deber: sin pagos, el fiado es la cuenta entera", () => {
    const credit = creditToLeave(ctx, tres, [], "USD")
    expect(credit).toBe(348) // 3.055,11 Bs ≈ 3,48 $
    const c = computeCheckout(ctx, tres, [], { currency: "USD", amountMinor: credit })
    expect(c.settled).toBe(true)
    expect(c.surchargeMinor).toBe(0)
  })

  test("el IGTF se cobra solo sobre lo que se paga ahora en divisas", () => {
    const partial = [pay("usd", "USD", 100)] // 1,00 $ en efectivo con IGTF
    const credit = creditToLeave(ctx, tres, partial, "USD")
    const c = computeCheckout(ctx, tres, partial, { currency: "USD", amountMinor: credit })
    expect(c.settled).toBe(true)
    // Los 1,00 $ incluyen el IGTF de su propia base: la base es menor que 1,00 $ (877,90 Bs).
    expect(c.surcharges[0]?.baseMinor).toBeLessThan(87790)
    expect(c.surcharges[0]?.baseMinor).toBeGreaterThan(80000)
    // Y el fiado resultante es menor que sin pagar con divisas con IGTF.
    expect(credit).toBeLessThan(348 - 100 + 5)
  })

  test("si ya está pagado o sobra dinero no se puede fiar", () => {
    expect(creditToLeave(ctx, tres, [pay("ves", "VES", tres.totalMinor)], "USD")).toBe(0)
    expect(creditToLeave(ctx, tres, [pay("ves", "VES", tres.totalMinor + 5000)], "USD")).toBe(0)
  })

  test("sin tasa no se puede llevar una deuda en dólares a una factura en bolívares", () => {
    const noRate = makeContext(bootstrap(), null)
    expect(creditUsable(noRate, "USD")).toBe(false)
    expect(creditUsable(noRate, "VES")).toBe(true)
    expect(creditUsable(ctx, "USD")).toBe(true)
  })
})

describe("descuentos en la caja", () => {
  const stored = (qtyMilli: number, extra: Partial<StoredLine> = {}): StoredLine => ({
    variantId: `v${qtyMilli}`,
    name: "Agua",
    qtyMilli,
    priceMinor: 116,
    priceCurrency: "USD",
    taxId: null,
    ...extra,
  })

  test("sin descuento el ticket queda igual", () => {
    const cart = buildCart(ctx, [stored(1000)], null)
    expect(cart.ticket.totalMinor).toBe(101837)
    expect(cart.ticket.discountMinor).toBe(0)
    expect(cart.lines[0]?.discountMinor).toBe(0)
  })

  test("un porcentaje en una línea baja su total y el IVA sale de lo que queda", () => {
    const cart = buildCart(ctx, [stored(1000, { discount: { kind: "percent", bp: 1000 } })], null)
    // 10 % de 1.018,37 = 101,837 → 101,84 (mitad hacia arriba)
    expect(cart.lines[0]?.discountMinor).toBe(10184)
    expect(cart.ticket.totalMinor).toBe(101837 - 10184)
    const base = cart.ticket.taxes[0]
    expect((base?.baseMinor ?? 0) + (base?.taxMinor ?? 0)).toBe(cart.ticket.totalMinor)
  })

  test("un monto en dólares se convierte a Bs con la tasa", () => {
    const cart = buildCart(
      ctx,
      [stored(2000, { discount: { kind: "amount", amountMinor: 100, currency: "USD" } })],
      null,
    )
    expect(cart.lines[0]?.discountMinor).toBe(87790) // 1,00 $ × 877,9023
  })

  test("el descuento nunca pasa del importe", () => {
    const cart = buildCart(
      ctx,
      [stored(1000, { discount: { kind: "amount", amountMinor: 10_000, currency: "USD" } })],
      null,
    )
    expect(cart.lines[0]?.discountMinor).toBe(101837)
    expect(cart.ticket.totalMinor).toBe(0)
  })

  test("el descuento a toda la venta se reparte entre las líneas y suma exacto", () => {
    const lines = [stored(1000), stored(3000), stored(7000, { priceMinor: 333 })]
    const noDiscount = buildCart(ctx, lines, null)
    const cart = buildCart(ctx, lines, { kind: "percent", bp: 750 })
    const wanted = Math.round(noDiscount.ticket.totalMinor * 0.075)
    // Σ de lo repartido = lo que se pidió descontar (±1 por el redondeo del porcentaje)
    expect(Math.abs(cart.ticket.discountMinor - wanted)).toBeLessThanOrEqual(1)
    expect(cart.ticket.totalMinor).toBe(noDiscount.ticket.totalMinor - cart.ticket.discountMinor)
    // Cada línea descuenta en proporción a su importe, nunca más que su importe.
    cart.lines.forEach((l, i) => {
      const gross = noDiscount.ticket.lineTotals[i] ?? 0
      expect(l.discountMinor ?? 0).toBeGreaterThan(0)
      expect(l.discountMinor ?? 0).toBeLessThanOrEqual(gross)
    })
  })

  test("el descuento de línea y el de la venta se acumulan", () => {
    const lines = [stored(1000, { discount: { kind: "percent", bp: 1000 } }), stored(2000)]
    const only = buildCart(ctx, lines, null)
    const both = buildCart(ctx, lines, { kind: "amount", amountMinor: 50000, currency: "VES" })
    expect(both.ticket.discountMinor).toBe(only.ticket.discountMinor + 50000)
  })
})

describe("listas de precios en la caja", () => {
  const line = (variantId: string): StoredLine => ({
    variantId,
    name: "Refresco",
    qtyMilli: 1000,
    priceMinor: 100,
    priceCurrency: "USD",
    taxId: null,
  })

  test("sin lista vale el precio normal; con lista, el propio o el ajuste de la lista", () => {
    const normal = buildCart(ctx, [line("v"), line("own")], null)
    expect(normal.lines.map((l) => l.unitPriceMinor)).toEqual([87790, 87790]) // 1 $ = 877,90 Bs
    const mayor = buildCart(ctx, [line("v"), line("own")], null, "mayor")
    // 1,00 $ − 10 % = 0,90 $ y el precio propio, 0,50 $.
    expect(mayor.lines.map((l) => l.unitPriceMinor)).toEqual([79011, 43895])
  })

  test("una lista que ya no existe cae en el precio normal", () => {
    const cart = buildCart(ctx, [line("v")], null, "borrada")
    expect(cart.lines[0]?.unitPriceMinor).toBe(87790)
  })

  test("el descuento de la venta se calcula sobre los precios de la lista", () => {
    const cart = buildCart(ctx, [line("v")], { kind: "percent", bp: 1000 }, "mayor")
    expect(cart.ticket.discountMinor).toBe(7901)
  })
})

describe("recargos en la caja", () => {
  const line = (): StoredLine => ({
    variantId: "v",
    name: "Pan",
    qtyMilli: 2000,
    priceMinor: 150,
    priceCurrency: "USD",
    taxId: null,
  })

  test("el delivery sugerido se convierte a Bs y suma al total", () => {
    const cart = buildCart(ctx, [line()], null, null, [{ chargeId: "delivery" }])
    // 2 × 1,50 $ = 2.633,70 Bs; delivery 2 $ = 1.755,80 Bs.
    expect(cart.ticket.charges.map((c) => [c.name, c.amountMinor])).toEqual([["Delivery", 175580]])
    expect(cart.ticket.totalMinor).toBe(263370 + 175580)
  })

  test("el monto escrito manda sobre el sugerido", () => {
    const cart = buildCart(ctx, [line()], null, null, [
      { chargeId: "delivery", amount: { amountMinor: 50000, currency: "VES" } },
    ])
    expect(cart.ticket.charges[0]?.amountMinor).toBe(50000)
  })

  test("el servicio es un % del subtotal sin IVA, como en el servidor", () => {
    const cart = buildCart(ctx, [line()], null, null, autoCharges(ctx))
    const base = cart.ticket.charges[0]?.baseMinor ?? 0
    expect(cart.ticket.charges[0]).toMatchObject({ name: "Servicio", rateBp: 1000 })
    expect(cart.ticket.charges[0]?.amountMinor).toBe(Math.round(base / 10))
    expect(base).toBe(227043) // 2.633,70 / 1,16
  })

  test("sin productos no hay recargos, y un recargo desconocido se ignora", () => {
    expect(buildCart(ctx, [], null, null, [{ chargeId: "delivery" }]).ticket.totalMinor).toBe(0)
    expect(buildCart(ctx, [line()], null, null, [{ chargeId: "nope" }]).ticket.charges).toEqual([])
  })
})

describe("venta por peso", () => {
  test("lo que pide el cliente en dinero se pasa a peso al precio por kilo", () => {
    // Queso a 12 $ el kilo (Bs 10.534,83): 5 $ son 0,417 kg y Bs 100, 0,009 kg.
    const perKg = unitPriceInDoc(ctx, 1200, "USD")
    expect(perKg).toBe(1_053_483)
    expect(qtyForMoney(ctx, { minor: 500, currency: "USD" }, perKg)).toBe(417)
    expect(qtyForMoney(ctx, { minor: 10_000, currency: "VES" }, perKg)).toBe(9)
    expect(qtyForMoney(ctx, { minor: 500, currency: "USD" }, null)).toBeNull()
    // Sin tasa no se convierten dólares.
    const noRate = makeContext(bootstrap(), null)
    expect(qtyForMoney(noRate, { minor: 500, currency: "USD" }, perKg)).toBeNull()
  })
})

describe("opciones y extras", () => {
  const burger: StoredLine = {
    key: "k1",
    variantId: "b",
    name: "Hamburguesa",
    qtyMilli: 2000,
    priceMinor: 500,
    priceCurrency: "USD",
    taxId: null,
    modifiers: [
      { id: "t", name: "Bien cocida", priceMinor: 0, priceCurrency: null },
      { id: "q", name: "Queso", priceMinor: 100, priceCurrency: "USD" },
      { id: "s", name: "Salsa de la casa", priceMinor: 3650, priceCurrency: "VES" },
    ],
    note: "sin cebolla",
  }

  test("cada extra suma su precio (en su moneda) al del producto", () => {
    const unit = unitWithModifiers(ctx, 500, "USD", burger.modifiers)
    expect(unit).toBe((unitPriceInDoc(ctx, 600, "USD") ?? 0) + 3650)
    const cart = buildCart(ctx, [burger], null, null)
    expect(cart.lines[0]).toMatchObject({
      key: "k1",
      unitPriceMinor: unit,
      note: "sin cebolla",
    })
    expect(cart.lines[0]?.modifiers?.map((m) => m.id)).toEqual(["t", "q", "s"])
    expect(cart.ticket.totalMinor).toBe((unit ?? 0) * 2)
    // Sin tasa, el extra en dólares no se puede convertir.
    const noRate = makeContext(bootstrap(), null)
    expect(unitWithModifiers(noRate, 3650, "VES", burger.modifiers)).toBeNull()
  })

  test("cada línea con opciones tiene su clave; las demás, el producto", () => {
    expect(lineKey(burger)).toBe("k1")
    expect(lineKey({ variantId: "v" })).toBe("v")
  })
})
