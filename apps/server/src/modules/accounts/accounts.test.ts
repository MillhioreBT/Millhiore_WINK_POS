import { beforeEach, describe, expect, test } from "bun:test"
import type { Account, PostedDocumentBody, TransferRow } from "@millhiore/contracts"
import { paymentMethod } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { cashAccountIds, type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const RATE = { base: "USD", quote: "VES", value: "36.5" }
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

const accounts = async (cookie: string, all = false) =>
  (await (await h.call(`/api/accounts${all ? "?all=true" : ""}`, { cookie })).json()) as Account[]
const byName = async (cookie: string, name: string, all = false) => {
  const a = (await accounts(cookie, all)).find((x) => x.name === name)
  if (!a) throw new Error(`no hay cuenta ${name}`)
  return a
}
const transfers = async (cookie: string) =>
  (await (await h.call("/api/transfers", { cookie })).json()) as TransferRow[]

const transferBody = (
  terminalId: string,
  from: Account,
  to: Account,
  fromAmountMinor: number,
  toAmountMinor = fromAmountMinor,
  over: Record<string, unknown> = {},
) => ({
  id: uuidv7(),
  terminalId,
  fromAccountId: from.id,
  toAccountId: to.id,
  fromAmountMinor,
  toAmountMinor,
  rate: RATE,
  ...over,
})

async function withUsers(owner: string) {
  for (const [username, roleId] of [
    ["pedro", "cashier"],
    ["ana", "manager"],
  ] as const) {
    await h.call("/api/users", {
      cookie: owner,
      body: { name: username, username, password: "otra-clave-1", roleId },
    })
  }
  return {
    cashier: await h.login("pedro", "otra-clave-1"),
    manager: await h.login("ana", "otra-clave-1"),
  }
}

describe("cuentas", () => {
  test("lista las cuentas de fábrica con su saldo y los métodos que las usan", async () => {
    const { owner } = await setUp(h)
    const list = await accounts(owner)
    expect(list.map((a) => a.name).sort()).toEqual([
      "Efectivo USD",
      "Efectivo VES",
      "Pago móvil",
      "Punto de venta",
      "Zelle",
    ])
    expect(list.every((a) => a.balanceMinor === 0 && a.active)).toBe(true)
    expect(list.find((a) => a.name === "Zelle")).toMatchObject({
      kind: "wallet",
      currency: "USD",
      methods: ["Zelle"],
    })
  })

  test("crear una cuenta crea su método de pago; el nombre no se repite", async () => {
    const { owner } = await setUp(h)
    const res = await h.call("/api/accounts", {
      cookie: owner,
      body: { name: "Banesco", kind: "bank", currency: "VES" },
    })
    expect(res.status).toBe(201)
    const banesco = (await res.json()) as Account
    expect(banesco).toMatchObject({
      name: "Banesco",
      kind: "bank",
      currency: "VES",
      balanceMinor: 0,
      active: true,
      methods: ["Banesco"],
    })
    const method = h.db
      .select()
      .from(paymentMethod)
      .all()
      .find((m) => m.name === "Banesco")
    expect(method).toMatchObject({ accountId: banesco.id, requiresReference: true, active: true })
    expect(method?.surchargeId).toBeNull()

    const again = await h.call("/api/accounts", {
      cookie: owner,
      body: { name: "Banesco", kind: "bank", currency: "VES" },
    })
    expect(again.status).toBe(409)
    expect(await errorCode(again)).toBe("DUPLICATE_NAME")
    // El efectivo no se crea desde aquí.
    expect(
      (
        await h.call("/api/accounts", {
          cookie: owner,
          body: { name: "Caja chica", kind: "cash", currency: "USD" },
        })
      ).status,
    ).toBe(422)
  })

  test("renombrar la cuenta renombra su método; desactivarla lo oculta", async () => {
    const { owner } = await setUp(h)
    const zelle = await byName(owner, "Zelle")
    const renamed = await h.call(`/api/accounts/${zelle.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { name: "Zelle Mercantil" },
    })
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as Account).methods).toEqual(["Zelle Mercantil"])

    const off = await h.call(`/api/accounts/${zelle.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { active: false },
    })
    expect(off.status).toBe(200)
    expect((await accounts(owner)).some((a) => a.id === zelle.id)).toBe(false)
    expect((await accounts(owner, true)).find((a) => a.id === zelle.id)?.active).toBe(false)
    expect(
      h.db
        .select()
        .from(paymentMethod)
        .all()
        .filter((m) => m.accountId === zelle.id),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ active: false })]))
    // Reactivar devuelve el método.
    await h.call(`/api/accounts/${zelle.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { active: true },
    })
    expect((await byName(owner, "Zelle Mercantil")).methods).toEqual(["Zelle Mercantil"])

    const clash = await h.call(`/api/accounts/${zelle.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { name: "Pago móvil" },
    })
    expect(clash.status).toBe(409)
    expect(await errorCode(clash)).toBe("DUPLICATE_NAME")
    expect(
      (
        await h.call("/api/accounts/no-existe", {
          cookie: owner,
          method: "PATCH",
          body: { name: "X" },
        })
      ).status,
    ).toBe(404)
  })

  test("no se desactiva el efectivo ni una cuenta con dinero", async () => {
    const s = await setUp(h)
    const cashUsd = await byName(s.owner, "Efectivo USD")
    const zelle = await byName(s.owner, "Zelle")
    const cash = await h.call(`/api/accounts/${cashUsd.id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { active: false },
    })
    expect(cash.status).toBe(409)
    expect(await errorCode(cash)).toBe("CASH_ACCOUNT")

    expect(
      (
        await h.call("/api/transfers", {
          cookie: s.owner,
          body: transferBody(s.terminalId, cashUsd, zelle, 500),
        })
      ).status,
    ).toBe(201)
    const withMoney = await h.call(`/api/accounts/${zelle.id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { active: false },
    })
    expect(withMoney.status).toBe(409)
    expect(await errorCode(withMoney)).toBe("ACCOUNT_HAS_BALANCE")

    // Devuelto el dinero, ya se puede.
    expect(
      (
        await h.call("/api/transfers", {
          cookie: s.owner,
          body: transferBody(s.terminalId, zelle, cashUsd, 500),
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await h.call(`/api/accounts/${zelle.id}`, {
          cookie: s.owner,
          method: "PATCH",
          body: { active: false },
        })
      ).status,
    ).toBe(200)
  })

  test("una cuenta en divisas lleva el IGTF solo si el negocio es sujeto pasivo especial", async () => {
    const { owner } = await setUp(h)
    const settings = await h.call("/api/settings/fiscal", {
      cookie: owner,
      method: "PUT",
      body: { taxpayer: "special" },
    })
    expect(settings.status).toBe(200)
    await h.call("/api/accounts", {
      cookie: owner,
      body: { name: "Zelle Banesco", kind: "wallet", currency: "USD" },
    })
    await h.call("/api/accounts", {
      cookie: owner,
      body: { name: "Banesco", kind: "bank", currency: "VES" },
    })
    const methods = h.db.select().from(paymentMethod).all()
    expect(methods.find((m) => m.name === "Zelle Banesco")?.surchargeId).not.toBeNull()
    expect(methods.find((m) => m.name === "Banesco")?.surchargeId).toBeNull()
  })
})

describe("transferencias", () => {
  test("mover dinero entre cuentas de la misma moneda", async () => {
    const s = await setUp(h)
    const cashUsd = await byName(s.owner, "Efectivo USD")
    const zelle = await byName(s.owner, "Zelle")
    const body = transferBody(s.terminalId, cashUsd, zelle, 2500, 2500, {
      reference: "OP-77",
      note: "Depósito",
    })
    const res = await h.call("/api/transfers", { cookie: s.owner, body })
    expect(res.status).toBe(201)
    const posted = (await res.json()) as PostedDocumentBody
    expect(posted).toMatchObject({ number: "C1-TR-000001", totalMinor: 2500 })
    expect((await byName(s.owner, "Efectivo USD")).balanceMinor).toBe(-2500)
    expect((await byName(s.owner, "Zelle")).balanceMinor).toBe(2500)

    const rows = await transfers(s.owner)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: posted.id,
      fromAccountName: "Efectivo USD",
      fromCurrency: "USD",
      fromAmountMinor: 2500,
      toAccountName: "Zelle",
      toCurrency: "USD",
      toAmountMinor: 2500,
      reference: "OP-77",
      note: "Depósito",
      reversedBy: null,
    })
    expect(checkInvariants(h.db)).toEqual([])

    // Reintentar con el mismo id no transfiere dos veces.
    const again = await h.call("/api/transfers", { cookie: s.owner, body })
    expect(again.status).toBe(200)
    expect((await byName(s.owner, "Zelle")).balanceMinor).toBe(2500)
    expect(await transfers(s.owner)).toHaveLength(1)
  })

  test("con cambio de moneda se indica lo que sale y lo que entra", async () => {
    const s = await setUp(h)
    const zelle = await byName(s.owner, "Zelle")
    const mobile = await byName(s.owner, "Pago móvil")
    const res = await h.call("/api/transfers", {
      cookie: s.owner,
      body: transferBody(s.terminalId, zelle, mobile, 1000, 36_000),
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as PostedDocumentBody).totalLegalMinor).toBe(36_500)
    expect((await byName(s.owner, "Zelle")).balanceMinor).toBe(-1000)
    expect((await byName(s.owner, "Pago móvil")).balanceMinor).toBe(36_000)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("rechaza cuentas iguales, montos distintos en la misma moneda y cuentas inactivas", async () => {
    const s = await setUp(h)
    const cashUsd = await byName(s.owner, "Efectivo USD")
    const zelle = await byName(s.owner, "Zelle")
    const mobile = await byName(s.owner, "Pago móvil")
    const post = (body: unknown) => h.call("/api/transfers", { cookie: s.owner, body })

    const same = await post(transferBody(s.terminalId, zelle, zelle, 100))
    expect(same.status).toBe(422)
    const uneven = await post(transferBody(s.terminalId, cashUsd, zelle, 100, 90))
    expect(uneven.status).toBe(422)
    expect((await post(transferBody(s.terminalId, cashUsd, zelle, 0))).status).toBe(422)
    expect(
      (await post(transferBody(s.terminalId, cashUsd, { ...zelle, id: "no-existe" }, 100))).status,
    ).toBe(422)

    await h.call(`/api/accounts/${mobile.id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { active: false },
    })
    const inactive = await post(transferBody(s.terminalId, cashUsd, mobile, 100, 3650))
    expect(inactive.status).toBe(422)
    expect(await errorCode(inactive)).toBe("UNKNOWN_ACCOUNT")
    expect(await transfers(s.owner)).toEqual([])
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("si toca el efectivo exige turno abierto; entre bancos no", async () => {
    const s = await setUp(h)
    const cashUsd = await byName(s.owner, "Efectivo USD")
    const zelle = await byName(s.owner, "Zelle")
    const mobile = await byName(s.owner, "Pago móvil")
    const shift = (await (
      await h.call(`/api/shifts/current?terminalId=${s.terminalId}`, { cookie: s.owner })
    ).json()) as { id: string }
    await h.call(`/api/shifts/${shift.id}/close`, {
      cookie: s.owner,
      body: {
        counts: Object.values(cashAccountIds(h)).map((accountId) => ({
          accountId,
          countedMinor: 0,
        })),
      },
    })
    const cash = await h.call("/api/transfers", {
      cookie: s.owner,
      body: transferBody(s.terminalId, cashUsd, zelle, 100),
    })
    expect(cash.status).toBe(409)
    expect(await errorCode(cash)).toBe("SHIFT_CLOSED")
    const banks = await h.call("/api/transfers", {
      cookie: s.owner,
      body: transferBody(s.terminalId, zelle, mobile, 100, 3650),
    })
    expect(banks.status).toBe(201)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("anular una transferencia devuelve el dinero y no se anula dos veces", async () => {
    const s = await setUp(h)
    const cashUsd = await byName(s.owner, "Efectivo USD")
    const zelle = await byName(s.owner, "Zelle")
    const res = await h.call("/api/transfers", {
      cookie: s.owner,
      body: transferBody(s.terminalId, cashUsd, zelle, 700),
    })
    const { id } = (await res.json()) as PostedDocumentBody
    const voided = await h.call(`/api/documents/${id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Me equivoqué de cuenta" },
    })
    expect(voided.status).toBe(201)
    expect((await byName(s.owner, "Efectivo USD")).balanceMinor).toBe(0)
    expect((await byName(s.owner, "Zelle")).balanceMinor).toBe(0)
    const rows = await transfers(s.owner)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === id)?.reversedBy).not.toBeNull()
    expect(rows.find((r) => r.reversesDocumentId === id)).toBeDefined()
    expect(checkInvariants(h.db)).toEqual([])
    const twice = await h.call(`/api/documents/${id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(twice.status).toBe(409)
  })

  test("el cajero ni transfiere ni administra cuentas; el administrador sí", async () => {
    const s = await setUp(h)
    const { cashier, manager } = await withUsers(s.owner)
    const cashUsd = await byName(s.owner, "Efectivo USD")
    const zelle = await byName(s.owner, "Zelle")

    expect((await h.call("/api/accounts", { cookie: cashier })).status).toBe(403)
    expect((await h.call("/api/transfers", { cookie: cashier })).status).toBe(403)
    expect(
      (
        await h.call("/api/transfers", {
          cookie: cashier,
          body: transferBody(s.terminalId, cashUsd, zelle, 100),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await h.call("/api/accounts", {
          cookie: cashier,
          body: { name: "Banesco", kind: "bank", currency: "VES" },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await h.call(`/api/accounts/${zelle.id}`, {
          cookie: cashier,
          method: "PATCH",
          body: { name: "X" },
        })
      ).status,
    ).toBe(403)

    expect((await h.call("/api/accounts", { cookie: manager })).status).toBe(200)
    const done = await h.call("/api/transfers", {
      cookie: manager,
      body: transferBody(s.terminalId, cashUsd, zelle, 100),
    })
    expect(done.status).toBe(201)
    const { id } = (await done.json()) as PostedDocumentBody
    // El cajero tampoco puede anularla.
    expect(
      (
        await h.call(`/api/documents/${id}/void`, {
          cookie: cashier,
          body: { reversalId: uuidv7(), reason: "x" },
        })
      ).status,
    ).toBe(403)
  })

  test("el POST general de documentos no sirve para transferir", async () => {
    const s = await setUp(h)
    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "TRANSFER",
        terminalId: s.terminalId,
        currency: "USD",
        rate: RATE,
        lines: [],
        payments: [],
      },
    })
    expect(res.status).toBe(422)
  })
})
