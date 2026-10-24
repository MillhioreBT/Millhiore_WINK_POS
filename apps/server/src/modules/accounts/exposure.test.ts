import { beforeEach, describe, expect, test } from "bun:test"
import type { ExchangeExposure } from "@millhiore/contracts"
import { paymentMethod } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const DAY = 86_400_000
type Ctx = Awaited<ReturnType<typeof setUp>>

/** Mete (o saca, si es retiro) bolívares de la gaveta a la tasa de ese momento. */
async function cash(s: Ctx, type: "CASH_IN" | "CASH_OUT", amountMinor: number, rate: string) {
  const ves = h.db
    .select()
    .from(paymentMethod)
    .all()
    .find((m) => m.name === "Efectivo VES")?.id
  const res = await h.call("/api/documents", {
    cookie: s.owner,
    body: {
      id: uuidv7(),
      type,
      terminalId: s.terminalId,
      currency: "VES",
      rate: { base: "USD", quote: "VES", value: rate },
      payments: [{ id: uuidv7(), paymentMethodId: ves, currency: "VES", amountMinor }],
    },
  })
  expect(res.status).toBe(201)
}

async function newRate(s: Ctx, value: string) {
  h.clock.now += DAY
  const res = await h.call("/api/rates", { cookie: s.owner, body: { value } })
  expect(res.status).toBe(201)
}

const exposure = async (cookie: string) =>
  (await (await h.call("/api/accounts/exposure", { cookie })).json()) as ExchangeExposure

describe("exposición cambiaria", () => {
  test("compara lo que valían los bolívares al entrar con lo que valen hoy", async () => {
    const s = await setUp(h)
    expect((await exposure(s.owner)).accounts).toEqual([]) // sin saldo no hay exposición

    await cash(s, "CASH_IN", 3_650_000, "36.5") // 36.500 Bs a 36,5 = 1.000 $
    await newRate(s, "40")
    await cash(s, "CASH_IN", 4_000_000, "40") // 40.000 Bs a 40 = 1.000 $
    // Sale la mitad: se lleva la mitad de la base (1.000 $), sin importar qué billete era.
    await cash(s, "CASH_OUT", 3_825_000, "40")
    await newRate(s, "50")

    const e = await exposure(s.owner)
    expect(e.rate?.value).toBe("50.00000000")
    expect(e.accounts).toHaveLength(1) // la cuenta en dólares no se devalúa
    expect(e.accounts[0]).toMatchObject({
      name: "Efectivo VES",
      balanceMinor: 3_825_000,
      basisMinor: 100_000, // entró valiendo 1.000 $
      valueMinor: 76_500, // hoy vale 765 $
      differenceMinor: -23_500,
    })
    expect(e.totals).toMatchObject({ basisMinor: 100_000, differenceMinor: -23_500 })
  })

  test("pide poder ver las finanzas", async () => {
    const s = await setUp(h)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/accounts/exposure", { cookie: cashier })).status).toBe(403)
  })
})
