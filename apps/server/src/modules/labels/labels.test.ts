import { beforeEach, describe, expect, test } from "bun:test"
import type { LabelSettings } from "@millhiore/contracts"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

describe("ajustes de etiquetas", () => {
  test("rollo de 50 × 25 por defecto; se cambian y quedan en la bitácora", async () => {
    const { owner } = await setUp(h)
    const get = async () =>
      (await (await h.call("/api/settings/labels", { cookie: owner })).json()) as LabelSettings
    expect(await get()).toEqual({
      paper: "roll",
      widthMm: 50,
      heightMm: 25,
      price: "reference",
      showBusiness: false,
      showSku: false,
    })
    const sheet = { ...(await get()), paper: "letter-3x10", price: "both", showSku: true }
    const res = await h.call("/api/settings/labels", { method: "PUT", cookie: owner, body: sheet })
    expect(res.status).toBe(200)
    expect(await get()).toEqual(sheet as LabelSettings)
    const bad = await h.call("/api/settings/labels", {
      method: "PUT",
      cookie: owner,
      body: { ...sheet, widthMm: 5 },
    })
    expect(bad.status).toBe(422)
  })

  test("solo quien gestiona el catálogo los cambia", async () => {
    const { owner } = await setUp(h)
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Caja", username: "caja", password: "clave-segura-2", roleId: "cashier" },
    })
    const cashier = await h.login("caja", "clave-segura-2")
    expect((await h.call("/api/settings/labels", { cookie: cashier })).status).toBe(200)
    const res = await h.call("/api/settings/labels", {
      method: "PUT",
      cookie: cashier,
      body: {
        paper: "roll",
        widthMm: 40,
        heightMm: 30,
        price: "none",
        showBusiness: true,
        showSku: false,
      },
    })
    expect(res.status).toBe(403)
  })
})
