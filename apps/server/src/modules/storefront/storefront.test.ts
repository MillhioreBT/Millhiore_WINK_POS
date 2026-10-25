import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CatalogItem,
  ProductDetail,
  PublicCatalog,
  ServeResult,
  StorefrontStatus,
} from "@millhiore/contracts"
import { location, stockBalance } from "@millhiore/db"
import { type Harness, harness, setUp } from "../../testing/harness"
import type { Runner } from "../remote/tailscale"
import { createStorefrontApp } from "./app"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** Una compilación de la web de mentira: la página del catálogo, la de la app y un archivo. */
function webRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mwk-web-"))
  dirs.push(dir)
  writeFileSync(join(dir, "index.html"), "<html><title>App</title>LA-CAJA</html>")
  writeFileSync(
    join(dir, "catalogo.html"),
    '<html><head><title>Catálogo</title></head><body><div id="root"></div></body></html>',
  )
  mkdirSync(join(dir, "assets"))
  writeFileSync(join(dir, "assets", "catalog-abc.js"), "console.log(1)")
  return dir
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3, 4, 5])

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

let h: Harness
beforeEach(() => {
  h = harness()
})

async function withCatalog() {
  const s = await setUp(h)
  const res = await h.call("/api/settings/features", {
    method: "PUT",
    cookie: s.owner,
    body: { catalog: true },
  })
  expect(res.status).toBe(200)
  return s
}

const catalog = async (ip?: string) => {
  const res = await h.call("/api/public/catalog", ip ? { ip } : {})
  expect(res.status).toBe(200)
  return (await res.json()) as PublicCatalog
}

const setStorefront = (owner: string, body: Record<string, unknown>) =>
  h.call("/api/storefront", { method: "PUT", cookie: owner, body })

describe("catálogo en línea", () => {
  test("apagado no existe; encendido lo ve cualquiera, sin sesión", async () => {
    const s = await setUp(h)
    const off = await h.call("/api/public/catalog")
    expect(off.status).toBe(404)
    expect(await errorCode(off)).toBe("CATALOG_OFF")
    await h.call("/api/settings/features", {
      method: "PUT",
      cookie: s.owner,
      body: { catalog: true },
    })
    const c = await catalog()
    expect(c.business.name).toBe("Bodega La Esquina")
    expect(c.rate?.value).toBe("36.50000000")
    const pan = c.products.find((p) => p.name === "Pan")
    // 1,50 $ con el IVA incluido (como en la caja) y a la tasa del día en bolívares.
    expect(pan?.variants).toEqual([
      { id: "v1", optionValues: null, referenceMinor: 150, legalMinor: 5475, available: false },
    ])
  })

  test("nunca muestra costos, códigos ni cantidades", async () => {
    const s = await withCatalog()
    const loc = h.db.select().from(location).get()
    if (!loc) throw new Error("sin ubicación")
    h.db
      .insert(stockBalance)
      .values({ variantId: "v1", locationId: loc.id, qtyMilli: 37_000 })
      .run()
    await h.call("/api/products/p1", {
      method: "PATCH",
      cookie: s.owner,
      body: { barcode: "7591234567890" },
    })
    const c = await catalog()
    expect(c.products[0]?.variants[0]?.available).toBe(true)
    const text = JSON.stringify(c)
    for (const secret of ["PAN", "7591234567890", "37000", "cost", "sku", "stock"]) {
      expect(text).not.toContain(secret)
    }
  })

  test("lo apagado, lo escondido y su categoría escondida no salen", async () => {
    const s = await withCatalog()
    const cat = (await (
      await h.call("/api/categories", { cookie: s.owner, body: { name: "Insumos" } })
    ).json()) as { id: string }
    const create = (name: string, extra: Record<string, unknown> = {}) =>
      h.call("/api/products", {
        cookie: s.owner,
        body: { name, kind: "service", priceMinor: 100, priceCurrency: "USD", ...extra },
      })
    expect((await create("Delivery", { description: "En Maracay" })).status).toBe(201)
    expect((await create("Uso interno", { inCatalog: false })).status).toBe(201)
    expect((await create("Harina a granel", { categoryId: cat.id })).status).toBe(201)
    let names = (await catalog()).products.map((p) => p.name)
    expect(names).toEqual(["Delivery", "Harina a granel", "Pan"])
    expect((await catalog()).categories).toEqual([{ id: cat.id, name: "Insumos" }])
    expect((await catalog()).products[0]?.description).toBe("En Maracay")

    expect((await setStorefront(s.owner, { hiddenCategoryIds: [cat.id] })).status).toBe(200)
    names = (await catalog()).products.map((p) => p.name)
    expect(names).toEqual(["Delivery", "Pan"])
    expect((await catalog()).categories).toEqual([])
    // Lo agotado se puede esconder o mostrar como si hubiera.
    await setStorefront(s.owner, { soldOut: "hide" })
    expect((await catalog()).products.map((p) => p.name)).toEqual(["Delivery"])
    await setStorefront(s.owner, { soldOut: "ignore" })
    expect((await catalog()).products.find((p) => p.name === "Pan")?.variants[0]?.available).toBe(
      true,
    )
    // Desactivar el producto lo saca.
    await h.call("/api/products/p1", { method: "PATCH", cookie: s.owner, body: { active: false } })
    expect((await catalog()).products.map((p) => p.name)).toEqual(["Delivery"])
  })

  test("precio para el público: con el IVA si los precios van sin él, y con la lista del catálogo", async () => {
    const s = await withCatalog()
    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: s.owner,
      body: { pricesIncludeTax: false },
    })
    expect((await catalog()).products[0]?.variants[0]?.referenceMinor).toBe(174)
    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: s.owner,
      body: { pricesIncludeTax: true },
    })
    const list = (await (
      await h.call("/api/price-lists", { cookie: s.owner, body: { name: "Web", adjustBp: -1000 } })
    ).json()) as { id: string }
    expect((await setStorefront(s.owner, { priceListId: list.id })).status).toBe(200)
    expect((await catalog()).products[0]?.variants[0]).toMatchObject({
      referenceMinor: 135,
      legalMinor: 4928,
    })
    // Solo en bólivares o solo en dólares: lo dice el catálogo para que la página lo muestre así.
    await setStorefront(s.owner, { currencies: "legal" })
    expect((await catalog()).currencies).toBe("legal")
    const bad = await setStorefront(s.owner, { priceListId: "no-existe" })
    expect(bad.status).toBe(422)
  })

  test("el WhatsApp sale del teléfono del negocio o del que se escriba", async () => {
    const s = await withCatalog()
    expect((await catalog()).whatsapp).toBeNull()
    await h.call("/api/settings/business", {
      method: "PUT",
      cookie: s.owner,
      body: { phone: "0243-5551234" },
    })
    expect((await catalog()).whatsapp).toBe("582435551234")
    await setStorefront(s.owner, { whatsapp: "0414-1112233", message: "  Delivery de 8 a 6  " })
    const c = await catalog()
    expect(c.whatsapp).toBe("584141112233")
    expect(c.message).toBe("Delivery de 8 a 6")
    const bad = await setStorefront(s.owner, { whatsapp: "123" })
    expect(bad.status).toBe(422)
    expect(await errorCode(bad)).toBe("INVALID_PHONE")
  })

  test("las fotos: se ponen, se ven en el catálogo y se quitan; solo fotos de verdad", async () => {
    const s = await withCatalog()
    const put = (raw: Uint8Array, cookie = s.owner, type = "image/jpeg") =>
      h.call("/api/products/p1/image", {
        method: "PUT",
        cookie,
        raw,
        headers: { "content-type": type },
      })
    const res = await put(JPEG)
    expect(res.status).toBe(200)
    const { imageVersion } = (await res.json()) as { imageVersion: number }
    const detail = (await (
      await h.call("/api/products/p1", { cookie: s.owner })
    ).json()) as ProductDetail
    expect(detail.imageVersion).toBe(imageVersion)
    const url = (await catalog()).products[0]?.imageUrl
    expect(url).toBe(`/api/public/catalog/images/p1?v=${imageVersion}`)
    const img = await h.call(url ?? "")
    expect(img.status).toBe(200)
    expect(img.headers.get("content-type")).toBe("image/jpeg")
    expect(img.headers.get("cache-control")).toContain("immutable")
    expect(img.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG)
    // Otra foto cambia la versión (y la dirección).
    const again = (await (await put(JPEG)).json()) as { imageVersion: number }
    expect(again.imageVersion).toBeGreaterThan(imageVersion)

    // Un HTML disfrazado de foto, una vacía o una enorme, no.
    const html = new TextEncoder().encode("<script>alert(1)</script>")
    expect((await put(html, s.owner, "image/png")).status).toBe(422)
    expect((await put(new Uint8Array(0))).status).toBe(422)
    expect((await put(new Uint8Array(1_000_001).fill(0xff))).status).toBe(413)

    // El cajero ve la foto en la app, pero no la cambia.
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await put(JPEG, cashier)).status).toBe(403)
    expect((await h.call("/api/products/p1/image", { cookie: cashier })).status).toBe(200)
    expect((await h.call("/api/products/p1/image")).status).toBe(401)

    // Escondido del catálogo, su foto deja de ser pública.
    await h.call("/api/products/p1", {
      method: "PATCH",
      cookie: s.owner,
      body: { inCatalog: false },
    })
    expect((await h.call("/api/public/catalog/images/p1")).status).toBe(404)
    await h.call("/api/products/p1", {
      method: "PATCH",
      cookie: s.owner,
      body: { inCatalog: true },
    })

    const del = await h.call("/api/products/p1/image", { method: "DELETE", cookie: s.owner })
    expect(del.status).toBe(204)
    expect((await catalog()).products[0]?.imageUrl).toBeNull()
    expect((await h.call("/api/public/catalog/images/p1")).status).toBe(404)
  })

  test("cada cliente tiene un límite de consultas; la cabecera del túnel solo se cree desde esta PC", async () => {
    await withCatalog()
    for (let i = 0; i < 60; i++) {
      const res = await h.call("/api/public/catalog", {
        ip: "192.168.1.50",
        headers: { "x-forwarded-for": `10.0.0.${i}` },
      })
      expect(res.status).toBe(200)
    }
    const blocked = await h.call("/api/public/catalog", { ip: "192.168.1.50" })
    expect(blocked.status).toBe(429)
    expect(await errorCode(blocked)).toBe("RATE_LIMITED")
    // Otro equipo sigue entrando.
    expect((await h.call("/api/public/catalog", { ip: "192.168.1.51" })).status).toBe(200)
    // Por el túnel (que se conecta desde 127.0.0.1), cuenta cada visitante por su cuenta.
    for (let i = 0; i < 61; i++) {
      const res = await h.call("/api/public/catalog", {
        ip: "127.0.0.1",
        headers: { "cf-connecting-ip": `200.1.1.${i}` },
      })
      expect(res.status).toBe(200)
    }
  })

  test("la página /catalogo lleva el nombre del negocio para la vista previa del enlace", async () => {
    h = harness({ webRoot: webRoot() })
    const s = await withCatalog()
    await h.call("/api/settings/business", {
      method: "PUT",
      cookie: s.owner,
      body: { name: 'Bodega "La <Esquina>"' },
    })
    await h.call("/api/products/p1/image", {
      method: "PUT",
      cookie: s.owner,
      raw: JPEG,
      headers: { "content-type": "image/jpeg" },
    })
    const res = await h.call("/catalogo", { headers: { host: "caja.local:3000" } })
    const html = await res.text()
    expect(html).toContain("<title>Bodega &quot;La &lt;Esquina&gt;&quot; · Catálogo</title>")
    expect(html).toContain(
      'property="og:image" content="http://caja.local:3000/api/public/catalog/images/p1?v=',
    )
    expect(html).not.toContain("<Esquina>")
    // Lo demás sigue siendo la app.
    expect(await (await h.call("/ventas")).text()).toContain("LA-CAJA")
  })
})

describe("el puerto del catálogo", () => {
  test("solo sirve el catálogo: ni la entrada, ni la app, ni la API con sesión", async () => {
    const root = webRoot()
    h = harness({ webRoot: root })
    const s = await withCatalog()
    const app = createStorefrontApp({
      db: h.db,
      auth: null as never,
      now: () => h.clock.now,
      webRoot: root,
    })
    const get = (path: string, init: RequestInit = {}) => app.request(path, init)
    expect((await get("/api/public/catalog")).status).toBe(200)
    const page = await get("/")
    expect(await page.text()).toContain("Bodega La Esquina · Catálogo")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    // Cualquier otra ruta también es la página del catálogo, nunca la caja.
    expect(await (await get("/ventas")).text()).not.toContain("LA-CAJA")
    expect(await (await get("/index.html")).text()).not.toContain("LA-CAJA")
    expect((await get("/assets/catalog-abc.js")).status).toBe(200)
    expect(await (await get("/assets/../index.html")).text()).not.toContain("LA-CAJA")
    expect(await (await get("/assets/%2e%2e/index.html")).text()).not.toContain("LA-CAJA")
    expect((await get("/assets/..%2findex.html")).status).toBe(404)
    for (const path of ["/api/me", "/api/products", "/api/storefront", "/api/setup"]) {
      expect((await get(path, { headers: { cookie: s.owner } })).status).toBe(404)
    }
    const signIn = await get("/api/auth/sign-in/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "duena", password: "clave-segura-1" }),
    })
    expect(signIn.status).toBe(404)
  })
})

/** Un Tailscale de mentira que anota lo que se le pidió. */
function fakeTailscale(serve: unknown = {}, funnelRun?: Awaited<ReturnType<Runner>>) {
  const calls: string[][] = []
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false })
  const run: Runner = async (args) => {
    calls.push(args)
    if (args[0] === "status") {
      return ok(
        JSON.stringify({
          BackendState: "Running",
          Self: {
            HostName: "CAJA-1",
            DNSName: "caja-1.tail1234.ts.net.",
            TailscaleIPs: ["100.1.2.3"],
          },
        }),
      )
    }
    if (args[0] === "serve" && args[1] === "status") return ok(JSON.stringify(serve))
    if (args[0] === "funnel") return funnelRun ?? ok("")
    return { code: 1, stdout: "", stderr: "?", timedOut: false }
  }
  return { run, calls }
}

const network = {
  httpPort: 3000,
  httpsPort: null,
  catalogPort: 3080,
  hosts: ["localhost", "caja-1.local", "127.0.0.1", "192.168.1.10"],
  caCert: null,
  caFingerprint: null,
}

describe("publicar el catálogo en internet", () => {
  test("el estado dice por dónde se abre en la red local y si ya está publicado", async () => {
    const ts = fakeTailscale({
      Web: {
        "caja-1.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
        "caja-1.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3080" } } },
      },
      AllowFunnel: { "caja-1.tail1234.ts.net:8443": true },
    })
    h = harness({ network, remote: { run: ts.run, origins: new Set() } })
    const s = await withCatalog()
    const st = (await (
      await h.call("/api/storefront", { cookie: s.owner })
    ).json()) as StorefrontStatus
    expect(st.port).toBe(3080)
    // La IP primero: el nombre .local no siempre lo resuelve un celular.
    expect(st.urls).toEqual(["http://192.168.1.10:3080", "http://caja-1.local:3080"])
    expect(st.publicUrl).toBe("https://caja-1.tail1234.ts.net:8443")
    expect(st.tailscale).toBe("running")
    expect(st).toMatchObject({ products: 1, withImage: 0 })
  })

  test("la app servida en privado (sin Funnel) no cuenta como publicada", async () => {
    const ts = fakeTailscale({
      Web: {
        "caja-1.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
      },
      AllowFunnel: { "caja-1.tail1234.ts.net:443": true },
    })
    h = harness({ network, remote: { run: ts.run, origins: new Set() } })
    const s = await withCatalog()
    const st = (await (
      await h.call("/api/storefront", { cookie: s.owner })
    ).json()) as StorefrontStatus
    expect(st.publicUrl).toBeNull()
  })

  test("publica solo el puerto del catálogo y deja de publicarlo", async () => {
    const ts = fakeTailscale()
    h = harness({ network, remote: { run: ts.run, origins: new Set() } })
    const s = await setUp(h)
    const off = await h.call("/api/storefront/publish", { method: "POST", cookie: s.owner })
    expect(off.status).toBe(409)
    await h.call("/api/settings/features", {
      method: "PUT",
      cookie: s.owner,
      body: { catalog: true },
    })
    const res = await h.call("/api/storefront/publish", { method: "POST", cookie: s.owner })
    expect(((await res.json()) as ServeResult).ok).toBe(true)
    expect(ts.calls).toContainEqual(["funnel", "--bg", "--https=8443", "3080"])
    expect(ts.calls.some((c) => c[0] === "funnel" && c.includes("3000"))).toBe(false)
    const un = await h.call("/api/storefront/unpublish", { method: "POST", cookie: s.owner })
    expect(((await un.json()) as ServeResult).ok).toBe(true)
    expect(ts.calls).toContainEqual(["funnel", "--https=8443", "off"])
  })

  test("si la cuenta no permite Funnel, da la dirección para habilitarlo", async () => {
    const ts = fakeTailscale(
      {},
      {
        code: 1,
        stdout: "",
        stderr:
          "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/funnel?node=abc\n",
        timedOut: false,
      },
    )
    h = harness({ network, remote: { run: ts.run, origins: new Set() } })
    const s = await withCatalog()
    const res = (await (
      await h.call("/api/storefront/publish", { method: "POST", cookie: s.owner })
    ).json()) as ServeResult
    expect(res).toMatchObject({
      ok: false,
      approveUrl: "https://login.tailscale.com/f/funnel?node=abc",
    })
  })

  test("solo quien maneja los ajustes", async () => {
    h = harness({ network, remote: { run: null, origins: new Set() } })
    const s = await withCatalog()
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/storefront", { cookie: cashier })).status).toBe(403)
    expect((await setStorefront(cashier, { message: "x" })).status).toBe(403)
    expect(
      (await h.call("/api/storefront/publish", { method: "POST", cookie: cashier })).status,
    ).toBe(403)
    const st = (await (
      await h.call("/api/storefront", { cookie: s.owner })
    ).json()) as StorefrontStatus
    expect(st.tailscale).toBe("missing")
  })
})

test("un producto nuevo guarda su descripción y si sale en el catálogo", async () => {
  const s = await setUp(h)
  const res = await h.call("/api/products", {
    cookie: s.owner,
    body: {
      name: "Queso llanero",
      priceMinor: 400,
      priceCurrency: "USD",
      unit: "kg",
      description: "  Duro, de Barinas  ",
      inCatalog: false,
    },
  })
  const item = (await res.json()) as CatalogItem
  const detail = (await (
    await h.call(`/api/products/${item.productId}`, { cookie: s.owner })
  ).json()) as ProductDetail
  expect(detail).toMatchObject({
    description: "Duro, de Barinas",
    inCatalog: false,
    imageVersion: null,
  })
})
