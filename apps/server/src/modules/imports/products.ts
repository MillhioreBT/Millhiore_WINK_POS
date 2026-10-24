import type { ImportBody, ImportResult } from "@millhiore/contracts"
import {
  auditLog,
  business,
  category,
  currency,
  type Db,
  product,
  stockReason,
  tax,
  terminal,
  variant,
} from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { postDocumentIn } from "../../posting/post"
import { postingContext } from "../settings/service"
import { amount, type Cell, key, text } from "./cells"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Row = ImportResult["rows"][number]

/** Lo que se va a hacer con una fila válida. */
interface Plan {
  row: number
  name: string
  /** El producto existente que se actualiza; null = se crea. */
  existing: { productId: string; variantId: string; tracksStock: boolean } | null
  kind: "good" | "service"
  priceMinor: number | undefined
  priceCurrency: string | undefined
  sku: string | null
  barcode: string | null
  categoryKey: string | null
  categoryName: string | null
  taxId: string | null | undefined
  costMinor: number | undefined
  minStockMilli: number | undefined
  stockMilli: number | undefined
}

const qty = new Intl.NumberFormat("es-VE", { maximumFractionDigits: 3 })

const CURRENCY_WORDS: Record<string, string> = {
  $: "USD",
  usd: "USD",
  dolar: "USD",
  dolares: "USD",
  us$: "USD",
  bs: "VES",
  "bs.": "VES",
  ves: "VES",
  bolivar: "VES",
  bolivares: "VES",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  "€": "EUR",
}

/**
 * Importa productos desde las filas de una hoja. Revisa cada fila (precio, moneda, IVA, códigos
 * repetidos…) y, con `apply`, crea o actualiza las válidas en una sola transacción. La existencia
 * se suma con un único ajuste de «Entrada de mercancía», que queda en el kardex y se puede anular.
 */
export function importProducts(
  db: Db,
  body: ImportBody,
  actor: { userId: string; canAdjustStock: boolean; canSeeCost: boolean },
  now: number,
): ImportResult {
  return db.transaction(
    (tx) => {
      const biz = tx.select().from(business).get()
      if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
      const currencies = new Map(
        tx
          .select()
          .from(currency)
          .all()
          .map((c) => [c.code, c]),
      )
      const taxes = tx.select().from(tax).where(eq(tax.active, true)).all()
      const categories = new Map(
        tx
          .select()
          .from(category)
          .all()
          .map((c) => [key(c.name), c]),
      )
      const bySku = new Map<
        string,
        { productId: string; variantId: string; tracksStock: boolean }
      >()
      const byBarcode = new Map<
        string,
        { productId: string; variantId: string; tracksStock: boolean }
      >()
      for (const v of tx
        .select({
          variantId: variant.id,
          productId: variant.productId,
          sku: variant.sku,
          barcode: variant.barcode,
          tracksStock: product.tracksStock,
        })
        .from(variant)
        .innerJoin(product, eq(product.id, variant.productId))
        .all()) {
        const ref = { productId: v.productId, variantId: v.variantId, tracksStock: v.tracksStock }
        bySku.set(v.sku.toLowerCase(), ref)
        if (v.barcode) byBarcode.set(v.barcode, ref)
      }

      const rows: Row[] = []
      const plans: Plan[] = []
      const seenSku = new Map<string, number>()
      const seenBarcode = new Map<string, number>()
      const newCategories = new Map<string, string>()

      for (const { row, values } of body.rows) {
        const v = (k: string): Cell => values[k]
        const messages: string[] = []
        const name = text(v("name"))?.slice(0, 120) ?? null
        const sku = text(v("sku"))
        const barcode = text(v("barcode"))
        const existing =
          (sku ? bySku.get(sku.toLowerCase()) : undefined) ??
          (barcode ? byBarcode.get(barcode) : undefined) ??
          null

        if (!name && !existing) messages.push("Falta el nombre")
        if (sku && sku.length > 40) messages.push("El SKU tiene más de 40 caracteres")
        if (barcode && barcode.length > 40) messages.push("El código de barras es muy largo")
        if (sku) {
          const other = seenSku.get(sku.toLowerCase())
          if (other) messages.push(`El SKU ${sku} se repite (fila ${other})`)
          else seenSku.set(sku.toLowerCase(), row)
        }
        if (barcode) {
          const other = seenBarcode.get(barcode)
          if (other) messages.push(`El código ${barcode} se repite (fila ${other})`)
          else seenBarcode.set(barcode, row)
          const owner = byBarcode.get(barcode)
          if (owner && existing && owner.variantId !== existing.variantId) {
            messages.push(`El código ${barcode} ya es de otro producto`)
          }
        }

        const kindText = key(text(v("kind")) ?? "")
        const kind: "good" | "service" = /^serv/.test(kindText) ? "service" : "good"

        const currencyText = text(v("currency"))
        const priceCurrency = currencyText
          ? (CURRENCY_WORDS[key(currencyText)] ?? currencyText.toUpperCase())
          : undefined
        if (priceCurrency && !currencies.has(priceCurrency)) {
          messages.push(`Moneda desconocida: ${currencyText}`)
        }
        const decimals = currencies.get(priceCurrency ?? biz.referenceCurrency)?.decimals ?? 2
        const priceMinor = amount(v("price"), decimals)
        if (priceMinor === null) messages.push("El precio no es un número válido")
        if (priceMinor === undefined && !existing) messages.push("Falta el precio")

        const costMinor = amount(v("cost"), decimals)
        if (costMinor === null) messages.push("El costo no es un número válido")
        if (costMinor !== undefined && !actor.canSeeCost) {
          messages.push("No tienes permiso para cargar costos")
        }
        const minStockMilli = amount(v("minStock"), 3)
        if (minStockMilli === null) messages.push("La existencia mínima no es un número válido")
        const stockMilli = amount(v("stock"), 3)
        if (stockMilli === null) messages.push("La existencia no es un número válido")
        if (stockMilli && !actor.canAdjustStock) {
          messages.push("No tienes permiso para cargar existencias")
        }
        const tracksStock = existing ? existing.tracksStock : kind === "good"
        if (stockMilli && !tracksStock) messages.push("Un servicio no lleva existencia")

        const taxText = text(v("tax"))
        let taxId: string | null | undefined
        if (taxText) {
          const t = key(taxText)
          const found =
            taxes.find((x) => key(x.code) === t || key(x.name) === t || x.id === taxText) ??
            (/^(exento|e|no)$/.test(t) ? taxes.find((x) => x.kind === "exempt") : undefined) ??
            (/^(si|general|16|16 %|16%)$/.test(t)
              ? taxes.find((x) => x.kind === "taxed" && x.rateBp === 1600)
              : undefined)
          if (found) taxId = found.id
          else messages.push(`IVA desconocido: ${taxText}`)
        }

        const categoryName = text(v("category"))?.slice(0, 60) ?? null
        const categoryKey = categoryName ? key(categoryName) : null

        const label = name ?? sku ?? barcode ?? `Fila ${row}`
        if (messages.length) {
          rows.push({ row, name: label, status: "error", messages })
          continue
        }
        if (existing && !body.updateExisting) {
          rows.push({
            row,
            name: label,
            status: "skip",
            messages: ["Ya existe (mismo SKU o código de barras)"],
          })
          continue
        }
        // Solo las filas válidas crean categorías; la nueva se llama como en la primera fila que la menciona.
        if (
          categoryKey &&
          categoryName &&
          !categories.has(categoryKey) &&
          !newCategories.has(categoryKey)
        ) {
          newCategories.set(categoryKey, categoryName)
        }
        rows.push({
          row,
          name: label,
          status: existing ? "update" : "create",
          messages: stockMilli ? [`Suma ${qty.format(stockMilli / 1000)} a la existencia`] : [],
        })
        plans.push({
          row,
          name: name ?? "",
          existing,
          kind,
          // Los null (inválidos) ya se marcaron como error: aquí solo llegan números o undefined.
          priceMinor: priceMinor ?? undefined,
          priceCurrency,
          sku,
          barcode,
          categoryKey,
          categoryName,
          taxId,
          costMinor: costMinor ?? undefined,
          minStockMilli: minStockMilli ?? undefined,
          stockMilli: stockMilli ?? undefined,
        })
      }

      let stockDocumentNumber: string | null = null
      if (body.apply && plans.length) {
        stockDocumentNumber = apply(tx, plans, newCategories, categories, biz.referenceCurrency, {
          actorId: actor.userId,
          now,
        })
      }
      const count = (s: Row["status"]) => rows.filter((r) => r.status === s).length
      return {
        applied: body.apply && plans.length > 0,
        created: count("create"),
        updated: count("update"),
        skipped: count("skip"),
        errors: count("error"),
        rows,
        newCategories: [...newCategories.values()],
        debts: 0,
        stockDocumentNumber,
      }
    },
    { behavior: body.apply ? "immediate" : "deferred" },
  )
}

function apply(
  tx: Tx,
  plans: Plan[],
  newCategories: Map<string, string>,
  categories: Map<string, { id: string }>,
  referenceCurrency: string,
  ctx: { actorId: string; now: number },
): string | null {
  const { now } = ctx
  let position =
    tx
      .select({ max: sql<number>`coalesce(max(${category.position}), 0)` })
      .from(category)
      .get()?.max ?? 0
  for (const [k, name] of newCategories) {
    const id = uuidv7(now)
    tx.insert(category).values({ id, name, position: ++position }).run()
    categories.set(k, { id })
  }
  let skuCount = tx.all<{ n: number }>(sql`select count(*) as n from variant`)[0]?.n ?? 0
  const nextSku = () => {
    for (;;) {
      const sku = `P${String(++skuCount).padStart(5, "0")}`
      if (!tx.select({ id: variant.id }).from(variant).where(eq(variant.sku, sku)).get()) return sku
    }
  }

  const stockLines: { variantId: string; qtyMilli: number; unitPriceMinor: number }[] = []
  for (const p of plans) {
    const categoryId = p.categoryKey ? (categories.get(p.categoryKey)?.id ?? null) : undefined
    if (p.existing) {
      const productSet = {
        ...(p.name ? { name: p.name } : {}),
        ...(p.taxId !== undefined ? { taxId: p.taxId } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
      }
      const variantSet = {
        ...(p.name ? { name: p.name } : {}),
        ...(p.priceMinor !== undefined ? { priceMinor: p.priceMinor } : {}),
        ...(p.priceCurrency ? { priceCurrency: p.priceCurrency } : {}),
        ...(p.barcode ? { barcode: p.barcode } : {}),
        ...(p.costMinor !== undefined
          ? { costMinor: p.costMinor, costCurrency: p.priceCurrency ?? referenceCurrency }
          : {}),
        ...(p.minStockMilli !== undefined && p.existing.tracksStock
          ? { minStockMilli: p.minStockMilli }
          : {}),
      }
      if (Object.keys(productSet).length) {
        tx.update(product).set(productSet).where(eq(product.id, p.existing.productId)).run()
      }
      if (Object.keys(variantSet).length) {
        tx.update(variant).set(variantSet).where(eq(variant.id, p.existing.variantId)).run()
      }
      if (p.stockMilli) {
        stockLines.push({
          variantId: p.existing.variantId,
          qtyMilli: p.stockMilli,
          unitPriceMinor: 0,
        })
      }
      continue
    }
    const productId = uuidv7(now)
    const variantId = uuidv7(now)
    const priceCurrency = p.priceCurrency ?? referenceCurrency
    tx.insert(product)
      .values({
        id: productId,
        name: p.name,
        kind: p.kind,
        tracksStock: p.kind === "good",
        taxId: p.taxId ?? null,
        categoryId: categoryId ?? null,
        createdAt: now,
      })
      .run()
    tx.insert(variant)
      .values({
        id: variantId,
        productId,
        sku: p.sku ?? nextSku(),
        barcode: p.barcode,
        name: p.name,
        priceMinor: p.priceMinor ?? 0,
        priceCurrency,
        costMinor: p.costMinor ?? null,
        costCurrency: p.costMinor !== undefined ? priceCurrency : null,
        minStockMilli: p.kind === "good" ? (p.minStockMilli ?? null) : null,
        createdAt: now,
      })
      .run()
    if (p.stockMilli) stockLines.push({ variantId, qtyMilli: p.stockMilli, unitPriceMinor: 0 })
  }

  tx.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId: ctx.actorId,
      action: "product.imported",
      entityType: "product",
      entityId: uuidv7(now),
      data: {
        count: plans.length,
        created: plans.filter((p) => !p.existing).length,
        updated: plans.filter((p) => p.existing).length,
        categories: [...newCategories.values()],
      },
    })
    .run()

  if (!stockLines.length) return null
  // La existencia inicial entra como un ajuste («Entrada de mercancía»), que se puede anular.
  const term = tx.select().from(terminal).where(eq(terminal.active, true)).get()
  if (!term) throw new HttpError(409, "NO_TERMINAL", "No hay ninguna caja activa")
  const reason =
    tx.select().from(stockReason).where(eq(stockReason.id, "stk-in-goods")).get()?.active === true
      ? "stk-in-goods"
      : "stk-in-other"
  const biz = tx.select().from(business).get()
  const posted = postDocumentIn(
    tx,
    {
      id: uuidv7(now),
      type: "ADJUSTMENT",
      terminalId: term.id,
      currency: biz?.legalCurrency ?? "VES",
      rate: null,
      lines: stockLines,
      payments: [],
      stockReasonId: reason,
      note: "Existencia inicial importada desde Excel",
    },
    postingContext(tx, now, ctx.actorId),
  )
  return posted.number
}
