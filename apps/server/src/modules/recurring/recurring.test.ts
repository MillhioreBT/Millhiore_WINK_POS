import { beforeEach, describe, expect, test } from "bun:test"
import type { Contact, ExpenseCategory, Payables, RecurringExpense } from "@millhiore/contracts"
import { auditLog, contact, recurringExpense } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, setUp } from "../../testing/harness"
import { generateDueRecurring } from "./service"

let h: Harness
beforeEach(() => {
  h = harness()
})

// El reloj del arnés es el 9 de octubre de 2025 (hora de Caracas).
const TODAY = "2025-10-09"
const RATE = { base: "USD", quote: "VES", value: "36.5" }
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

async function setup() {
  const s = await setUp(h)
  const cats = (await (
    await h.call("/api/expense-categories", { cookie: s.owner })
  ).json()) as ExpenseCategory[]
  const rent = cats.find((c) => c.name === "Alquiler") as ExpenseCategory
  const landlord = (await (
    await h.call("/api/contacts", {
      cookie: s.owner,
      body: { kind: "supplier", name: "Inmobiliaria Centro", creditDays: 5 },
    })
  ).json()) as Contact
  return { ...s, rent, landlord }
}

const create = (cookie: string, body: Record<string, unknown>) =>
  h.call("/api/recurring-expenses", { cookie, body })

const list = async (cookie: string) =>
  (await (await h.call("/api/recurring-expenses", { cookie })).json()) as RecurringExpense[]

describe("gastos recurrentes", () => {
  test("se crean, se listan con lo que ya venció primero y se pausan", async () => {
    const s = await setup()
    const base = {
      categoryId: s.rent.id,
      contactId: s.landlord.id,
      currency: "USD",
      amountMinor: 30_000,
      frequency: "monthly",
    }
    const late = await create(s.owner, {
      ...base,
      note: "Alquiler del local",
      firstDueDay: "2025-10-01",
    })
    expect(late.status).toBe(201)
    const created = (await late.json()) as RecurringExpense
    expect(created).toMatchObject({
      note: "Alquiler del local",
      categoryName: "Alquiler",
      nextDueDay: "2025-10-01",
      due: true,
      auto: false,
      lastError: null,
    })
    expect(created.contact?.name).toBe("Inmobiliaria Centro")
    await create(s.owner, {
      ...base,
      note: "Internet",
      firstDueDay: "2025-10-20",
      contactId: null,
      amountMinor: 5000,
    })

    const rows = await list(s.owner)
    expect(rows.map((r) => [r.note, r.due])).toEqual([
      ["Alquiler del local", true],
      ["Internet", false],
    ])

    const paused = await h.call(`/api/recurring-expenses/${created.id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { active: false },
    })
    expect(((await paused.json()) as RecurringExpense).due).toBe(false)
    expect((await list(s.owner)).map((r) => r.note)).toEqual(["Internet", "Alquiler del local"])
  })

  test("valida categoría, proveedor y que lo automático tenga a quién deberle", async () => {
    const s = await setup()
    const base = {
      note: "Alquiler",
      categoryId: s.rent.id,
      currency: "USD",
      amountMinor: 100,
      frequency: "monthly",
      firstDueDay: "2025-11-01",
    }
    expect((await create(s.owner, { ...base, auto: true })).status).toBe(422) // sin proveedor
    expect(await errorCode(await create(s.owner, { ...base, auto: true }))).toBe(
      "SUPPLIER_REQUIRED",
    )
    expect((await create(s.owner, { ...base, categoryId: "nada" })).status).toBe(422)
    expect((await create(s.owner, { ...base, currency: "XYZ" })).status).toBe(422)
    expect((await create(s.owner, { ...base, amountMinor: 0 })).status).toBe(422)
    expect((await create(s.owner, { ...base, firstDueDay: "2025-02-30x" })).status).toBe(422)
    const customer = (await (
      await h.call("/api/contacts", {
        cookie: s.owner,
        body: { kind: "customer", name: "Doña Rosa" },
      })
    ).json()) as Contact
    expect((await create(s.owner, { ...base, contactId: customer.id })).status).toBe(422)
    const ok = await create(s.owner, { ...base, contactId: s.landlord.id, auto: true })
    expect(ok.status).toBe(201)
    // Quitarle el proveedor a uno automático no se puede.
    const { id } = (await ok.json()) as RecurringExpense
    const bad = await h.call(`/api/recurring-expenses/${id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { contactId: null },
    })
    expect(bad.status).toBe(422)
  })

  test("solo quien registra gastos los ve o los cambia", async () => {
    const s = await setup()
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/recurring-expenses", { cookie: cashier })).status).toBe(403)
    expect(
      (
        await create(cashier, {
          note: "x",
          categoryId: s.rent.id,
          currency: "USD",
          amountMinor: 1,
          frequency: "weekly",
          firstDueDay: TODAY,
        })
      ).status,
    ).toBe(403)
  })

  test("mover el vencimiento fija el día de referencia de los siguientes meses", async () => {
    const s = await setup()
    const res = await create(s.owner, {
      note: "Sueldo",
      categoryId: s.rent.id,
      currency: "VES",
      amountMinor: 100_000,
      frequency: "monthly",
      firstDueDay: "2025-10-31",
    })
    const { id } = (await res.json()) as RecurringExpense
    const row = () => h.db.select().from(recurringExpense).where(eq(recurringExpense.id, id)).get()
    expect(row()).toMatchObject({ anchorDay: 31, nextDueDay: "2025-10-31" })
    await h.call(`/api/recurring-expenses/${id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { nextDueDay: "2025-11-15" },
    })
    expect(row()).toMatchObject({ anchorDay: 15, nextDueDay: "2025-11-15" })
  })
})

describe("registrar el gasto de un recurrente", () => {
  const expenseBody = (
    s: { terminalId: string; methodUsd: string },
    categoryId: string,
    recurringId: string,
    id = uuidv7(),
  ) => ({
    id,
    terminalId: s.terminalId,
    currency: "USD",
    rate: RATE,
    amountMinor: 30_000,
    categoryId,
    note: "Alquiler del local",
    recurringId,
    payments: [
      {
        id: uuidv7(),
        paymentMethodId: s.methodUsd,
        currency: "USD",
        amountMinor: 30_000,
        rate: null,
      },
    ],
  })

  test("pasa al siguiente vencimiento, y reenviarlo no lo adelanta dos veces", async () => {
    const s = await setup()
    const res = await create(s.owner, {
      note: "Alquiler del local",
      categoryId: s.rent.id,
      currency: "USD",
      amountMinor: 30_000,
      frequency: "monthly",
      firstDueDay: "2025-10-01",
    })
    const rec = (await res.json()) as RecurringExpense
    const id = uuidv7()
    const first = await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s, s.rent.id, rec.id, id),
    })
    expect(first.status).toBe(201)
    expect((await list(s.owner))[0]).toMatchObject({ nextDueDay: "2025-11-01", due: false })

    const again = await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s, s.rent.id, rec.id, id),
    })
    expect(again.status).toBe(200)
    expect((await list(s.owner))[0]?.nextDueDay).toBe("2025-11-01")

    // Un recurrente que no existe no deja registrar el gasto.
    const ghost = await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s, s.rent.id, "no-existe"),
    })
    expect(ghost.status).toBe(404)
    expect(checkInvariants(h.db)).toEqual([])
  })
})

describe("generación automática al vencer", () => {
  const owed = async (cookie: string) =>
    (await (await h.call("/api/payables", { cookie })).json()) as Payables

  /** Un recurrente directo en la base, para probar la tarea sin pasar por el guardado de la API. */
  function seed(
    s: { rent: ExpenseCategory; landlord: Contact },
    nextDueDay: string,
    over: Partial<typeof recurringExpense.$inferInsert> = {},
  ) {
    const id = uuidv7()
    h.db
      .insert(recurringExpense)
      .values({
        id,
        note: "Alquiler del local",
        categoryId: s.rent.id,
        contactId: s.landlord.id,
        currency: "USD",
        amountMinor: 30_000,
        frequency: "monthly",
        anchorDay: Number(nextDueDay.slice(8, 10)),
        nextDueDay,
        auto: true,
        createdAt: h.clock.now,
        ...over,
      })
      .run()
    return id
  }

  test("al guardar un automático que ya venció se registra de inmediato", async () => {
    const s = await setup()
    const res = await create(s.owner, {
      note: "Alquiler del local",
      categoryId: s.rent.id,
      contactId: s.landlord.id,
      currency: "USD",
      amountMinor: 30_000,
      frequency: "monthly",
      firstDueDay: "2025-10-01",
      auto: true,
    })
    // Ya viene con el siguiente vencimiento y el gasto a deber registrado.
    expect(await res.json()).toMatchObject({
      nextDueDay: "2025-11-01",
      due: false,
      lastError: null,
    })
    expect((await owed(s.owner)).suppliers[0]).toMatchObject({
      name: "Inmobiliaria Centro",
      outstandingMinor: 30_000,
    })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("genera el gasto a deber al proveedor y pasa al siguiente periodo; correrlo otra vez no duplica", async () => {
    const s = await setup()
    seed(s, "2025-10-01")
    expect(generateDueRecurring(h.db, h.clock.now)).toEqual({ generated: 1, failed: 0 })

    const debts = await owed(s.owner)
    expect(debts.suppliers[0]).toMatchObject({
      name: "Inmobiliaria Centro",
      outstandingMinor: 30_000,
    })
    expect(debts.suppliers[0]?.open[0]).toMatchObject({
      kind: "EXPENSE",
      label: "Alquiler del local",
    })
    // Con los 5 días de crédito del proveedor.
    expect(debts.suppliers[0]?.nextDueAt).toBe(h.clock.now + 5 * 86_400_000)
    expect((await list(s.owner))[0]).toMatchObject({ nextDueDay: "2025-11-01", due: false })

    expect(generateDueRecurring(h.db, h.clock.now)).toEqual({ generated: 0, failed: 0 })
    expect((await owed(s.owner)).suppliers[0]?.openCount).toBe(1)

    // El gasto no lo hizo nadie en particular: la bitácora dice «Sistema».
    const audit = h.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === "recurring.generated")
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actorId).toBeNull()
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("se pone al día: un gasto por cada periodo atrasado", async () => {
    const s = await setup()
    seed(s, "2025-07-01", { note: "Internet", currency: "VES", amountMinor: 50_000 })
    // 1 de julio, agosto, septiembre y octubre.
    expect(generateDueRecurring(h.db, h.clock.now)).toEqual({ generated: 4, failed: 0 })
    expect((await list(s.owner))[0]?.nextDueDay).toBe("2025-11-01")
    expect((await owed(s.owner)).suppliers[0]).toMatchObject({
      currency: "VES",
      outstandingMinor: 200_000,
      openCount: 4,
    })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("no toca lo pausado, lo que no es automático ni lo que todavía no vence", async () => {
    const s = await setup()
    seed(s, "2025-10-01", { note: "Manual", auto: false })
    seed(s, "2025-10-10", { note: "Futuro" })
    seed(s, "2025-10-01", { note: "Pausado", active: false })
    expect(generateDueRecurring(h.db, h.clock.now)).toEqual({ generated: 0, failed: 0 })
    expect((await owed(s.owner)).suppliers).toEqual([])
  })

  test("lo que no se puede generar queda anotado y se reintenta al corregirlo", async () => {
    const s = await setup()
    const id = seed(s, "2025-10-01")
    h.db.update(contact).set({ active: false }).where(eq(contact.id, s.landlord.id)).run()
    expect(generateDueRecurring(h.db, h.clock.now)).toEqual({ generated: 0, failed: 1 })
    const failed = (await list(s.owner))[0]
    expect(failed).toMatchObject({ nextDueDay: "2025-10-01", due: true })
    expect(failed?.lastError).toContain("Contacto desconocido")

    // Se reactiva el proveedor y se guarda de nuevo: ahora sí se registra.
    h.db.update(contact).set({ active: true }).where(eq(contact.id, s.landlord.id)).run()
    const saved = await h.call(`/api/recurring-expenses/${id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: {},
    })
    expect(await saved.json()).toMatchObject({ nextDueDay: "2025-11-01", lastError: null })
    expect((await owed(s.owner)).suppliers[0]?.openCount).toBe(1)
    expect(checkInvariants(h.db)).toEqual([])
  })
})
