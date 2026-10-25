import {
  API_KEY_PERMISSIONS,
  isUuidv7,
  MAX_OPTIONS,
  MAX_VARIANTS,
  POSTABLE_TYPES,
  PRODUCT_UNITS,
  RECURRENCE_FREQUENCIES,
  TAX_KINDS,
  TAXPAYER_TYPES,
} from "@millhiore/domain"
import { z } from "zod"

// Esquemas de la API. Los usan el servidor (validación + OpenAPI) y la web (formularios y cliente).

const safeInt = z.number().int().safe()

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha AAAA-MM-DD")

export const uuidv7Schema = z.string().refine(isUuidv7, "Debe ser un UUIDv7")
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{2,9}$/, "Código de moneda inválido")

export const exchangeRateSchema = z.object({
  base: currencyCodeSchema,
  quote: currencyCodeSchema,
  /** Decimal en texto, hasta 8 cifras: "36.50000000". */
  value: z.string().regex(/^\d{1,12}(\.\d{1,8})?$/, "Tasa inválida"),
})
export type ExchangeRateInput = z.infer<typeof exchangeRateSchema>

/** Una opción o extra elegido, con el nombre y el precio que tenía al venderse. */
export const pickedModifierSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceMinor: safeInt,
  priceCurrency: z.string().nullable(),
})
export type PickedModifier = z.infer<typeof pickedModifierSchema>

export const postLineSchema = z.object({
  variantId: z.string().min(1),
  /** Milésimas de unidad: 1000 = 1. En ajustes lleva signo. */
  qtyMilli: safeInt.refine((n) => n !== 0, "La cantidad no puede ser cero"),
  unitPriceMinor: safeInt.min(0),
  /** Descuento sobre la línea, en la moneda del documento; exige el permiso de dar descuentos. */
  discountMinor: safeInt.min(0).default(0),
  /**
   * Producto con lotes: el lote existente del que sale (ajuste, traslado) o al que entra (ajuste
   * de entrada). Si falta, las salidas se reparten solas (primero el que vence antes).
   */
  lotId: z.string().min(1).optional(),
  /** Producto con lotes: el lote nuevo que entra (compra, ajuste de entrada), con su vencimiento. */
  lot: z
    .object({ code: z.string().trim().max(40).nullish(), expiresOn: dateSchema.nullable() })
    .optional(),
  /**
   * Venta: las opciones y extras elegidos (término, queso extra). Su precio ya va en
   * `unitPriceMinor`; el servidor verifica que sean del producto.
   */
  modifierIds: z.array(z.string().min(1)).max(20).optional(),
  /** Venta: indicaciones para la cocina («sin cebolla»). */
  note: z.string().trim().max(140).nullish(),
})

export const postPaymentSchema = z.object({
  id: uuidv7Schema,
  paymentMethodId: z.string().min(1),
  currency: currencyCodeSchema,
  /** Unidades menores con signo: negativo = vuelto entregado. */
  amountMinor: safeInt.refine((n) => n !== 0, "El monto no puede ser cero"),
  rate: exchangeRateSchema.nullable().default(null),
  reference: z.string().max(100).nullish(),
})

/** Nombre o razón social, cédula o RIF y dirección de quien compra (o vende, en una compra). */
export const customerFiscalSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre o la razón social").max(120),
  taxId: z.string().trim().min(1, "Escribe la cédula o el RIF").max(20),
  address: z.string().trim().max(200).nullish(),
})
export type CustomerFiscal = z.infer<typeof customerFiscalSchema>

export const postDocumentSchema = z.object({
  id: uuidv7Schema,
  type: z.enum(POSTABLE_TYPES),
  terminalId: z.string().min(1),
  currency: currencyCodeSchema,
  rate: exchangeRateSchema.nullable().default(null),
  /** Vacío solo en ingresos y retiros de caja. */
  lines: z.array(postLineSchema).max(500).default([]),
  payments: z.array(postPaymentSchema).max(20).default([]),
  /**
   * Si los precios ya traen el IVA. Si falta: en ventas, la configuración fiscal; en compras, no.
   * El IVA de cada línea lo decide el servidor según el producto, nunca el cliente.
   */
  pricesIncludeTax: z.boolean().optional(),
  /** Cliente (venta) o proveedor (compra). */
  contactId: z.string().min(1).nullish(),
  /**
   * Los datos fiscales del cliente para este documento, escritos en la caja (si faltan, los del
   * contacto). Quedan en el documento tal como se registraron.
   */
  customer: customerFiscalSchema.nullish(),
  /**
   * Venta con factura (no solo nota de venta): exige el nombre y la cédula o el RIF del cliente.
   * La emite el medio autorizado; sus números se anotan después.
   */
  invoice: z.boolean().default(false),
  /**
   * Venta: la propina que deja el cliente, en la moneda del documento. No suma al total ni lleva
   * IVA ni IGTF: los pagos la cubren además de la venta.
   */
  tipMinor: safeInt.min(0).default(0),
  /** Para quién es la propina (un usuario activo); vacío = para todo el equipo. */
  tipUserId: z.string().min(1).nullish(),
  /** Número de la factura del proveedor u otra referencia. */
  externalRef: z.string().trim().max(60).nullish(),
  note: z.string().max(500).nullish(),
  /**
   * Venta a crédito (fiado): lo que el cliente deja a deber, en `creditCurrency`. Los pagos
   * cubren el resto. Exige un cliente y el permiso de fiar.
   */
  creditMinor: safeInt.min(0).default(0),
  /** Moneda de la deuda; si falta, la de referencia del negocio (USD): en bolívares se devalúa. */
  creditCurrency: currencyCodeSchema.optional(),
  /** Compra a deber: hasta cuándo hay para pagar (ms); si falta, los días que da el proveedor. */
  dueAt: safeInt.nullish(),
  /**
   * Ajuste de inventario (`ADJUSTMENT`): por qué cambia la existencia (merma, vencido, conteo…).
   * Si falta, «Otra entrada» u «Otra salida» según el signo de las cantidades.
   */
  stockReasonId: z.string().min(1).nullish(),
  /**
   * Abono (`PAYMENT_IN`): las ventas a crédito del cliente que paga; pago a proveedor
   * (`PAYMENT_OUT`): las compras y gastos a deber que paga. En ambos, cuánto de cada uno.
   */
  allocations: z
    .array(z.object({ saleDocumentId: z.string().min(1), amountMinor: safeInt.min(1) }))
    .max(200)
    .default([]),
  /**
   * Venta: recargos (delivery, servicio…). Uno fijo puede traer su monto en la moneda del
   * documento (si falta, el sugerido); el porcentaje y el IVA los pone el servidor.
   */
  charges: z
    .array(z.object({ chargeId: z.string().min(1), amountMinor: safeInt.min(0).optional() }))
    .max(10)
    .default([]),
  /** Venta que sale de una cotización abierta: queda convertida en la misma operación. */
  quoteId: z.string().min(1).nullish(),
  /** Venta que cobra un pedido del catálogo en línea: queda atendido en la misma operación. */
  webOrderId: z.string().min(1).nullish(),
  /**
   * Compra, ajuste o traslado: la ubicación cuya existencia cambia (en el traslado, el origen). Si
   * falta, la de la caja; las ventas y devoluciones usan siempre la de su caja.
   */
  locationId: z.string().min(1).nullish(),
  /** Traslado (`STOCK_TRANSFER`): adónde llega la mercancía. */
  toLocationId: z.string().min(1).nullish(),
  /**
   * Venta: el código de descuento que se aplicó. Quien no puede dar descuentos a mano solo puede
   * descontar, en total, lo que da el código.
   */
  discountCodeId: z.string().min(1).nullish(),
  /**
   * Venta que cobra (toda o parte de) una cuenta abierta: cuánto de cada producto de la cuenta. Las
   * líneas de la venta deben sumar, por producto, lo mismo; la cuenta se cierra al quedar saldada.
   */
  tab: z
    .object({
      id: z.string().min(1),
      lines: z
        .array(z.object({ lineId: z.string().min(1), qtyMilli: safeInt.min(1) }))
        .min(1)
        .max(500),
    })
    .nullish(),
})
export type PostDocumentBody = z.infer<typeof postDocumentSchema>

/** Los números de la factura emitida por el medio autorizado (máquina fiscal, forma libre…). */
export const recordInvoiceSchema = z.object({
  invoiceNumber: z
    .string()
    .trim()
    .min(1, "Escribe el número de la factura")
    .max(30)
    .transform((s) => s.toUpperCase()),
  controlNumber: z
    .string()
    .trim()
    .min(1, "Escribe el número de control")
    .max(30)
    .transform((s) => s.toUpperCase()),
})
export type RecordInvoiceBody = z.infer<typeof recordInvoiceSchema>

export const voidDocumentSchema = z.object({
  reversalId: uuidv7Schema,
  reason: z.string().max(500).nullish(),
})
export type VoidDocumentBody = z.infer<typeof voidDocumentSchema>

/** Base e IVA de una alícuota, en la moneda del documento y en la legal. */
export const taxGroupSchema = z.object({
  taxId: z.string().nullable(),
  kind: z.enum(TAX_KINDS),
  /** Centésimas de punto porcentual: 1600 = 16 %. */
  rateBp: safeInt,
  baseMinor: safeInt,
  taxMinor: safeInt,
  baseLegalMinor: safeInt,
  taxLegalMinor: safeInt,
})

/** Recargo cobrado (IGTF) y la parte del total sobre la que se calculó. */
export const surchargeGroupSchema = z.object({
  surchargeId: z.string(),
  rateBp: safeInt,
  baseMinor: safeInt,
  amountMinor: safeInt,
  baseLegalMinor: safeInt,
  amountLegalMinor: safeInt,
})

export const postedDocumentSchema = z.object({
  id: z.string(),
  number: z.string(),
  /** Total de la factura (base + IVA), sin recargos. */
  totalMinor: safeInt,
  totalLegalMinor: safeInt,
  /** IGTF y otros recargos: lo cobrado es total + recargos. */
  surchargeMinor: safeInt,
  surchargeLegalMinor: safeInt,
  taxes: z.array(taxGroupSchema),
  surcharges: z.array(surchargeGroupSchema),
  /** Lo que el cliente dejó a deber (venta a crédito); 0 si se pagó todo. */
  creditMinor: safeInt,
  /** Moneda en que se debe; null si no quedó nada a deber. */
  creditCurrency: z.string().nullable(),
  /** Hasta cuándo puede pagar lo fiado; null si no tiene plazo. */
  dueAt: safeInt.nullable(),
  /** true si ya estaba contabilizado y no se escribió nada nuevo. */
  duplicate: z.boolean(),
})
export type PostedDocumentBody = z.infer<typeof postedDocumentSchema>

/** Condición fiscal del negocio y cómo se exhiben sus precios. */
export const fiscalSettingsSchema = z.object({
  /** ordinary: cobra IVA; special: IVA + percibe IGTF; none: no cobra IVA. */
  taxpayer: z.enum(TAXPAYER_TYPES),
  /** Los precios de venta ya incluyen el IVA (precio de vitrina). */
  pricesIncludeTax: z.boolean(),
  /** IVA de los productos sin uno asignado. */
  defaultTaxId: z.string().min(1),
  /**
   * La caja ofrece «Con factura» (pide los datos fiscales del cliente) y Ventas lleva la cuenta de
   * las facturas por anotar. Apagado, todo sale como nota de venta.
   */
  invoices: z.boolean(),
})
export type FiscalSettingsBody = z.infer<typeof fiscalSettingsSchema>

/**
 * Impresora de recibos. `browser`: el diálogo de impresión del navegador (cualquier impresora
 * instalada). Las demás las maneja el servidor con ESC/POS, así que también imprime desde el
 * celular: `network` (impresora con red, puerto 9100), `windows` (impresora USB compartida en
 * Windows, p. ej. \\localhost\POS80) y `device` (Linux: /dev/usb/lp0).
 */
export const printerSettingsSchema = z.object({
  mode: z.enum(["browser", "network", "windows", "device"]),
  host: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]{1,120}$/, "Escribe una IP o nombre de equipo, p. ej. 192.168.0.50")
    .nullable(),
  port: z.number().int().min(1).max(65_535),
  /** Nombre con el que se compartió la impresora en Windows. */
  share: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9 _.-]{1,80}$/, "Solo letras, números, espacios, punto, guion o guion bajo")
    .nullable(),
  device: z
    .string()
    .trim()
    .regex(/^\/dev\/(usb\/lp\d+|lp\d+|tty(USB|ACM|S)\d+)$/, "Un dispositivo como /dev/usb/lp0")
    .nullable(),
  paperWidth: z.union([z.literal(58), z.literal(80)]),
  /** Imprimir el recibo al terminar cada venta, sin preguntar. */
  autoPrint: z.boolean(),
  /** Abrir la gaveta al imprimir el recibo de una venta con efectivo. */
  openDrawer: z.boolean(),
})
export type PrinterSettings = z.infer<typeof printerSettingsSchema>

export const taxSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(TAX_KINDS),
  rateBp: safeInt,
  active: z.boolean(),
})

export const surchargeSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  rateBp: safeInt,
  active: z.boolean(),
})

// Catálogo. Cada producto se vende en una variante o, si tiene tallas y colores, en una por
// combinación; la lista de productos trae una fila por variante.

export const productKindSchema = z.enum(["good", "service"])

/** Por unidad, o por kilo, litro o metro (se vende con decimales y el precio es por kilo…). */
export const productUnitSchema = z.enum(PRODUCT_UNITS)
export type ProductUnit = z.infer<typeof productUnitSchema>

/** Código del producto en la balanza que imprime etiquetas (PLU). */
const pluSchema = safeInt
  .min(1, "El código de la balanza va de 1 a 999999")
  .max(999_999, "El código de la balanza va de 1 a 999999")

/** Cómo se leen las etiquetas que imprime la balanza (EAN-13 de uso interno, 20 a 29). */
export const scaleSettingsSchema = z.object({
  /** Los dos primeros dígitos de sus códigos. */
  prefixes: z
    .array(z.string().regex(/^2\d$/, "Los prefijos van del 20 al 29"))
    .min(1, "Elige al menos un prefijo")
    .max(10),
  /** Dígitos del código del producto (PLU); los que quedan, hasta el de control, son el valor. */
  pluDigits: z.number().int().min(4).max(6),
  /** Lo que trae el código después del PLU: el peso en gramos o el precio en céntimos. */
  value: z.enum(["weight", "price"]),
  /** Moneda del precio que trae la etiqueta, si trae el precio. */
  priceCurrency: currencyCodeSchema,
})
export type ScaleSettings = z.infer<typeof scaleSettingsSchema>

const optionValueSchema = z.string().trim().min(1, "Escribe el valor").max(30)

/** Una característica (Talla) con sus valores en el orden en que se muestran (S, M, L). */
export const productOptionSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre de la característica").max(30),
  values: z.array(optionValueSchema).min(1, "Agrega al menos un valor").max(MAX_VARIANTS),
})
export type ProductOptionInput = z.infer<typeof productOptionSchema>

export const catalogItemSchema = z.object({
  productId: z.string(),
  variantId: z.string(),
  /** El nombre con que se vende: con la talla y el color si los tiene, «Camisa (M, Azul)». */
  name: z.string(),
  /** El nombre del producto, sin la combinación. */
  productName: z.string(),
  /** Los valores de la combinación en el orden de `options`; null si no tiene. */
  optionValues: z.array(z.string()).nullable(),
  /** Las características del producto con sus valores; null si se vende de una sola forma. */
  options: z.array(productOptionSchema).nullable(),
  kind: productKindSchema,
  /** Por unidad o por kilo, litro o metro: el precio es por esa unidad. */
  unit: productUnitSchema,
  sku: z.string(),
  barcode: z.string().nullable(),
  /** Código en la balanza; null si no se pesa en una. */
  plu: safeInt.nullable(),
  priceMinor: safeInt,
  priceCurrency: z.string(),
  /** null = el impuesto por defecto del negocio. */
  taxId: z.string().nullable(),
  tracksStock: z.boolean(),
  /** Se puede vender: el producto y esta variante están activos. */
  active: z.boolean(),
  /** Último costo de compra; null si no hay o si quien consulta no tiene cost.view. */
  costMinor: safeInt.nullable(),
  costCurrency: z.string().nullable(),
  /** Existencia total en milésimas (1000 = 1). */
  stockMilli: safeInt,
  /** Existencia por ubicación (id → milésimas); faltan las ubicaciones donde nunca hubo. */
  stockByLocation: z.record(z.string(), safeInt),
  /** Existencia mínima en milésimas; null = sin aviso de reposición. */
  minStockMilli: safeInt.nullable(),
  /** Categoría del producto; null = sin categoría. */
  categoryId: z.string().nullable(),
  /** Lleva lotes con vencimiento. */
  tracksLots: z.boolean(),
  /** Grupos de opciones y extras que se ofrecen al venderlo, en su orden. */
  modifierGroupIds: z.array(z.string()),
  /** Tiene receta: si no lleva existencia, sus ingredientes se descuentan al venderlo. */
  hasRecipe: z.boolean(),
  /**
   * Producto con lotes: el próximo vencimiento de lo que hay (sin contar lo vencido) y cuánto hay
   * vencido en cada ubicación; null si no lleva lotes.
   */
  expiry: z
    .object({
      nextExpiresOn: dateSchema.nullable(),
      expiredByLocation: z.record(z.string(), safeInt),
    })
    .nullable(),
})
export type CatalogItem = z.infer<typeof catalogItemSchema>

export const listPriceInputSchema = z.object({
  priceListId: z.string().min(1),
  priceMinor: safeInt.min(0, "El precio no puede ser negativo").nullable(),
})

/**
 * Una combinación (M, Azul) con su código y su precio. Con `id` se edita la que ya existe (y
 * conserva su existencia, aunque cambien sus valores); sin él se crea.
 */
export const variantInputSchema = z.object({
  id: z.string().min(1).optional(),
  values: z.array(optionValueSchema).max(MAX_OPTIONS),
  /** Si falta, se genera a partir del SKU del producto. */
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: z.string().trim().min(1).max(40).nullish(),
  priceMinor: safeInt.min(0, "El precio no puede ser negativo"),
  active: z.boolean().default(true),
})
export type VariantInput = z.infer<typeof variantInputSchema>

/** Un ingrediente de la receta: cuánto lleva una unidad (en milésimas) y la merma. */
export const recipeInputSchema = z.object({
  ingredientId: z.string().min(1),
  qtyMilli: safeInt.min(1, "La cantidad debe ser mayor que cero").max(1_000_000_000),
  /** Centésimas de punto: 1000 = 10 % de merma. */
  wasteBp: safeInt.min(0).max(10_000).default(0),
})
export type RecipeInput = z.infer<typeof recipeInputSchema>

export const createProductSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(120),
  kind: productKindSchema.default("good"),
  unit: productUnitSchema.default("unit"),
  /** Si falta, se genera uno. */
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: z.string().trim().min(1).max(40).nullish(),
  /** Código en la balanza (solo sin tallas ni colores). */
  plu: pluSchema.nullish(),
  priceMinor: safeInt.min(0, "El precio no puede ser negativo"),
  priceCurrency: currencyCodeSchema,
  /** null o ausente = el impuesto por defecto. */
  taxId: z.string().min(1).nullish(),
  minStockMilli: safeInt.min(0, "El mínimo no puede ser negativo").nullish(),
  /** null o ausente = sin categoría. */
  categoryId: z.string().min(1).nullish(),
  /** Precio propio en cada lista (en la moneda del precio base); null = el de la lista. */
  listPrices: z.array(listPriceInputSchema).max(50).optional(),
  /** Lleva lotes con vencimiento (solo productos, no servicios). */
  tracksLots: z.boolean().default(false),
  /** Tallas, colores…: se crea una variante por combinación (todas, si no vienen `variants`). */
  options: z.array(productOptionSchema).max(MAX_OPTIONS).optional(),
  /** Las combinaciones con su código y su precio; las que falten no se crean. */
  variants: z.array(variantInputSchema).max(MAX_VARIANTS).optional(),
  /** Grupos de opciones y extras que se ofrecen al venderlo, en su orden. */
  modifierGroupIds: z.array(z.string().min(1)).max(20).optional(),
  /** Receta: los ingredientes (productos con existencia) de una unidad. */
  recipe: z.array(recipeInputSchema).max(50).optional(),
  /** Para el catálogo en línea: de qué es, cuánto trae. */
  description: z.string().trim().max(500).nullish(),
  /** Sale en el catálogo en línea (si su categoría también sale). */
  inCatalog: z.boolean().optional(),
})
export type CreateProductBody = z.infer<typeof createProductSchema>

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  unit: productUnitSchema.optional(),
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: z.string().trim().min(1).max(40).nullish(),
  plu: pluSchema.nullish(),
  priceMinor: safeInt.min(0).optional(),
  priceCurrency: currencyCodeSchema.optional(),
  taxId: z.string().min(1).nullish(),
  minStockMilli: safeInt.min(0, "El mínimo no puede ser negativo").nullish(),
  categoryId: z.string().min(1).nullish(),
  active: z.boolean().optional(),
  /** Las listas que no se mencionan no cambian. */
  listPrices: z.array(listPriceInputSchema).max(50).optional(),
  tracksLots: z.boolean().optional(),
  /**
   * Nuevas características (null = sin tallas ni colores). Con ellas van todas las combinaciones
   * que se siguen vendiendo en `variants`: las que no se mencionan se desactivan.
   */
  options: z.array(productOptionSchema).max(MAX_OPTIONS).nullable().optional(),
  variants: z.array(variantInputSchema).max(MAX_VARIANTS).optional(),
  /** Grupos de opciones y extras (reemplaza los que tenía). */
  modifierGroupIds: z.array(z.string().min(1)).max(20).optional(),
  /** Receta (reemplaza la que tenía; vacía = sin receta). */
  recipe: z.array(recipeInputSchema).max(50).optional(),
  /** Para el catálogo en línea: de qué es, cuánto trae. */
  description: z.string().trim().max(500).nullish(),
  /** Sale en el catálogo en línea (si su categoría también sale). */
  inCatalog: z.boolean().optional(),
})
export type UpdateProductBody = z.infer<typeof updateProductSchema>

/** Un producto con todas sus variantes, también las desactivadas, en el orden de la cuadrícula. */
export const productDetailSchema = z.object({
  productId: z.string(),
  name: z.string(),
  kind: productKindSchema,
  unit: productUnitSchema,
  taxId: z.string().nullable(),
  categoryId: z.string().nullable(),
  tracksStock: z.boolean(),
  tracksLots: z.boolean(),
  active: z.boolean(),
  options: z.array(productOptionSchema).nullable(),
  description: z.string().nullable(),
  inCatalog: z.boolean(),
  /** Versión de la foto (cambia con cada foto nueva); null si no tiene. */
  imageVersion: safeInt.nullable(),
  variants: z.array(catalogItemSchema.extend({ variantActive: z.boolean() })),
  /** Los ingredientes de una unidad, en su orden, con el nombre y el costo de hoy de cada uno. */
  recipe: z.array(
    recipeInputSchema.extend({
      name: z.string(),
      /** null si quien consulta no ve costos o el ingrediente no tiene. */
      costMinor: safeInt.nullable(),
      costCurrency: z.string().nullable(),
    }),
  ),
})
export type ProductDetail = z.infer<typeof productDetailSchema>

// Lo que la caja necesita para arrancar, en una sola llamada.

export const paymentMethodInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Cuenta donde cae el dinero (las de efectivo se cuentan en el arqueo). */
  accountId: z.string(),
  currency: z.string(),
  kind: z.enum(["cash", "bank", "mobile", "wallet"]),
  requiresReference: z.boolean(),
  surcharge: z.object({ id: z.string(), name: z.string(), rateBp: safeInt }).nullable(),
})
export type PaymentMethodInfo = z.infer<typeof paymentMethodInfoSchema>

export const saleChargeInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["percent", "fixed"]),
  /** Porcentual: centésimas de punto sobre el subtotal sin IVA. */
  rateBp: safeInt,
  /** Fijo: monto sugerido en `currency`. */
  amountMinor: safeInt,
  currency: z.string().nullable(),
  /** IVA del recargo; null = no lleva IVA. */
  taxId: z.string().nullable(),
  /** Se agrega solo a cada venta. */
  auto: z.boolean(),
})
export type SaleChargeInfo = z.infer<typeof saleChargeInfoSchema>

export const bootstrapSchema = z.object({
  business: z.object({
    name: z.string(),
    referenceCurrency: z.string(),
    legalCurrency: z.string(),
    timezone: z.string(),
    /** Datos que salen en el encabezado y el pie del recibo. */
    taxId: z.string().nullable(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    receiptFooter: z.string().nullable(),
  }),
  /**
   * Cajas activas donde puede trabajar quien entró (las de sus sucursales): cada equipo elige en
   * cuál trabaja (la primera si no eligió).
   */
  terminals: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      locationId: z.string(),
      branchId: z.string(),
    }),
  ),
  /** Sucursales activas, con lo que sale en el recibo y la lista de precios con que venden. */
  branches: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      address: z.string().nullable(),
      phone: z.string().nullable(),
      priceListId: z.string().nullable(),
    }),
  ),
  /** Cuántos códigos de descuento activos hay (la caja ofrece «Código de descuento» si hay). */
  discountCodes: safeInt,
  /** Ubicaciones activas (tienda, depósito, cocina…), la tienda primero, de todas las sucursales. */
  locations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["store", "warehouse", "kitchen"]),
      branchId: z.string(),
    }),
  ),
  currencies: z.array(
    z.object({ code: z.string(), name: z.string(), symbol: z.string(), decimals: safeInt }),
  ),
  paymentMethods: z.array(paymentMethodInfoSchema),
  taxes: z.array(taxSchema),
  fiscal: fiscalSettingsSchema,
  credit: z.object({ enabled: z.boolean() }),
  /** Funciones que el comercio usa (las apagadas se esconden). */
  features: z.object({
    quotes: z.boolean(),
    priceLists: z.boolean(),
    charges: z.boolean(),
    recurring: z.boolean(),
    payables: z.boolean(),
    locations: z.boolean(),
    lots: z.boolean(),
    variants: z.boolean(),
    tables: z.boolean(),
    modifiers: z.boolean(),
    kitchen: z.boolean(),
    recipes: z.boolean(),
    tips: z.boolean(),
    scale: z.boolean(),
    branches: z.boolean(),
    catalog: z.boolean(),
  }),
  /** Cómo se leen las etiquetas de la balanza; null si la función está apagada. */
  scale: scaleSettingsSchema.nullable(),
  /** Los usuarios activos, para elegir a quién va una propina. */
  staff: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Grupos de opciones y extras activos, con sus opciones activas, en su orden. */
  modifierGroups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      minSelect: safeInt,
      maxSelect: safeInt.nullable(),
      modifiers: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          priceMinor: safeInt,
          priceCurrency: z.string().nullable(),
        }),
      ),
    }),
  ),
  /** Recargos de venta activos (delivery, servicio…), en su orden. */
  charges: z.array(saleChargeInfoSchema),
  /** Listas de precios activas, en su orden, con los precios propios de cada producto. */
  priceLists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      adjustBp: safeInt,
      prices: z.array(
        z.object({ variantId: z.string(), priceMinor: safeInt, priceCurrency: z.string() }),
      ),
    }),
  ),
  security: z.object({ autoLockMinutes: safeInt }),
  printer: printerSettingsSchema.pick({
    mode: true,
    paperWidth: true,
    autoPrint: true,
    openDrawer: true,
  }),
  /**
   * Si esta PC es el servidor de una sucursal: su central (allá se cambian el catálogo, los
   * usuarios y los ajustes del negocio). Null en un servidor solo o en el central.
   */
  central: z.object({ branchName: z.string(), url: z.string() }).nullable(),
})
export type Bootstrap = z.infer<typeof bootstrapSchema>

// Turnos de caja

/** Conteo de una cuenta de efectivo; `denominations`: { "2000": 3 } = 3 billetes de 20,00. */
export const shiftCountSchema = z.object({
  accountId: z.string().min(1),
  countedMinor: safeInt.min(0, "El conteo no puede ser negativo"),
  denominations: z.record(z.string().regex(/^\d+$/), safeInt.min(0)).optional(),
})

export const openShiftSchema = z.object({
  /** UUIDv7 del cliente: reintentar no abre dos turnos. */
  id: uuidv7Schema,
  terminalId: z.string().min(1),
  counts: z.array(shiftCountSchema).max(20),
  note: z.string().max(500).nullish(),
})
export type OpenShiftBody = z.infer<typeof openShiftSchema>

export const closeShiftSchema = z.object({
  counts: z.array(shiftCountSchema).max(20),
  note: z.string().max(500).nullish(),
})
export type CloseShiftBody = z.infer<typeof closeShiftSchema>

export const shiftAccountSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  currency: z.string(),
  openingExpectedMinor: safeInt,
  openingCountedMinor: safeInt,
  closingExpectedMinor: safeInt.nullable(),
  closingCountedMinor: safeInt.nullable(),
  /** Contado − esperado al cerrar (positivo = sobrante). */
  differenceMinor: safeInt.nullable(),
  closingDenominations: z.record(z.string(), safeInt).nullable(),
})

export const shiftSchema = z.object({
  id: z.string(),
  terminalId: z.string(),
  terminalName: z.string(),
  status: z.enum(["open", "closed"]),
  openedAt: safeInt,
  openedBy: z.string().nullable(),
  openingNote: z.string().nullable(),
  closedAt: safeInt.nullable(),
  closedBy: z.string().nullable(),
  closingNote: z.string().nullable(),
  accounts: z.array(shiftAccountSchema),
})
export type Shift = z.infer<typeof shiftSchema>

export const shiftReportSchema = shiftSchema.extend({
  legalCurrency: z.string(),
  sales: z.object({
    count: safeInt,
    voided: safeInt,
    /** Neto de anulaciones, en moneda legal. */
    totalLegalMinor: safeInt,
    taxLegalMinor: safeInt,
    surchargeLegalMinor: safeInt,
    /** Lo que se vendió a crédito en el turno, neto de anulaciones (moneda legal). */
    creditLegalMinor: safeInt,
    /** Descuentos dados en el turno, netos de anulaciones (moneda legal). */
    discountLegalMinor: safeInt,
    /** Lo devuelto por los clientes en el turno, ya restado del total (moneda legal). */
    returnsLegalMinor: safeInt,
  }),
  /** Abonos de clientes recibidos en el turno, netos de anulaciones. */
  collections: z.object({ count: safeInt, totalLegalMinor: safeInt }),
  /** Gastos pagados desde esta caja en el turno, netos de anulaciones (moneda legal). */
  expenses: z.object({ count: safeInt, totalLegalMinor: safeInt }),
  /** Pagos a proveedores hechos en el turno, netos de anulaciones (moneda legal). */
  supplierPayments: z.object({ count: safeInt, totalLegalMinor: safeInt }),
  /** Devoluciones a proveedores del turno (lo reembolsado puede entrar a la gaveta). */
  supplierReturns: z.object({ count: safeInt, totalLegalMinor: safeInt }),
  /**
   * Propinas cobradas en el turno, por quien las recibe (null = el equipo), netas de anulaciones y
   * en moneda legal: el dinero está en las cuentas de cobro y se le entrega a cada quien.
   */
  tips: z.array(
    z.object({ userId: z.string().nullable(), name: z.string(), totalLegalMinor: safeInt }),
  ),
  /** Cobrado por método (vuelto y anulaciones restados), en la moneda de cada método. */
  byMethod: z.array(
    z.object({
      methodId: z.string(),
      methodName: z.string(),
      currency: z.string(),
      amountMinor: safeInt,
      /** Lo que el banco o el punto de venta descuenta por esos cobros (anulaciones restadas). */
      commissionMinor: safeInt,
    }),
  ),
  cashMovements: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      type: z.enum(["CASH_IN", "CASH_OUT"]),
      currency: z.string(),
      totalMinor: safeInt,
      note: z.string().nullable(),
      postedAt: safeInt,
      /** Asiento automático de un sobrante/faltante del arqueo. */
      adjustment: z.boolean(),
    }),
  ),
})
export type ShiftReport = z.infer<typeof shiftReportSchema>

// Respaldos

export const backupSchema = z.object({
  name: z.string(),
  /** daily: diario · shift-close: al cerrar turno · manual · pre-migrate: antes de actualizar ·
   * pre-restore: la base que había antes de restaurar otra. */
  label: z.enum(["daily", "pre-migrate", "shift-close", "manual", "pre-restore"]),
  at: safeInt,
  sizeBytes: safeInt,
})
export type Backup = z.infer<typeof backupSchema>

export const backupListSchema = z.object({
  backups: z.array(backupSchema),
  /** Respaldo que se restaurará al reiniciar el programa, si hay uno anotado. */
  pendingRestore: z.string().nullable(),
  /** Cuántos se conservan de cada tipo. */
  keep: safeInt,
  /** Carpeta del equipo donde están los archivos. */
  dir: z.string(),
})
export type BackupList = z.infer<typeof backupListSchema>

// Informes

export const daySalesSchema = z.object({
  /** Ventas del día sin contar los reversos. */
  count: safeInt,
  /** Anulaciones hechas en el día (de ventas de ese día o anteriores). */
  voided: safeInt,
  /** Neto de anulaciones, en moneda legal. */
  totalLegalMinor: safeInt,
  taxLegalMinor: safeInt,
  surchargeLegalMinor: safeInt,
  /** Lo vendido a crédito en el rango, neto de anulaciones (moneda legal). */
  creditLegalMinor: safeInt,
  /** Descuentos dados en el rango, netos de anulaciones (moneda legal). */
  discountLegalMinor: safeInt,
  /** Lo devuelto por los clientes en el rango, ya restado del total (moneda legal). */
  returnsLegalMinor: safeInt,
  /**
   * El total convertido a la moneda de referencia con la tasa vigente al momento de cada venta;
   * sirve para comparar días sin que la devaluación lo distorsione. null si faltó alguna tasa.
   */
  totalReferenceMinor: safeInt.nullable(),
})

export const daySummarySchema = z.object({
  date: dateSchema,
  /** Rango [from, to) en ms según la zona horaria del negocio. */
  from: safeInt,
  to: safeInt,
  legalCurrency: z.string(),
  referenceCurrency: z.string(),
  sales: daySalesSchema,
  /** Lo mismo para el día anterior, para comparar. */
  previous: daySalesSchema,
  /** Cobrado por método (vuelto y anulaciones restados), en la moneda de cada método. */
  byMethod: z.array(
    z.object({
      methodId: z.string(),
      methodName: z.string(),
      currency: z.string(),
      amountMinor: safeInt,
      /** Lo que el banco o el punto de venta descuenta por esos cobros (anulaciones restadas). */
      commissionMinor: safeInt,
    }),
  ),
  /** Ventas netas por hora local (0–23), solo las horas con movimiento. */
  byHour: z.array(z.object({ hour: safeInt, count: safeInt, totalLegalMinor: safeInt })),
  /** Los más vendidos del día por importe, en moneda legal. */
  topProducts: z.array(
    z.object({
      variantId: z.string(),
      name: z.string(),
      qtyMilli: safeInt,
      totalLegalMinor: safeInt,
    }),
  ),
  purchases: z.object({ count: safeInt, totalLegalMinor: safeInt }),
  /** Gastos pagados en el día, netos de anulaciones (moneda legal). */
  expenses: z.object({ count: safeInt, totalLegalMinor: safeInt }),
  /** Abonos de clientes recibidos en el día, netos de anulaciones (moneda legal). */
  collections: z.object({ count: safeInt, totalLegalMinor: safeInt }),
  /**
   * Lo que costó la mercancía que salió por merma, vencido, uso interno… menos lo que entró por
   * ajustes (moneda legal); null si quien consulta no ve costos.
   */
  inventoryLossLegalMinor: safeInt.nullable(),
  /**
   * Lotes que vencen dentro de los días de aviso y lotes ya vencidos con existencia; null si quien
   * consulta no ve inventario o el comercio no usa lotes.
   */
  expiry: z.object({ alertDays: safeInt, expiringLots: safeInt, expiredLots: safeInt }).nullable(),
  /** Turnos abiertos ahora mismo. */
  openShifts: z.array(
    z.object({
      id: z.string(),
      terminalName: z.string(),
      openedAt: safeInt,
      openedBy: z.string().nullable(),
    }),
  ),
  /** Productos agotados o por debajo del mínimo; null si quien consulta no ve inventario. */
  lowStock: z
    .array(
      z.object({
        productId: z.string(),
        variantId: z.string(),
        name: z.string(),
        stockMilli: safeInt,
        minStockMilli: safeInt.nullable(),
      }),
    )
    .nullable(),
})
export type DaySummary = z.infer<typeof daySummarySchema>

// Consulta de documentos

export const documentSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  number: z.string(),
  postedAt: safeInt,
  currency: z.string(),
  legalCurrency: z.string(),
  totalMinor: safeInt,
  totalLegalMinor: safeInt,
  surchargeMinor: safeInt,
  surchargeLegalMinor: safeInt,
  reversesDocumentId: z.string().nullable(),
  /** Id del reverso si el documento fue anulado. */
  reversedBy: z.string().nullable(),
  createdBy: z.string().nullable(),
  contactId: z.string().nullable(),
  /** Los datos fiscales del cliente tal como quedaron en el documento (o, si es viejo, los de hoy). */
  contactName: z.string().nullable(),
  contactTaxId: z.string().nullable(),
  contactAddress: z.string().nullable(),
  /** Venta con factura; `invoice`, sus números si ya se anotaron. */
  invoiceRequested: z.boolean(),
  invoice: z
    .object({ invoiceNumber: z.string(), controlNumber: z.string(), recordedAt: safeInt })
    .nullable(),
  externalRef: z.string().nullable(),
  note: z.string().nullable(),
  /** Σ descuentos de las líneas, en la moneda del documento (negativo en el reverso). */
  discountMinor: safeInt,
  discountLegalMinor: safeInt,
  /** Devolución: el documento de la venta de la que se devuelve y su número. */
  returnsDocumentId: z.string().nullable(),
  returnsNumber: z.string().nullable(),
  /** Gasto: la categoría en que se gastó. */
  expenseCategoryId: z.string().nullable(),
  expenseCategoryName: z.string().nullable(),
  /** Ajuste de inventario: el motivo. */
  stockReasonId: z.string().nullable(),
  stockReasonName: z.string().nullable(),
  /** Venta: la propina (aparte del total; negativa en el reverso) y para quién es (null = el equipo). */
  tipMinor: safeInt,
  tipLegalMinor: safeInt,
  tipUserId: z.string().nullable(),
  tipUserName: z.string().nullable(),
  /** Venta a crédito: lo que quedó a deber (negativo en el reverso). */
  creditMinor: safeInt,
  /** Moneda en que se debe lo fiado; null si no hay crédito. */
  creditCurrency: z.string().nullable(),
  /** Plazo para pagar lo fiado; null si no tiene. */
  dueAt: safeInt.nullable(),
  /** Caja en que se registró. */
  terminalName: z.string(),
  /** Ubicación cuya existencia movió (en un traslado, el origen). */
  locationId: z.string(),
  locationName: z.string(),
  /** Traslado: adónde llegó la mercancía. */
  toLocationId: z.string().nullable(),
  toLocationName: z.string().nullable(),
  /** Venta con código de descuento: el código. */
  discountCode: z.string().nullable(),
  /**
   * Sucursal de la ubicación (con las sucursales activadas; si no, null), con lo que sale en el
   * recibo: su dirección y su teléfono, si los tiene.
   */
  branch: z
    .object({
      id: z.string(),
      name: z.string(),
      address: z.string().nullable(),
      phone: z.string().nullable(),
    })
    .nullable(),
})
export type DocumentSummary = z.infer<typeof documentSummarySchema>

export const documentChargeSchema = z.object({
  chargeId: z.string(),
  name: z.string(),
  kind: z.enum(["percent", "fixed"]),
  rateBp: safeInt,
  /** Porcentual: el subtotal sin IVA sobre el que se calculó. */
  baseMinor: safeInt,
  amountMinor: safeInt,
  amountLegalMinor: safeInt,
  taxId: z.string().nullable(),
  taxRateBp: safeInt,
})

export const documentDetailSchema = documentSummarySchema.extend({
  rate: exchangeRateSchema.nullable(),
  pricesIncludeTax: z.boolean(),
  lines: z.array(
    z.object({
      lineNo: safeInt,
      variantId: z.string(),
      name: z.string(),
      /** Por unidad o por kilo, litro o metro (el de hoy del producto). */
      unit: productUnitSchema,
      qtyMilli: safeInt,
      unitPriceMinor: safeInt,
      /** Descuento de la línea, ya restado de `lineTotalMinor`. */
      discountMinor: safeInt,
      lineTotalMinor: safeInt,
      taxId: z.string().nullable(),
      taxRateBp: safeInt,
      /** Opciones y extras elegidos (ya incluidos en el precio). */
      modifiers: z.array(pickedModifierSchema),
      /** Indicaciones para la cocina. */
      note: z.string().nullable(),
      /** Lotes que movió la línea (cantidades sin signo); vacío si el producto no lleva lotes. */
      lots: z.array(
        z.object({
          lotId: z.string(),
          code: z.string().nullable(),
          expiresOn: dateSchema.nullable(),
          qtyMilli: safeInt,
        }),
      ),
      /**
       * Lo que se gastó de cada ingrediente (la receta de un plato vendido o de una producción),
       * sin signo.
       */
      ingredients: z.array(
        z.object({ variantId: z.string(), name: z.string(), qtyMilli: safeInt }),
      ),
    }),
  ),
  payments: z.array(
    z.object({
      id: z.string(),
      paymentMethodId: z.string(),
      methodName: z.string(),
      currency: z.string(),
      amountMinor: safeInt,
      reference: z.string().nullable(),
      surchargeId: z.string().nullable(),
    }),
  ),
  taxes: z.array(taxGroupSchema),
  surcharges: z.array(surchargeGroupSchema),
  /** Venta: recargos (delivery, servicio…), ya sumados al total. */
  charges: z.array(documentChargeSchema),
  /** Abono (`PAYMENT_IN`): las ventas a crédito que paga y cuánto de cada una. */
  allocations: z.array(
    z.object({ saleDocumentId: z.string(), saleNumber: z.string(), amountMinor: safeInt }),
  ),
})
export type DocumentDetail = z.infer<typeof documentDetailSchema>

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>

// Asistente inicial

const usernameSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9._]+$/, "Solo minúsculas, números, punto y guion bajo")

export const passwordSchema = z
  .string()
  .min(8, "Debe tener al menos 8 caracteres")
  .max(128, "Debe tener como máximo 128 caracteres")

export const setupSchema = z.object({
  business: z.object({
    name: z.string().trim().min(1).max(120),
    /** RIF del negocio; se puede cargar luego en Ajustes. */
    taxId: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[VEJGPC]-?\d{5,9}(-?\d)?$/, "RIF inválido (p. ej. J-12345678-9)")
      .nullish(),
  }),
  owner: z.object({
    name: z.string().trim().min(1).max(120),
    username: usernameSchema,
    password: passwordSchema,
  }),
  referenceCurrency: currencyCodeSchema.default("USD"),
  legalCurrency: currencyCodeSchema.default("VES"),
  timezone: z.string().min(1).default("America/Caracas"),
  locationName: z.string().trim().min(1).max(80).default("Tienda"),
  terminalCode: z
    .string()
    .regex(/^[A-Z0-9]{1,6}$/, "Hasta 6 letras mayúsculas o números")
    .default("C1"),
  /** Tasa inicial referencia → legal (p. ej. "36.5"); si falta, se carga luego. */
  initialRate: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,8})?$/)
    .nullish(),
  /**
   * Condición ante el SENIAT. Un sujeto pasivo especial cobra además el IGTF (3 %) en los
   * métodos de cobro en divisas.
   */
  taxpayer: z.enum(TAXPAYER_TYPES).default("ordinary"),
  /** Los precios de venta ya incluyen el IVA (precio de vitrina). */
  pricesIncludeTax: z.boolean().default(true),
})
export type SetupBody = z.infer<typeof setupSchema>

export const setupStatusSchema = z.object({ configured: z.boolean() })

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  username: usernameSchema,
  password: passwordSchema,
  roleId: z.string().min(1),
  /** Sucursales donde trabaja; vacío o null, en todas. */
  branchIds: z.array(z.string().min(1)).nullish(),
})
export type CreateUserBody = z.infer<typeof createUserSchema>

export const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1) })

export const meSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  roleId: z.string().nullable(),
  permissions: z.array(z.string()),
  /** Entró con una contraseña temporal: debe elegir la suya antes de seguir. */
  mustChangePassword: z.boolean(),
  /** Tiene un PIN de caja: puede bloquear la pantalla y desbloquearla con él. */
  hasPin: z.boolean(),
  /** Sucursales donde trabaja; null, en todas (o las sucursales están apagadas). */
  branchIds: z.array(z.string()).nullable(),
})
export type Me = z.infer<typeof meSchema>

export const userRowSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  roleId: z.string().nullable(),
  active: z.boolean(),
  mustChangePassword: z.boolean(),
  /** Sucursales donde trabaja; null, en todas. */
  branchIds: z.array(z.string()).nullable(),
})
export type UserRow = z.infer<typeof userRowSchema>

/** Cada quien cambia la suya: con la actual, para que una sesión abierta ajena no baste. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Escribe tu contraseña actual"),
  newPassword: passwordSchema,
  /** Cerrar la sesión en los demás equipos (celulares, otras PC). */
  signOutOthers: z.boolean().default(true),
})
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>

/** El dueño restablece la de otro con una temporal; esa persona elige la suya al entrar. */
export const resetPasswordSchema = z.object({ temporaryPassword: passwordSchema })

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roleId: z.string().min(1).optional(),
  active: z.boolean().optional(),
  /** Sucursales donde trabaja; null o vacío, en todas. */
  branchIds: z.array(z.string().min(1)).nullable().optional(),
})
export type UpdateUserBody = z.infer<typeof updateUserSchema>

// Contactos: clientes y proveedores

export const contactKindSchema = z.enum(["customer", "supplier", "both"])

/** Cédula o RIF: V-12345678, E-…, J-12345678-9, G-…, P-… (se normaliza a mayúsculas). */
export const taxIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[VEJGPC]-?\d{5,9}(-?\d)?$/, "Cédula o RIF inválido (p. ej. V-12345678 o J-12345678-9)")

/** Datos del negocio que se pueden editar desde Ajustes; salen en recibos y reportes. */
export const businessProfileSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre del negocio").max(120),
  /** RIF del negocio (J-12345678-9). */
  taxId: taxIdSchema.nullable(),
  address: z.string().trim().max(200).nullable(),
  phone: z.string().trim().max(40).nullable(),
  /** Mensaje al pie del recibo; null = el de siempre («¡Gracias por su compra!»). */
  receiptFooter: z.string().trim().max(200).nullable(),
})
export type BusinessProfile = z.infer<typeof businessProfileSchema>

export const contactSchema = z.object({
  id: z.string(),
  kind: contactKindSchema,
  name: z.string(),
  taxId: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  /** Días que se le dan para pagar lo fiado; 0 = sin plazo. */
  creditDays: safeInt,
  /** Tope de lo que puede deber, en la moneda de referencia; null = sin tope. */
  creditLimitMinor: safeInt.nullable(),
  /** Lista de precios con que compra; null = los precios base. */
  priceListId: z.string().nullable(),
  active: z.boolean(),
  createdAt: safeInt,
})
export type Contact = z.infer<typeof contactSchema>

export const createContactSchema = z.object({
  kind: contactKindSchema.default("customer"),
  name: z.string().trim().min(1, "Escribe el nombre").max(120),
  taxId: taxIdSchema.nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.email("Correo inválido").nullish(),
  address: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(500).nullish(),
  creditDays: safeInt.min(0).max(365).optional(),
  creditLimitMinor: safeInt.min(0).nullish(),
  priceListId: z.string().min(1).nullish(),
})
export type CreateContactBody = z.infer<typeof createContactSchema>

export const updateContactSchema = createContactSchema
  .partial()
  .extend({ active: z.boolean().optional() })
export type UpdateContactBody = z.infer<typeof updateContactSchema>

// Fiado: lo que los clientes deben y sus abonos

export const creditSettingsSchema = z.object({
  /** Permitir vender a crédito (fiado) a clientes registrados. */
  enabled: z.boolean(),
})
export type CreditSettings = z.infer<typeof creditSettingsSchema>

/** Una venta a crédito con saldo pendiente. */
export const openSaleSchema = z.object({
  id: z.string(),
  number: z.string(),
  postedAt: safeInt,
  /** Hasta cuándo puede pagar; null si el cliente no tiene plazo. */
  dueAt: safeInt.nullable(),
  currency: z.string(),
  creditMinor: safeInt,
  paidMinor: safeInt,
  outstandingMinor: safeInt,
  /** Pasó la fecha límite y sigue debiendo. */
  overdue: z.boolean(),
  /** Una venta fiada o una deuda anotada a mano (un saldo anterior, un préstamo). */
  kind: z.enum(["SALE", "DEBT_IN"]),
  /** Qué es: «Venta», o lo que se anotó en la deuda. */
  label: z.string(),
})
export type OpenSale = z.infer<typeof openSaleSchema>

/** Lo que se debe repartido por cuánto lleva vencido (en una sola moneda). */
export const agingSchema = z.object({
  current: safeInt,
  d1_30: safeInt,
  d31_60: safeInt,
  d61_90: safeInt,
  d90plus: safeInt,
})
export type Aging = z.infer<typeof agingSchema>

export const receivableCustomerSchema = z.object({
  contactId: z.string(),
  name: z.string(),
  taxId: z.string().nullable(),
  phone: z.string().nullable(),
  /** Lo que debe en esta moneda (un cliente puede deber en más de una). */
  currency: z.string(),
  outstandingMinor: safeInt,
  overdueMinor: safeInt,
  openCount: safeInt,
  oldestPostedAt: safeInt,
  /** La fecha límite más cercana entre sus ventas pendientes. */
  nextDueAt: safeInt.nullable(),
  aging: agingSchema,
})

export const receivablesSchema = z.object({
  /** Quienes deben algo, los que más deben primero dentro de cada moneda. */
  customers: z.array(receivableCustomerSchema),
  totals: z.array(
    z.object({
      currency: z.string(),
      outstandingMinor: safeInt,
      overdueMinor: safeInt,
      customers: safeInt,
      aging: agingSchema,
    }),
  ),
})
export type Receivables = z.infer<typeof receivablesSchema>

// Cuentas por pagar: lo que el negocio le debe a sus proveedores

/** Una compra o un gasto a deber con saldo pendiente. */
export const openPayableSchema = openSaleSchema.extend({
  kind: z.enum(["PURCHASE", "EXPENSE", "DEBT_OUT"]),
  /** Qué es: la descripción del gasto o de la deuda, o «Compra». */
  label: z.string(),
  /** Número de la factura del proveedor, si se anotó. */
  externalRef: z.string().nullable(),
})
export type OpenPayable = z.infer<typeof openPayableSchema>

export const payableSupplierSchema = z.object({
  contactId: z.string(),
  name: z.string(),
  taxId: z.string().nullable(),
  phone: z.string().nullable(),
  /** Lo que se le debe en esta moneda (a un proveedor se le puede deber en más de una). */
  currency: z.string(),
  outstandingMinor: safeInt,
  overdueMinor: safeInt,
  openCount: safeInt,
  oldestPostedAt: safeInt,
  nextDueAt: safeInt.nullable(),
  aging: agingSchema,
  /** Lo que se le debe, factura por factura, las más antiguas primero. */
  open: z.array(openPayableSchema),
})

export const payablesSchema = z.object({
  /** A quién se le debe, a los que más se les debe primero dentro de cada moneda. */
  suppliers: z.array(payableSupplierSchema),
  totals: z.array(
    z.object({
      currency: z.string(),
      outstandingMinor: safeInt,
      overdueMinor: safeInt,
      suppliers: safeInt,
      aging: agingSchema,
    }),
  ),
})
export type Payables = z.infer<typeof payablesSchema>

/** Estado de cuenta de un cliente: lo que debe, venta por venta, y su historial. */
export const statementSchema = z.object({
  contact: contactSchema,
  referenceCurrency: z.string(),
  /** Todo lo que debe llevado a la moneda de referencia, para compararlo con su límite. */
  owedReferenceMinor: safeInt,
  balances: z.array(
    z.object({ currency: z.string(), outstandingMinor: safeInt, overdueMinor: safeInt }),
  ),
  open: z.array(openSaleSchema),
  movements: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      type: z.enum(["SALE", "PAYMENT_IN", "DEBT_IN"]),
      postedAt: safeInt,
      currency: z.string(),
      /** Lo fiado (venta o deuda) o lo abonado (abono), en la moneda en que se debe. */
      amountMinor: safeInt,
      /** Fue anulado: ya no cuenta. */
      voided: z.boolean(),
    }),
  ),
})
export type Statement = z.infer<typeof statementSchema>

// Categorías de productos

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  position: safeInt,
  active: z.boolean(),
  /** Productos activos que tiene. */
  productCount: safeInt,
})
export type Category = z.infer<typeof categorySchema>

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(60),
})
export type CreateCategoryBody = z.infer<typeof createCategorySchema>

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(60).optional(),
  position: safeInt.min(0).max(10_000).optional(),
  active: z.boolean().optional(),
})
export type UpdateCategoryBody = z.infer<typeof updateCategorySchema>

// PIN de caja y bloqueo de pantalla

/** Pone, cambia o quita (pin = null) el PIN propio; pide la contraseña para que una sesión ajena no baste. */
export const setPinSchema = z.object({
  currentPassword: z.string().min(1, "Escribe tu contraseña"),
  pin: z.string().max(12).nullable(),
})
export type SetPinBody = z.infer<typeof setPinSchema>

export const verifyPinSchema = z.object({ pin: z.string().min(1).max(12) })

export const securitySettingsSchema = z.object({
  /** Minutos sin usar la caja para bloquear la pantalla de quien tiene PIN; 0 = nunca. */
  autoLockMinutes: safeInt.min(0).max(240),
})
export type SecuritySettings = z.infer<typeof securitySettingsSchema>

// Devoluciones parciales

/** Qué se puede devolver de una venta y con qué precio, descuento e IVA se vendió cada línea. */
export const returnableSchema = z.object({
  /** Una venta (la devuelve el cliente) o una compra (se le devuelve al proveedor). */
  kind: z.enum(["SALE", "PURCHASE"]),
  documentId: z.string(),
  number: z.string(),
  currency: z.string(),
  pricesIncludeTax: z.boolean(),
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  lines: z.array(
    z.object({
      lineNo: safeInt,
      variantId: z.string(),
      name: z.string(),
      /** Lo vendido, el precio y el descuento de la línea. */
      qtyMilli: safeInt,
      unitPriceMinor: safeInt,
      discountMinor: safeInt,
      taxId: z.string().nullable(),
      taxKind: z.enum(TAX_KINDS).nullable(),
      taxRateBp: safeInt,
      /** Lo ya devuelto (y su descuento) y lo que todavía se puede devolver. */
      returnedMilli: safeInt,
      returnedDiscountMinor: safeInt,
      remainingMilli: safeInt,
    }),
  ),
  /** Lo que el cliente todavía debe de esta venta (si se vendió a crédito). */
  debt: z.object({ currency: z.string(), outstandingMinor: safeInt }).nullable(),
})
export type Returnable = z.infer<typeof returnableSchema>

export const returnBodySchema = z.object({
  /** UUIDv7 del cliente: reintentar no devuelve dos veces. */
  id: uuidv7Schema,
  terminalId: z.string().min(1),
  /** Tasa vigente (para el total en moneda legal si la venta fue en divisas). */
  rate: exchangeRateSchema.nullable().default(null),
  /** Qué líneas de la venta (por su número) y cuánto de cada una. */
  lines: z
    .array(z.object({ lineNo: safeInt.min(1), qtyMilli: safeInt.min(1) }))
    .min(1, "Elige qué se devuelve")
    .max(500),
  /** Cómo se le devuelve el dinero (montos positivos: lo que sale de la caja o cuenta). */
  payments: z.array(postPaymentSchema).max(20).default([]),
  /** Lo que se descuenta de la deuda de la venta, en la moneda de la deuda, en vez de reembolsarlo. */
  creditAppliedMinor: safeInt.min(0).default(0),
  note: z.string().max(500).nullish(),
})
export type ReturnBody = z.infer<typeof returnBodySchema>

export const auditEntrySchema = z.object({
  id: z.string(),
  at: safeInt,
  /** Qué pasó, en clave (`user.pin.set`, `document.voided`…); la interfaz la traduce. */
  action: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  data: z.unknown(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>

export const sessionRowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  createdAt: safeInt,
  lastSeenAt: safeInt,
  expiresAt: safeInt,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** La sesión desde la que se hace esta petición. */
  current: z.boolean(),
})
export type SessionRow = z.infer<typeof sessionRowSchema>

// Gastos

export const expenseCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  position: safeInt,
  active: z.boolean(),
  /** Gastos vigentes (sin contar los anulados) que tiene. */
  expenseCount: safeInt,
})
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>

export const createExpenseCategorySchema = createCategorySchema
export const updateExpenseCategorySchema = updateCategorySchema

export const expenseBodySchema = z.object({
  /** UUIDv7 del cliente: reintentar no registra dos veces el mismo gasto. */
  id: uuidv7Schema,
  terminalId: z.string().min(1),
  /** Moneda del gasto; los pagos pueden ir en otra con su tasa. */
  currency: currencyCodeSchema,
  /** Tasa vigente (para el total en moneda legal si el gasto no es en bolívares). */
  rate: exchangeRateSchema.nullable().default(null),
  /** Lo que costó, en unidades menores de `currency`. */
  amountMinor: safeInt.min(1, "Escribe el monto"),
  categoryId: z.string().min(1, "Elige la categoría"),
  /** A quién se le pagó (un proveedor), si está registrado. */
  contactId: z.string().min(1).nullish(),
  /** Número de la factura o del recibo. */
  externalRef: z.string().trim().max(60).nullish(),
  /** En qué se gastó, con las palabras de quien lo registra. */
  note: z.string().trim().max(500).nullish(),
  /** Con qué se pagó (montos positivos: lo que sale de cada cuenta). Vacío si todo queda a deber. */
  payments: z.array(postPaymentSchema).max(20).default([]),
  /**
   * Lo que queda a deber, en la moneda del gasto: se le debe al proveedor hasta que se pague.
   * Exige el proveedor; los pagos cubren el resto.
   */
  creditMinor: safeInt.min(0).default(0),
  /** Hasta cuándo hay para pagar lo que queda a deber (ms); si falta, los días que da el proveedor. */
  dueAt: safeInt.nullish(),
  /** Si el gasto viene de uno recurrente, cuál: al registrarlo se pasa al siguiente vencimiento. */
  recurringId: z.string().min(1).nullish(),
})
export type ExpenseBody = z.infer<typeof expenseBodySchema>

// Deudas anotadas a mano

/**
 * Una deuda sin una venta, compra o gasto detrás: lo que un cliente ya debía antes de usar el
 * sistema, lo que se le debe a un proveedor, o un préstamo. Se cobra o se paga como cualquier otra.
 */
export const debtBodySchema = z.object({
  /** UUIDv7 del cliente: reintentar no anota dos veces la misma deuda. */
  id: uuidv7Schema,
  /** `DEBT_IN`: lo que un cliente le debe al negocio; `DEBT_OUT`: lo que el negocio le debe a un proveedor. */
  type: z.enum(["DEBT_IN", "DEBT_OUT"]),
  terminalId: z.string().min(1),
  contactId: z.string().min(1, "Elige a quién"),
  /** Moneda en que se debe: así se cobra o se paga después. */
  currency: currencyCodeSchema,
  /** Tasa vigente (para el monto en moneda legal si la deuda no es en bolívares). */
  rate: exchangeRateSchema.nullable().default(null),
  amountMinor: safeInt.min(1, "Escribe el monto"),
  /** Qué es: «Saldo anterior», «Préstamo»… */
  note: z.string().trim().max(500).nullish(),
  /** Número de la factura o del pagaré, si lo hay. */
  externalRef: z.string().trim().max(60).nullish(),
  /** Hasta cuándo hay para pagar (ms); si falta, los días que tiene el contacto. */
  dueAt: safeInt.nullish(),
  /**
   * Si fue un préstamo: de qué cuenta salió el dinero (a un cliente) o a cuál entró (de un
   * proveedor), montos positivos que suman la deuda. Vacío si es un saldo de antes.
   */
  payments: z.array(postPaymentSchema).max(20).default([]),
})
export type DebtBody = z.infer<typeof debtBodySchema>

// Gastos recurrentes

export const recurrenceFrequencySchema = z.enum(RECURRENCE_FREQUENCIES)

export const recurringExpenseSchema = z.object({
  id: z.string(),
  note: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  contactId: z.string().nullable(),
  /** El proveedor completo, para precargar el gasto al registrarlo. */
  contact: contactSchema.nullable(),
  currency: z.string(),
  amountMinor: safeInt,
  frequency: recurrenceFrequencySchema,
  /** Próximo vencimiento ("AAAA-MM-DD", fecha del negocio). */
  nextDueDay: dateSchema,
  /** Genera solo el gasto a deber al vencer (exige proveedor). */
  auto: z.boolean(),
  active: z.boolean(),
  /** Ya venció (o vence hoy): hay que registrarlo, o el sistema lo hará si es automático. */
  due: z.boolean(),
  /** Por qué no se pudo generar la última vez; null si todo bien. */
  lastError: z.string().nullable(),
})
export type RecurringExpense = z.infer<typeof recurringExpenseSchema>

export const createRecurringExpenseSchema = z.object({
  note: z.string().trim().min(1, "Cuéntanos en qué se gasta").max(500),
  categoryId: z.string().min(1, "Elige la categoría"),
  contactId: z.string().min(1).nullish(),
  currency: currencyCodeSchema,
  amountMinor: safeInt.min(1, "Escribe el monto"),
  frequency: recurrenceFrequencySchema,
  /** Cuándo vence la primera vez ("AAAA-MM-DD"). */
  firstDueDay: dateSchema,
  auto: z.boolean().default(false),
})
export type CreateRecurringExpenseBody = z.infer<typeof createRecurringExpenseSchema>

export const updateRecurringExpenseSchema = z.object({
  note: z.string().trim().min(1, "Cuéntanos en qué se gasta").max(500).optional(),
  categoryId: z.string().min(1).optional(),
  contactId: z.string().min(1).nullable().optional(),
  currency: currencyCodeSchema.optional(),
  amountMinor: safeInt.min(1).optional(),
  frequency: recurrenceFrequencySchema.optional(),
  /** Mover el próximo vencimiento; el día del mes de la fecha pasa a ser el de las siguientes. */
  nextDueDay: dateSchema.optional(),
  auto: z.boolean().optional(),
  active: z.boolean().optional(),
})
export type UpdateRecurringExpenseBody = z.infer<typeof updateRecurringExpenseSchema>

export const expensesSchema = z.object({
  legalCurrency: z.string(),
  /** Los gastos del período, los más recientes primero (con sus anulaciones). */
  rows: z.array(documentSummarySchema),
  /** Total del período en moneda legal, neto de anulaciones. */
  totalLegalMinor: safeInt,
  /** Cuánto se gastó en cada categoría (neto de anulaciones). */
  byCategory: z.array(
    z.object({
      categoryId: z.string().nullable(),
      name: z.string(),
      count: safeInt,
      totalLegalMinor: safeInt,
    }),
  ),
})
export type Expenses = z.infer<typeof expensesSchema>

// Cuentas y transferencias

export const accountKindSchema = z.enum(["cash", "bank", "mobile", "wallet"])

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: accountKindSchema,
  currency: z.string(),
  active: z.boolean(),
  /** Lo que hay ahora en la cuenta, en su moneda (en el efectivo, lo que debería haber en la gaveta). */
  balanceMinor: safeInt,
  /** Con qué métodos de pago entra o sale dinero de esta cuenta. */
  methods: z.array(z.string()),
})
export type Account = z.infer<typeof accountSchema>

const exposureFiguresSchema = z.object({
  /** Lo que hay, en moneda legal. */
  balanceMinor: safeInt,
  /** Lo que valía en moneda de referencia cuando entró (promedio móvil a la tasa de cada día). */
  basisMinor: safeInt,
  /** Lo que vale hoy en moneda de referencia, a la tasa vigente. */
  valueMinor: safeInt,
  /** valueMinor − basisMinor: negativo si los bolívares se devaluaron mientras estaban guardados. */
  differenceMinor: safeInt,
})

/**
 * Exposición cambiaria de las cuentas en moneda legal. Informativa: no cambia ningún saldo. Sin
 * tasa vigente no hay con qué compararlas (`rate: null` y ninguna cuenta).
 */
export const exchangeExposureSchema = z.object({
  referenceCurrency: z.string(),
  legalCurrency: z.string(),
  rate: z.object({ value: z.string(), effectiveAt: safeInt }).nullable(),
  /** Solo las cuentas en moneda legal con saldo. */
  accounts: z.array(
    exposureFiguresSchema.extend({
      accountId: z.string(),
      name: z.string(),
      kind: accountKindSchema,
      active: z.boolean(),
    }),
  ),
  totals: exposureFiguresSchema,
})
export type ExchangeExposure = z.infer<typeof exchangeExposureSchema>

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(60),
  /** El efectivo se cuenta en el arqueo de cada turno: sus cuentas vienen del asistente. */
  kind: z.enum(["bank", "mobile", "wallet"]),
  currency: currencyCodeSchema,
})
export type CreateAccountBody = z.infer<typeof createAccountSchema>

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(60).optional(),
  active: z.boolean().optional(),
})
export type UpdateAccountBody = z.infer<typeof updateAccountSchema>

export const transferBodySchema = z.object({
  /** UUIDv7 del cliente: reintentar no transfiere dos veces. */
  id: uuidv7Schema,
  terminalId: z.string().min(1),
  fromAccountId: z.string().min(1, "Elige la cuenta de origen"),
  toAccountId: z.string().min(1, "Elige la cuenta de destino"),
  /** Lo que sale, en la moneda de la cuenta de origen. */
  fromAmountMinor: safeInt.min(1, "Escribe el monto"),
  /** Lo que entra, en la moneda de la cuenta de destino (igual al enviado si es la misma moneda). */
  toAmountMinor: safeInt.min(1, "Escribe cuánto recibe"),
  /** Tasa vigente (para el total en moneda legal si el origen no está en bolívares). */
  rate: exchangeRateSchema.nullable().default(null),
  /** Número de la operación bancaria, si la hay. */
  reference: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(500).nullish(),
})
export type TransferBody = z.infer<typeof transferBodySchema>

export const transferRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  postedAt: safeInt,
  fromAccountName: z.string(),
  fromCurrency: z.string(),
  fromAmountMinor: safeInt,
  toAccountName: z.string(),
  toCurrency: z.string(),
  toAmountMinor: safeInt,
  reference: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  /** Id del reverso si se anuló. */
  reversedBy: z.string().nullable(),
  /** Es la anulación de otra transferencia. */
  reversesDocumentId: z.string().nullable(),
})
export type TransferRow = z.infer<typeof transferRowSchema>

// Métodos de pago (con qué se cobra y se paga) y su comisión.

export const paymentMethodRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  currency: z.string(),
  kind: accountKindSchema,
  requiresReference: z.boolean(),
  /** IGTF u otro recargo que lleva este método, por su nombre; null si no lleva. */
  surchargeName: z.string().nullable(),
  /** Comisión que descuenta el banco o el punto de venta, en puntos básicos (250 = 2,5 %). */
  commissionBp: safeInt,
  active: z.boolean(),
})
export type PaymentMethodRow = z.infer<typeof paymentMethodRowSchema>

export const updatePaymentMethodSchema = z.object({
  requiresReference: z.boolean().optional(),
  commissionBp: safeInt.min(0).max(10_000, "La comisión no puede pasar de 100 %").optional(),
  active: z.boolean().optional(),
})
export type UpdatePaymentMethodBody = z.infer<typeof updatePaymentMethodSchema>

// Inventario: motivos de ajuste (merma, vencido, uso interno…) y lo que valen las salidas.

export const stockDirectionSchema = z.enum(["in", "out"])

export const stockReasonSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** «in» solo admite cantidades positivas; «out», negativas. */
  direction: stockDirectionSchema,
  position: safeInt,
  active: z.boolean(),
  /** Ajustes vigentes (sin contar los anulados) que tiene. */
  adjustmentCount: safeInt,
})
export type StockReason = z.infer<typeof stockReasonSchema>

export const createStockReasonSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(60),
  direction: stockDirectionSchema,
})
export type CreateStockReasonBody = z.infer<typeof createStockReasonSchema>

/** El sentido no cambia: lo ya registrado dejaría de ser coherente. */
export const updateStockReasonSchema = updateCategorySchema
export type UpdateStockReasonBody = z.infer<typeof updateStockReasonSchema>

export const stockAdjustmentRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  postedAt: safeInt,
  reasonId: z.string().nullable(),
  reasonName: z.string().nullable(),
  direction: stockDirectionSchema,
  variantId: z.string(),
  productName: z.string(),
  sku: z.string(),
  /** Con signo: negativo = salió mercancía. El reverso lleva el signo contrario. */
  qtyMilli: safeInt,
  /** Último costo del producto al registrar el ajuste; null si no tenía o no se puede ver. */
  unitCostMinor: safeInt.nullable(),
  costCurrency: z.string().nullable(),
  /** Lo que vale la mercancía, en moneda legal y con el signo de la cantidad; null sin costo o tasa. */
  valueLegalMinor: safeInt.nullable(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  /** Id del reverso si se anuló. */
  reversedBy: z.string().nullable(),
  /** Es la anulación de otro ajuste. */
  reversesDocumentId: z.string().nullable(),
})
export type StockAdjustmentRow = z.infer<typeof stockAdjustmentRowSchema>

export const stockAdjustmentsSchema = z.object({
  rows: z.array(stockAdjustmentRowSchema),
  /** Por motivo, netos de anulaciones. */
  byReason: z.array(
    z.object({
      reasonId: z.string().nullable(),
      reasonName: z.string(),
      direction: stockDirectionSchema,
      count: safeInt,
      /** Valor en moneda legal (con signo de la cantidad); null si no se puede ver. */
      valueLegalMinor: safeInt.nullable(),
    }),
  ),
  /** Lo que valen las salidas del período (positivo), netas de anulaciones; null si no se ve el costo. */
  outLegalMinor: safeInt.nullable(),
  /** Lo que valen las entradas por ajuste (positivo); null si no se ve el costo. */
  inLegalMinor: safeInt.nullable(),
  /** Líneas sin costo conocido: no suman en los valores. */
  withoutCost: safeInt,
  legalCurrency: z.string(),
})
export type StockAdjustments = z.infer<typeof stockAdjustmentsSchema>

/** Propinas de un período por quien las recibe, netas de anulaciones. */
export const tipsReportSchema = z.object({
  legalCurrency: z.string(),
  referenceCurrency: z.string(),
  rows: z.array(
    z.object({
      /** null = para todo el equipo. */
      userId: z.string().nullable(),
      name: z.string(),
      /** Ventas con propina (sin contar las anuladas). */
      count: safeInt,
      totalLegalMinor: safeInt,
      /** En la moneda de referencia, a la tasa de cada venta; null si alguna no tenía tasa. */
      totalReferenceMinor: safeInt.nullable(),
    }),
  ),
  totalLegalMinor: safeInt,
  totalReferenceMinor: safeInt.nullable(),
})
export type TipsReport = z.infer<typeof tipsReportSchema>

/** Lo producido por tandas (`PRODUCTION`): una fila por producto de cada producción. */
export const productionRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  postedAt: safeInt,
  variantId: z.string(),
  productName: z.string(),
  /** Lo producido; el reverso lleva el signo contrario. */
  qtyMilli: safeInt,
  /** Costo por unidad según la receta al producir; null si no se sabe o no se puede ver. */
  unitCostMinor: safeInt.nullable(),
  costCurrency: z.string().nullable(),
  locationId: z.string(),
  locationName: z.string(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  /** Id del reverso si se anuló. */
  reversedBy: z.string().nullable(),
  /** Es la anulación de otra producción. */
  reversesDocumentId: z.string().nullable(),
})
export type ProductionRow = z.infer<typeof productionRowSchema>

// Informes por período: resultados (utilidad), ventas e inventario valorado.

/** Un rango de días ya convertido a milisegundos [from, to) en la zona horaria del negocio. */
export const reportRangeQuerySchema = z.object({
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
  /** Solo lo de esta sucursal (quien trabaja en algunas, ve solo las suyas). */
  branchId: z.string().min(1).optional(),
})

export const resultsReportSchema = z.object({
  from: safeInt,
  to: safeInt,
  legalCurrency: z.string(),
  sales: z.object({
    /** Ventas vigentes del período, sin contar las anuladas. */
    count: safeInt,
    /** Lo cobrado por ventas con el IVA, neto de devoluciones y anulaciones. */
    totalLegalMinor: safeInt,
    taxLegalMinor: safeInt,
    /** Ventas sin IVA: la base sobre la que se mide la utilidad. */
    netLegalMinor: safeInt,
    /** Descuentos dados (informativo; ya están restados). */
    discountLegalMinor: safeInt,
    /** IGTF cobrado: no es ingreso del comercio, se declara aparte. */
    surchargeLegalMinor: safeInt,
  }),
  /** Costo de lo vendido (último costo de cada producto al vender); null si no se ven costos. */
  costOfGoodsLegalMinor: safeInt.nullable(),
  /** Líneas vendidas sin costo conocido (ventas anteriores o productos sin compras): la utilidad sube. */
  linesWithoutCost: safeInt,
  grossProfitLegalMinor: safeInt.nullable(),
  /** Margen bruto en puntos básicos (2500 = 25 %); null sin ventas o sin costos. */
  grossMarginBp: safeInt.nullable(),
  expenses: z.object({
    count: safeInt,
    totalLegalMinor: safeInt,
    byCategory: z.array(z.object({ name: z.string(), count: safeInt, totalLegalMinor: safeInt })),
  }),
  /** Salidas de inventario por ajuste (merma, vencido…) a costo, menos las entradas por ajuste. */
  inventoryLossLegalMinor: safeInt.nullable(),
  /** Comisiones que descontaron bancos y puntos de venta. */
  commissionsLegalMinor: safeInt,
  netProfitLegalMinor: safeInt.nullable(),
  /** Compras de mercancía del período: informativo, no son un gasto (son inventario). */
  purchases: z.object({ count: safeInt, totalLegalMinor: safeInt }),
})
export type ResultsReport = z.infer<typeof resultsReportSchema>

export const salesReportSchema = z.object({
  from: safeInt,
  to: safeInt,
  legalCurrency: z.string(),
  totals: z.object({
    count: safeInt,
    totalLegalMinor: safeInt,
    netLegalMinor: safeInt,
    taxLegalMinor: safeInt,
    discountLegalMinor: safeInt,
    returnsLegalMinor: safeInt,
    /** Promedio por venta con IVA; 0 sin ventas. */
    averageLegalMinor: safeInt,
  }),
  /** Por día local (YYYY-MM-DD), solo los días con ventas. */
  byDay: z.array(z.object({ date: dateSchema, count: safeInt, totalLegalMinor: safeInt })),
  byProduct: z.array(
    z.object({
      variantId: z.string(),
      name: z.string(),
      sku: z.string(),
      qtyMilli: safeInt,
      totalLegalMinor: safeInt,
      /** Costo de lo vendido y utilidad; null si no se ven costos o no se conocen. */
      costLegalMinor: safeInt.nullable(),
      profitLegalMinor: safeInt.nullable(),
    }),
  ),
  /**
   * Por categoría de producto (todas, no solo las más vendidas): lo vendido y, con costos, la
   * utilidad. La utilidad sale vacía si algún producto de la categoría no tiene costo conocido.
   */
  byCategory: z.array(
    z.object({
      categoryId: z.string().nullable(),
      name: z.string(),
      products: safeInt,
      totalLegalMinor: safeInt,
      costLegalMinor: safeInt.nullable(),
      profitLegalMinor: safeInt.nullable(),
    }),
  ),
  /** Cobrado por método, con la comisión que descontó el banco (moneda de cada método). */
  byMethod: z.array(
    z.object({
      methodName: z.string(),
      currency: z.string(),
      amountMinor: safeInt,
      commissionMinor: safeInt,
    }),
  ),
  byUser: z.array(z.object({ name: z.string(), count: safeInt, totalLegalMinor: safeInt })),
})
export type SalesReport = z.infer<typeof salesReportSchema>

/** Base e IVA de una alícuota en un renglón del libro, en moneda legal. */
const taxBookGroupSchema = z.object({
  /** `kind:rateBp`, la columna de `rates` a la que pertenece. */
  key: z.string(),
  baseLegalMinor: safeInt,
  taxLegalMinor: safeInt,
})

export const taxBookQuerySchema = reportRangeQuerySchema.extend({
  kind: z.enum(["sales", "purchases"]).default("sales"),
})

/**
 * Libro de ventas o de compras: documento por documento, con la base y el IVA de cada alícuota.
 * Informativo para el contador (las notas de venta no son facturas fiscales).
 */
export const taxBookSchema = z.object({
  kind: z.enum(["sales", "purchases"]),
  from: safeInt,
  to: safeInt,
  legalCurrency: z.string(),
  /** Las alícuotas que aparecen en el período: una columna (base e IVA) cada una. */
  rates: z.array(z.object({ key: z.string(), kind: z.enum(TAX_KINDS), rateBp: safeInt })),
  rows: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      type: z.enum(["SALE", "RETURN", "PURCHASE", "PURCHASE_RETURN"]),
      postedAt: safeInt,
      /** Si es una anulación, el número del documento que anula. */
      voids: z.string().nullable(),
      /** Si es una devolución, el número de la venta (o compra) devuelta. */
      returns: z.string().nullable(),
      contactName: z.string().nullable(),
      contactTaxId: z.string().nullable(),
      /** Número de la factura del proveedor (compras). */
      externalRef: z.string().nullable(),
      /** Ventas con factura: su número y su número de control, si ya se anotaron. */
      invoiceNumber: z.string().nullable(),
      controlNumber: z.string().nullable(),
      /** Con signo: las devoluciones y anulaciones restan. */
      totalLegalMinor: safeInt,
      /** IGTF cobrado (ventas). */
      surchargeLegalMinor: safeInt,
      groups: z.array(taxBookGroupSchema),
    }),
  ),
  totals: z.object({
    totalLegalMinor: safeInt,
    surchargeLegalMinor: safeInt,
    groups: z.array(taxBookGroupSchema),
  }),
})
export type TaxBook = z.infer<typeof taxBookSchema>

export const inventoryReportSchema = z.object({
  legalCurrency: z.string(),
  referenceCurrency: z.string(),
  /** Tasa usada para llevar costos y precios a moneda legal (la vigente); null si no hay. */
  rate: z.string().nullable(),
  rows: z.array(
    z.object({
      variantId: z.string(),
      name: z.string(),
      sku: z.string(),
      category: z.string().nullable(),
      stockMilli: safeInt,
      minStockMilli: safeInt.nullable(),
      costMinor: safeInt.nullable(),
      costCurrency: z.string().nullable(),
      priceMinor: safeInt,
      priceCurrency: z.string(),
      /** existencia × costo, en moneda legal; null sin costo o sin tasa. */
      valueLegalMinor: safeInt.nullable(),
      /** existencia × precio, en moneda legal. */
      retailLegalMinor: safeInt.nullable(),
    }),
  ),
  /** Lo que vale el inventario a costo y a precio de venta; null si no se ven costos. */
  totalValueLegalMinor: safeInt.nullable(),
  totalRetailLegalMinor: safeInt.nullable(),
  /** Productos con existencia pero sin costo conocido: no suman en el valor a costo. */
  withoutCost: safeInt,
})
export type InventoryReport = z.infer<typeof inventoryReportSchema>

// Cambio masivo de precios.

export const priceRoundingSchema = z.enum(["none", "five", "ten", "unit"])
export type PriceRounding = z.infer<typeof priceRoundingSchema>

export const bulkPriceBodySchema = z
  .object({
    /** Solo estos productos (p. ej. los filtrados en pantalla). */
    variantIds: z.array(z.string().min(1)).min(1).max(5000).optional(),
    /** Solo los de esta categoría; "none" = los que no tienen. */
    categoryId: z.string().min(1).optional(),
    /**
     * percent: sube (o baja, si es negativo) el precio de hoy en ese porcentaje.
     * markup: precio = costo × (1 + ganancia), más el IVA si los precios lo incluyen.
     */
    mode: z.enum(["percent", "markup"]),
    /** En centésimas de punto: 1000 = 10 %. */
    valueBp: safeInt.min(-9_900).max(1_000_000),
    /** A qué se redondea el precio nuevo (al más cercano): céntimo, 5 o 10 céntimos, o unidad. */
    rounding: priceRoundingSchema,
    /** false: solo calcula los cambios; true: los guarda. */
    apply: z.boolean(),
  })
  .refine((b) => b.mode === "percent" || b.valueBp >= 0, {
    path: ["valueBp"],
    message: "La ganancia sobre el costo no puede ser negativa",
  })
  .refine((b) => b.valueBp !== 0 || b.mode === "markup" || b.rounding !== "none", {
    path: ["valueBp"],
    message: "Escribe un porcentaje distinto de cero",
  })
export type BulkPriceBody = z.infer<typeof bulkPriceBodySchema>

export const bulkPriceResultSchema = z.object({
  applied: z.boolean(),
  /** Productos que cambian de precio, los que quedan igual y los que no se pudieron calcular. */
  changed: safeInt,
  unchanged: safeInt,
  skipped: safeInt,
  /** Sin costo de compra o sin tasa para llevar el costo a la moneda del precio. */
  skippedNoCost: safeInt,
  skippedNoRate: safeInt,
  /** Los primeros 500 cambios, por nombre. */
  changes: z.array(
    z.object({
      productId: z.string(),
      variantId: z.string(),
      name: z.string(),
      sku: z.string(),
      currency: z.string(),
      beforeMinor: safeInt,
      afterMinor: safeInt,
    }),
  ),
})
export type BulkPriceResult = z.infer<typeof bulkPriceResultSchema>

// Listas de precios

export const priceListSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** % sobre el precio base para los productos sin precio propio (−1000 = 10 % menos). */
  adjustBp: safeInt,
  position: safeInt,
  active: z.boolean(),
  /** Productos con precio propio en la lista y clientes que compran con ella. */
  priceCount: safeInt,
  customerCount: safeInt,
})
export type PriceList = z.infer<typeof priceListSchema>

export const createPriceListSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(60),
  adjustBp: safeInt.min(-9_900, "No se puede bajar el 100 %").max(1_000_000).default(0),
})
export type CreatePriceListBody = z.infer<typeof createPriceListSchema>

export const updatePriceListSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  adjustBp: safeInt.min(-9_900).max(1_000_000).optional(),
  position: safeInt.min(0).optional(),
  active: z.boolean().optional(),
})
export type UpdatePriceListBody = z.infer<typeof updatePriceListSchema>

// Recargos de venta (delivery, servicio…)

export const saleChargeSchema = saleChargeInfoSchema.extend({
  position: safeInt,
  active: z.boolean(),
})
export type SaleCharge = z.infer<typeof saleChargeSchema>

export const createSaleChargeSchema = z
  .object({
    name: z.string().trim().min(1, "Escribe el nombre").max(60),
    kind: z.enum(["percent", "fixed"]),
    rateBp: safeInt.min(0).max(10_000).default(0),
    amountMinor: safeInt.min(0).default(0),
    currency: currencyCodeSchema.nullish(),
    taxId: z.string().min(1).nullish(),
    auto: z.boolean().default(false),
  })
  .refine((b) => b.kind !== "percent" || b.rateBp > 0, {
    path: ["rateBp"],
    message: "Escribe el porcentaje",
  })
  .refine((b) => b.kind !== "fixed" || !!b.currency, {
    path: ["currency"],
    message: "Elige la moneda del monto",
  })
export type CreateSaleChargeBody = z.infer<typeof createSaleChargeSchema>

export const updateSaleChargeSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  rateBp: safeInt.min(1).max(10_000).optional(),
  amountMinor: safeInt.min(0).optional(),
  currency: currencyCodeSchema.optional(),
  taxId: z.string().min(1).nullish(),
  auto: z.boolean().optional(),
  position: safeInt.min(0).optional(),
  active: z.boolean().optional(),
})
export type UpdateSaleChargeBody = z.infer<typeof updateSaleChargeSchema>

// Cotizaciones

/** Un descuento como en la caja: % (centésimas de punto) o un monto en una moneda. */
export const discountSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent"), bp: safeInt.min(1).max(10_000) }),
  z.object({
    kind: z.literal("amount"),
    amountMinor: safeInt.min(1),
    currency: currencyCodeSchema,
  }),
])

export const quoteChargeSchema = z.object({
  chargeId: z.string().min(1),
  amount: z.object({ amountMinor: safeInt.min(0), currency: currencyCodeSchema }).optional(),
})

export const quoteLineInputSchema = z.object({
  variantId: z.string().min(1),
  qtyMilli: safeInt.min(1, "La cantidad debe ser positiva"),
  /** Precio cotizado (ya con la lista de precios, si había), en su moneda. */
  priceMinor: safeInt.min(0),
  priceCurrency: currencyCodeSchema,
  discount: discountSpecSchema.nullish(),
})

export const createQuoteSchema = z.object({
  id: uuidv7Schema,
  contactId: z.string().min(1).nullish(),
  /** Días que valen los precios (0 = solo hoy). */
  validDays: safeInt.min(0).max(365).default(7),
  note: z.string().trim().max(500).nullish(),
  lines: z.array(quoteLineInputSchema).min(1, "La cotización no tiene productos").max(200),
  saleDiscount: discountSpecSchema.nullish(),
  charges: z.array(quoteChargeSchema).max(10).default([]),
  /** Lo que vale hoy (lo calcula la caja): en moneda legal, en la de referencia y la tasa. */
  totalLegalMinor: safeInt.min(0),
  totalRefMinor: safeInt.min(0).nullable(),
  rateValue: z.string().nullable(),
})
export type CreateQuoteBody = z.infer<typeof createQuoteSchema>

export const quoteStatusSchema = z.enum(["open", "converted", "cancelled"])

export const quoteSummarySchema = z.object({
  id: z.string(),
  number: z.string(),
  status: quoteStatusSchema,
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  validUntil: safeInt,
  totalLegalMinor: safeInt,
  totalRefMinor: safeInt.nullable(),
  rateValue: z.string().nullable(),
  lineCount: safeInt,
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: safeInt,
  closedAt: safeInt.nullable(),
  /** La venta en que se convirtió. */
  documentId: z.string().nullable(),
  documentNumber: z.string().nullable(),
})
export type QuoteSummary = z.infer<typeof quoteSummarySchema>

export const quoteDetailSchema = quoteSummarySchema.extend({
  lines: z.array(
    quoteLineInputSchema.extend({
      lineNo: safeInt,
      name: z.string(),
      /** IVA del producto hoy (null = el por defecto), para volver a armar el ticket. */
      taxId: z.string().nullable(),
      /** El producto sigue a la venta. */
      active: z.boolean(),
    }),
  ),
  saleDiscount: discountSpecSchema.nullable(),
  charges: z.array(quoteChargeSchema),
  /** El cliente completo (para cobrarle: su lista, su crédito). */
  contact: contactSchema.nullable(),
})
export type QuoteDetail = z.infer<typeof quoteDetailSchema>

// Importación desde Excel

export const importCellSchema = z.union([z.string().max(1000), z.number(), z.null()])

export const importBodySchema = z.object({
  /** Cada fila con su número en el archivo (para los avisos) y sus valores por campo. */
  rows: z
    .array(z.object({ row: safeInt.min(1), values: z.record(z.string(), importCellSchema) }))
    .min(1, "El archivo no tiene filas")
    .max(5000, "Como máximo 5.000 filas por archivo"),
  /** Si un producto o contacto ya existe: actualizarlo (true) u omitir la fila (false). */
  updateExisting: z.boolean().default(false),
  /** false: solo revisa y cuenta; true: guarda las filas válidas. */
  apply: z.boolean(),
})
export type ImportBody = z.infer<typeof importBodySchema>

export const importResultSchema = z.object({
  applied: z.boolean(),
  created: safeInt,
  updated: safeInt,
  skipped: safeInt,
  errors: safeInt,
  rows: z.array(
    z.object({
      row: safeInt,
      name: z.string(),
      status: z.enum(["create", "update", "skip", "error"]),
      messages: z.array(z.string()),
    }),
  ),
  /** Categorías que se crean al importar productos. */
  newCategories: z.array(z.string()),
  /** Ajuste de inventario con la existencia inicial; null si no hubo. */
  stockDocumentNumber: z.string().nullable(),
  /** Saldos pendientes que se anotan (contactos): uno por contacto nuevo con saldo. */
  debts: safeInt,
})
export type ImportResult = z.infer<typeof importResultSchema>

// Funciones activables y guía para arrancar

/** Lo que cada comercio puede apagar si no lo usa: se esconde del menú y de la caja. */
export const featuresSchema = z.object({
  quotes: z.boolean(),
  priceLists: z.boolean(),
  charges: z.boolean(),
  recurring: z.boolean(),
  payables: z.boolean(),
  /** Varias ubicaciones (depósito, otra tienda), varias cajas y traslados. */
  locations: z.boolean(),
  /** Lotes con fecha de vencimiento en los productos perecederos. */
  lots: z.boolean(),
  /** Tallas, colores u otras características, cada combinación con su código y su existencia. */
  variants: z.boolean(),
  /** Salas, mesas y cuentas abiertas (restaurantes). */
  tables: z.boolean(),
  /** Opciones y extras al vender (término, sin cebolla, queso extra). */
  modifiers: z.boolean(),
  /** Comandas a la cocina o la barra: impresora de la estación o pantalla de cocina. */
  kitchen: z.boolean(),
  /** Recetas: los platos descuentan sus ingredientes al venderse. */
  recipes: z.boolean(),
  /** Propinas al cobrar, para un mesonero o para el equipo, con su informe. */
  tips: z.boolean(),
  /** Balanza: etiquetas con el peso o el precio y lectura del peso por el puerto serie. */
  scale: z.boolean(),
  /** Varias sucursales contra este servidor: inventario, cajas, personal e informes de cada una. */
  branches: z.boolean(),
  /** Catálogo en línea: una página pública con los productos, sus fotos y sus precios. */
  catalog: z.boolean(),
})
export type Features = z.infer<typeof featuresSchema>

export const updateFeaturesSchema = featuresSchema.partial()

export const onboardingSchema = z.object({
  dismissed: z.boolean(),
  steps: z.array(
    z.object({
      id: z.enum(["business", "rate", "products", "users", "printer", "features", "sale"]),
      done: z.boolean(),
    }),
  ),
})
export type Onboarding = z.infer<typeof onboardingSchema>

// Ubicaciones y cajas

export const locationKindSchema = z.enum(["store", "warehouse", "kitchen"])
export type LocationKind = z.infer<typeof locationKindSchema>

/** Donde se guarda la mercancía: la tienda, el depósito, la cocina, otra tienda. */
export const stockLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: locationKindSchema,
  active: z.boolean(),
  /** Productos con existencia distinta de cero en esta ubicación. */
  productsInStock: safeInt,
  branchId: z.string(),
  branchName: z.string(),
})
export type StockLocation = z.infer<typeof stockLocationSchema>

export const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: locationKindSchema,
  /** Sucursal a la que pertenece; si falta, la principal. */
  branchId: z.string().min(1).optional(),
})
export type CreateLocationBody = z.infer<typeof createLocationSchema>

export const updateLocationSchema = createLocationSchema
  .partial()
  .extend({ active: z.boolean().optional() })
export type UpdateLocationBody = z.infer<typeof updateLocationSchema>

/** Una caja: vende de la existencia de su ubicación y cuenta su propia gaveta en cada turno. */
export const terminalSchema = z.object({
  id: z.string(),
  /** Prefijo de sus documentos: C2 → C2-000001. No cambia. */
  code: z.string(),
  name: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  branchId: z.string(),
  branchName: z.string(),
  active: z.boolean(),
  /** Si tiene un turno abierto. */
  shiftOpen: z.boolean(),
})
export type TerminalInfo = z.infer<typeof terminalSchema>

export const createTerminalSchema = z.object({
  name: z.string().trim().min(1).max(60),
  locationId: z.string().min(1),
  /** Prefijo de sus documentos; si falta, el siguiente libre (C2, C3…). */
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,6}$/, "Hasta 6 letras o números, sin espacios")
    .optional(),
})
export type CreateTerminalBody = z.infer<typeof createTerminalSchema>

export const updateTerminalSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  locationId: z.string().min(1).optional(),
  active: z.boolean().optional(),
})
export type UpdateTerminalBody = z.infer<typeof updateTerminalSchema>

// Sucursales

/** Un local del negocio con sus ubicaciones y sus cajas. */
export const branchSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  /** Lista de precios con que vende; null, el precio base. */
  priceListId: z.string().nullable(),
  active: z.boolean(),
  /** Cuántas ubicaciones y cajas activas tiene. */
  locations: safeInt,
  terminals: safeInt,
})
export type BranchInfo = z.infer<typeof branchSchema>

const branchFields = {
  name: z.string().trim().min(1).max(60),
  address: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
  priceListId: z.string().min(1).nullish(),
}

/** Al crearla, llega con su tienda y su primera caja: lista para vender. */
export const createBranchSchema = z.object(branchFields)
export type CreateBranchBody = z.infer<typeof createBranchSchema>

export const updateBranchSchema = z
  .object(branchFields)
  .partial()
  .extend({ active: z.boolean().optional() })
export type UpdateBranchBody = z.infer<typeof updateBranchSchema>

// Lotes con vencimiento

/** Lo que hay de un lote en una ubicación. */
export const lotRowSchema = z.object({
  lotId: z.string(),
  variantId: z.string(),
  productName: z.string(),
  sku: z.string(),
  code: z.string().nullable(),
  expiresOn: dateSchema.nullable(),
  /** Días que le quedan (0 = vence hoy, negativo = vencido); null sin fecha. */
  daysLeft: safeInt.nullable(),
  locationId: z.string(),
  locationName: z.string(),
  qtyMilli: safeInt,
  /** El documento con que entró. */
  documentId: z.string(),
  documentNumber: z.string(),
  createdAt: safeInt,
})
export type LotRow = z.infer<typeof lotRowSchema>

export const lotsSchema = z.object({
  /** Hoy en la zona del negocio (AAAA-MM-DD). */
  today: dateSchema,
  /** Con cuántos días de anticipación se avisa. */
  alertDays: safeInt,
  rows: z.array(lotRowSchema),
})
export type Lots = z.infer<typeof lotsSchema>

export const updateLotSchema = z.object({
  code: z.string().trim().max(40).nullable().optional(),
  expiresOn: dateSchema.nullable().optional(),
})
export type UpdateLotBody = z.infer<typeof updateLotSchema>

export const lotSettingsSchema = z.object({
  /** Avisar de los lotes que vencen dentro de estos días. */
  alertDays: z.number().int().min(1).max(365),
})
export type LotSettings = z.infer<typeof lotSettingsSchema>

// Claves de la API

/** Una clave de la API, sin su secreto (solo se ve al crearla). */
export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** El comienzo del secreto («mwk_Ab12Cd34»), para reconocerla. */
  prefix: z.string(),
  permissions: z.array(z.enum(API_KEY_PERMISSIONS)),
  /** Quien la creó: la clave actúa como esa persona. */
  userId: z.string(),
  userName: z.string(),
  createdAt: safeInt,
  lastUsedAt: safeInt.nullable(),
  revokedAt: safeInt.nullable(),
})
export type ApiKey = z.infer<typeof apiKeySchema>

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Escribe para qué es").max(60),
  permissions: z
    .array(z.enum(API_KEY_PERMISSIONS))
    .min(1, "Elige al menos un permiso")
    .max(API_KEY_PERMISSIONS.length),
})
export type CreateApiKeyBody = z.infer<typeof createApiKeySchema>

/** La clave recién creada con su secreto: no se vuelve a mostrar. */
export const createdApiKeySchema = z.object({ key: apiKeySchema, secret: z.string() })
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>

// Webhooks

/** Lo que puede avisar un webhook. */
export const WEBHOOK_EVENTS = [
  "sale.posted",
  "document.posted",
  "document.voided",
  "shift.opened",
  "shift.closed",
  "rate.updated",
  "order.created",
] as const
export const webhookEventSchema = z.enum(WEBHOOK_EVENTS)
export type WebhookEvent = z.infer<typeof webhookEventSchema>

const webhookUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((u) => /^https?:\/\/[^\s/]+/i.test(u), "Escribe una dirección que empiece con https://")

export const webhookSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(webhookEventSchema),
  /** Con él se firma cada aviso (cabecera `x-millhiore-signature`). */
  secret: z.string(),
  active: z.boolean(),
  createdAt: safeInt,
  /** El último aviso: cuándo y cómo le fue; null si todavía no hubo. */
  last: z
    .object({
      status: z.enum(["pending", "delivered", "failed"]),
      at: safeInt,
      lastStatus: safeInt.nullable(),
    })
    .nullable(),
})
export type Webhook = z.infer<typeof webhookSchema>

export const createWebhookSchema = z.object({
  name: z.string().trim().min(1, "Escribe para qué es").max(60),
  url: webhookUrlSchema,
  events: z.array(webhookEventSchema).min(1, "Elige al menos un evento"),
})
export type CreateWebhookBody = z.infer<typeof createWebhookSchema>

export const updateWebhookSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  url: webhookUrlSchema.optional(),
  events: z.array(webhookEventSchema).min(1, "Elige al menos un evento").optional(),
  active: z.boolean().optional(),
})
export type UpdateWebhookBody = z.infer<typeof updateWebhookSchema>

// Conectar otros equipos de la red local

export const networkInfoSchema = z.object({
  /** Direcciones para abrir la app desde un celular o una tablet de la red local. */
  httpUrls: z.array(z.string()),
  /** Las mismas con HTTPS (vacío si está apagado); exigen instalar antes la autoridad local. */
  httpsUrls: z.array(z.string()),
  /** De dónde se descarga el certificado de la autoridad (por HTTP, para poder instalarlo). */
  caUrls: z.array(z.string()),
  /** Huella SHA-256 de la autoridad, para comprobar en el equipo que es la nuestra. */
  caFingerprint: z.string().nullable(),
})
export type NetworkInfo = z.infer<typeof networkInfoSchema>

// Acceso remoto

export const remoteStatusSchema = z.object({
  /** El puerto en que escucha la app (para el comando de Tailscale). */
  port: safeInt,
  tailscale: z.object({
    /** No está instalado, está apagado, falta entrar con la cuenta o está funcionando. */
    state: z.enum(["missing", "stopped", "loggedOut", "running"]),
    /** El nombre de esta PC en Tailscale. */
    name: z.string().nullable(),
    /** La red de Tailscale (la cuenta). */
    tailnet: z.string().nullable(),
    /** Para abrir la app desde los equipos propios, estén donde estén. */
    httpUrl: z.string().nullable(),
    /** La misma con HTTPS válido de Tailscale (si se activó). */
    httpsUrl: z.string().nullable(),
  }),
})
export type RemoteStatus = z.infer<typeof remoteStatusSchema>

export const serveResultSchema = z.object({
  ok: z.boolean(),
  /** Tailscale pide habilitar HTTPS en la cuenta: se abre esta dirección y se vuelve a intentar. */
  approveUrl: z.string().nullable(),
  message: z.string(),
})
export type ServeResult = z.infer<typeof serveResultSchema>

// Catálogo en línea

/** Cómo se ve el catálogo en línea. */
export const storefrontSettingsSchema = z.object({
  /** Un aviso arriba del catálogo: horario, zonas de delivery, formas de pago. */
  message: z.string().trim().max(300).nullable(),
  /** WhatsApp para escribir y pedir; null = el teléfono del negocio. */
  whatsapp: z.string().trim().max(40).nullable(),
  /** Lista de precios del catálogo; null = el precio normal. */
  priceListId: z.string().min(1).nullable(),
  /** Precios en las dos monedas, solo en la de referencia ($) o solo en bolívares. */
  currencies: z.enum(["both", "reference", "legal"]),
  /** Lo que se acabó: se marca «agotado», no se muestra, o se muestra igual. */
  soldOut: z.enum(["mark", "hide", "ignore"]),
  /** Categorías que no salen (insumos, uso interno). */
  hiddenCategoryIds: z.array(z.string().min(1)).max(200),
  /** Sucursal cuya existencia cuenta para «agotado» (con varias sucursales). */
  branchId: z.string().min(1),
  /** Se puede pedir desde el catálogo (el pedido llega a «Pedidos» y por WhatsApp). */
  orders: z.boolean(),
  /** Ofrece delivery además de retirar en la tienda. */
  delivery: z.boolean(),
})
export type StorefrontSettings = z.infer<typeof storefrontSettingsSchema>

export const updateStorefrontSchema = storefrontSettingsSchema.partial()
export type UpdateStorefrontBody = z.infer<typeof updateStorefrontSchema>

export const storefrontStatusSchema = z.object({
  settings: storefrontSettingsSchema,
  /** El puerto que solo sirve el catálogo (lo que se publica en internet); null si está apagado. */
  port: safeInt.nullable(),
  /** Para abrirlo desde la red local (por ese puerto). */
  urls: z.array(z.string()),
  /** La dirección pública con Tailscale Funnel, si ya se publicó. */
  publicUrl: z.string().nullable(),
  /** Cómo está Tailscale en esta PC (para guiar la publicación). */
  tailscale: z.enum(["missing", "stopped", "loggedOut", "running"]),
  /** Productos que salen en el catálogo y cuántos tienen foto. */
  products: safeInt,
  withImage: safeInt,
})
export type StorefrontStatus = z.infer<typeof storefrontStatusSchema>

/** Una forma de un producto en el catálogo, con su precio para el público (IVA incluido). */
export const publicVariantSchema = z.object({
  id: z.string(),
  optionValues: z.array(z.string()).nullable(),
  /** En la moneda de referencia y en bolívares a la tasa del día; null si no hay tasa. */
  referenceMinor: safeInt.nullable(),
  legalMinor: safeInt.nullable(),
  /** Hay existencia (o no lleva); false = agotado. */
  available: z.boolean(),
})

export const publicProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  categoryId: z.string().nullable(),
  unit: productUnitSchema,
  /** Dirección de la foto; null si no tiene. */
  imageUrl: z.string().nullable(),
  options: z.array(productOptionSchema).nullable(),
  variants: z.array(publicVariantSchema).min(1),
})
export type PublicProduct = z.infer<typeof publicProductSchema>

/** Lo que ve cualquiera en el catálogo en línea: nada de costos, códigos ni cantidades. */
export const publicCatalogSchema = z.object({
  business: z.object({
    name: z.string(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  message: z.string().nullable(),
  /** El número para wa.me (584141234567); null si no hay. */
  whatsapp: z.string().nullable(),
  currencies: storefrontSettingsSchema.shape.currencies,
  referenceCurrency: z.string(),
  legalCurrency: z.string(),
  /** La tasa con que se calcularon los bolívares; null si no hay. */
  rate: z.object({ value: z.string(), effectiveAt: safeInt }).nullable(),
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
  products: z.array(publicProductSchema),
  /** Pedir desde el catálogo; null si el negocio no recibe pedidos. */
  orders: z
    .object({
      delivery: z.boolean(),
      /** Las formas de pago que se ofrecen (sus nombres). */
      payments: z.array(z.string()),
    })
    .nullable(),
})
export type PublicCatalog = z.infer<typeof publicCatalogSchema>

// Pedidos desde el catálogo

export const ORDER_STATUSES = ["new", "done", "cancelled"] as const
export const orderStatusSchema = z.enum(ORDER_STATUSES)

/** Lo que manda el cliente desde el catálogo; los precios los pone el servidor. */
export const createOrderSchema = z.object({
  /** Lo genera la página: si reintenta, el pedido no se anota dos veces. */
  id: z.string().min(8).max(64),
  name: z.string().trim().min(1, "Escribe tu nombre").max(80),
  phone: z.string().trim().min(7, "Escribe tu teléfono").max(40),
  delivery: z.enum(["pickup", "delivery"]),
  address: z.string().trim().max(200).nullish(),
  payment: z.string().trim().max(60).nullish(),
  note: z.string().trim().max(300).nullish(),
  lines: z
    .array(
      z.object({
        variantId: z.string().min(1).max(64),
        qtyMilli: safeInt.min(1, "La cantidad debe ser mayor que cero").max(1_000_000),
        note: z.string().trim().max(140).nullish(),
      }),
    )
    .min(1, "El pedido está vacío")
    .max(50),
})
export type CreateOrderBody = z.infer<typeof createOrderSchema>

export const orderLineSchema = z.object({
  variantId: z.string(),
  name: z.string(),
  unit: productUnitSchema,
  qtyMilli: safeInt,
  /** Precio de una unidad (IVA incluido) en la moneda de referencia y en la legal. */
  referenceMinor: safeInt.nullable(),
  legalMinor: safeInt.nullable(),
  note: z.string().nullable(),
})

/** Lo que vuelve al cliente: el número y los precios con que quedó anotado. */
export const placedOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  lines: z.array(orderLineSchema),
  totalReferenceMinor: safeInt.nullable(),
  totalLegalMinor: safeInt.nullable(),
  referenceCurrency: z.string(),
  legalCurrency: z.string(),
})
export type PlacedOrder = z.infer<typeof placedOrderSchema>

/** Un pedido en la bandeja de la tienda. */
export const webOrderSchema = placedOrderSchema.extend({
  status: orderStatusSchema,
  customerName: z.string(),
  customerPhone: z.string(),
  delivery: z.enum(["pickup", "delivery"]),
  address: z.string().nullable(),
  payment: z.string().nullable(),
  note: z.string().nullable(),
  priceListId: z.string().nullable(),
  documentId: z.string().nullable(),
  documentNumber: z.string().nullable(),
  cancelReason: z.string().nullable(),
  handledByName: z.string().nullable(),
  handledAt: safeInt.nullable(),
  createdAt: safeInt,
})
export type WebOrder = z.infer<typeof webOrderSchema>

export const cancelOrderSchema = z.object({
  reason: z.string().trim().max(200).nullish(),
})

// Plugins

/** Un nombre de equipo de internet («api.ejemplo.com»), sin esquema ni puerto. */
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "Un dominio, p. ej. api.ejemplo.com",
  )

/** Una ruta dentro del paquete («page/index.html»), sin subir de carpeta. */
const packagePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "Ruta inválida")

/** El `manifest.json` de un plugin: quién es, qué permisos pide y qué trae. */
export const pluginManifestSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "El id va en minúsculas, con números y guiones"),
  name: z.string().trim().min(1).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, "Versión como 1.0.0"),
  description: z.string().trim().max(300).optional(),
  author: z.string().trim().max(80).optional(),
  /** Lo que puede hacer en la API (nunca manejar usuarios ni ajustes). */
  permissions: z.array(z.enum(API_KEY_PERMISSIONS)).max(API_KEY_PERMISSIONS.length).default([]),
  /** Los eventos que recibe (los mismos de los webhooks). */
  events: z.array(webhookEventSchema).max(WEBHOOK_EVENTS.length).default([]),
  /** Los únicos equipos de internet a los que puede llamar (por HTTPS). */
  network: z.array(hostnameSchema).max(10).default([]),
  /** El código que corre en el servidor (aislado). */
  server: packagePathSchema.optional(),
  /** Su pantalla en la app (en un marco aislado). */
  page: z.object({ title: z.string().trim().min(1).max(40), entry: packagePathSchema }).optional(),
})
export type PluginManifest = z.infer<typeof pluginManifestSchema>

export const pluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  permissions: z.array(z.string()),
  events: z.array(z.string()),
  network: z.array(z.string()),
  /** La pantalla en la app; null si no trae. */
  page: z.object({ title: z.string(), url: z.string() }).nullable(),
  hasServer: z.boolean(),
  enabled: z.boolean(),
  /** Está cargado y corriendo ahora mismo. */
  running: z.boolean(),
  installedAt: safeInt,
  installedByName: z.string().nullable(),
  updatedAt: safeInt,
  lastError: z.string().nullable(),
  lastErrorAt: safeInt.nullable(),
  /** Eventos que esperan llegarle. */
  pendingEvents: safeInt,
})
export type PluginInfo = z.infer<typeof pluginSchema>

export const pluginLogSchema = z.object({
  at: safeInt,
  level: z.enum(["info", "error"]),
  message: z.string(),
})
export type PluginLog = z.infer<typeof pluginLogSchema>

/** Un plugin con pantalla, para el menú de quien puede usarla. */
export const pluginPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
})
export type PluginPage = z.infer<typeof pluginPageSchema>

// Sincronización entre servidores (central y sucursales)

export const syncRoleSchema = z.enum(["standalone", "central", "satellite"])
export type SyncRole = z.infer<typeof syncRoleSchema>

/** Una sucursal con su propio servidor, vista desde el central. */
export const syncPeerSchema = z.object({
  id: z.string(),
  branchId: z.string(),
  branchName: z.string(),
  /** El nombre de la PC de la sucursal. */
  name: z.string(),
  pairedAt: safeInt,
  lastSeenAt: safeInt.nullable(),
  lastPushAt: safeInt.nullable(),
  documentsReceived: safeInt,
})
export type SyncPeer = z.infer<typeof syncPeerSchema>

export const syncStatusSchema = z.object({
  role: syncRoleSchema,
  /** En una sucursal: su central y cómo va la sincronización. */
  central: z
    .object({
      url: z.string(),
      branchId: z.string(),
      branchName: z.string(),
      pairedAt: safeInt,
      lastSyncAt: safeInt.nullable(),
      lastMasterAt: safeInt.nullable(),
      /** Documentos registrados aquí que todavía no llegan al central. */
      pendingDocuments: safeInt,
      lastError: z.string().nullable(),
      lastErrorAt: safeInt.nullable(),
    })
    .nullable(),
  /** En el central: las sucursales con servidor propio. */
  peers: z.array(syncPeerSchema),
})
export type SyncStatus = z.infer<typeof syncStatusSchema>

export const createPairingSchema = z.object({ branchId: z.string().min(1) })

export const pairingCodeSchema = z.object({
  /** Se escribe en la PC de la sucursal; vale una hora y una sola vez. */
  code: z.string(),
  branchId: z.string(),
  expiresAt: safeInt,
  /** Por dónde la sucursal llega a este servidor (primero las de Tailscale). */
  urls: z.array(z.string()),
})
export type PairingCode = z.infer<typeof pairingCodeSchema>

/** En una instalación nueva: unirla como sucursal de un central. */
export const joinCentralSchema = z.object({
  centralUrl: z.string().trim().min(3, "Escribe la dirección del central").max(200),
  code: z.string().trim().min(6, "Escribe el código que muestra el central").max(40),
  /** El nombre de esta PC (para reconocerla en el central). */
  name: z.string().trim().max(60).optional(),
})
export type JoinCentralBody = z.infer<typeof joinCentralSchema>

export const joinResultSchema = z.object({ businessName: z.string(), branchName: z.string() })

// Alertas por Telegram

/** Un chat (una persona o un grupo) que recibe las alertas. */
export const telegramChatSchema = z.object({
  id: z.string().regex(/^-?\d+$/, "Id de chat inválido"),
  name: z.string().trim().min(1).max(80),
})
export type TelegramChat = z.infer<typeof telegramChatSchema>

/** Qué alertas se mandan. */
export const telegramAlertsSchema = z.object({
  /** El resumen del día, a la hora elegida (0–23, en la hora del negocio). */
  daily: z.boolean(),
  dailyHour: z.number().int().min(0).max(23),
  /** Un producto llegó a su existencia mínima. */
  lowStock: z.boolean(),
  /** Se anuló una venta, una compra u otro documento. */
  voids: z.boolean(),
  /** Se cerró un turno, con el arqueo (faltantes y sobrantes). */
  shifts: z.boolean(),
  /** Hay tasa nueva. */
  rate: z.boolean(),
  /** Llegó un pedido desde el catálogo en línea. */
  orders: z.boolean(),
})
export type TelegramAlerts = z.infer<typeof telegramAlertsSchema>

export const telegramSettingsSchema = z.object({
  /** Hay un bot conectado (su token no se devuelve nunca). */
  configured: z.boolean(),
  /** El usuario del bot («@MiBodegaBot»). */
  botName: z.string().nullable(),
  chats: z.array(telegramChatSchema),
  alerts: telegramAlertsSchema,
})
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>

export const updateTelegramSchema = z.object({
  /** El token que da @BotFather («123456:ABC…»); null desconecta el bot. */
  token: z
    .string()
    .trim()
    .regex(/^\d{5,}:[\w-]{30,}$/, "Pega el token completo que te dio @BotFather")
    .nullable()
    .optional(),
  chats: z.array(telegramChatSchema).max(10, "Máximo 10 chats").optional(),
  /** Lo que no venga queda como estaba (así un cliente anterior a una alerta nueva no la borra). */
  alerts: telegramAlertsSchema.partial().optional(),
})
export type UpdateTelegramBody = z.infer<typeof updateTelegramSchema>

export const telegramTestSchema = z.object({ sent: safeInt, errors: z.array(z.string()) })
export type TelegramTest = z.infer<typeof telegramTestSchema>

/** Un aviso a un webhook con sus intentos. */
export const webhookDeliverySchema = z.object({
  id: z.string(),
  webhookId: z.string(),
  eventId: z.string(),
  event: z.string(),
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: safeInt,
  nextAttemptAt: safeInt.nullable(),
  lastStatus: safeInt.nullable(),
  lastError: z.string().nullable(),
  createdAt: safeInt,
  deliveredAt: safeInt.nullable(),
})
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>

// Etiquetas con código de barras

/** Hojas de etiquetas adhesivas que se imprimen en cualquier impresora. */
export const LABEL_SHEETS = ["letter-3x10", "letter-2x10", "a4-3x8"] as const

export const labelSettingsSchema = z.object({
  /** Rollo de una impresora de etiquetas (una etiqueta por página) u hoja con varias. */
  paper: z.enum(["roll", ...LABEL_SHEETS]),
  /** Tamaño de cada etiqueta del rollo, en milímetros. */
  widthMm: z.number().int().min(20, "Mínimo 20 mm").max(120, "Máximo 120 mm"),
  heightMm: z.number().int().min(15, "Mínimo 15 mm").max(100, "Máximo 100 mm"),
  /**
   * Qué precio lleva: ninguno, en la moneda en que se fijó, en la de referencia, en la legal (a la
   * tasa del día en que se imprime) o en ambas.
   */
  price: z.enum(["none", "own", "reference", "legal", "both"]),
  showBusiness: z.boolean(),
  showSku: z.boolean(),
})
export type LabelSettings = z.infer<typeof labelSettingsSchema>

// Códigos de descuento

export const discountCodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  kind: z.enum(["percent", "amount"]),
  /** Porcentaje en centésimas de punto (1000 = 10 %). */
  rateBp: safeInt,
  amountMinor: safeInt,
  currency: z.string().nullable(),
  maxUses: safeInt.nullable(),
  validFrom: dateSchema.nullable(),
  validUntil: dateSchema.nullable(),
  note: z.string().nullable(),
  active: z.boolean(),
  /** Ventas vigentes que lo usaron (las anuladas no cuentan). */
  uses: safeInt,
})
export type DiscountCode = z.infer<typeof discountCodeSchema>

const discountCodeFields = {
  code: z
    .string()
    .trim()
    .min(2, "Al menos 2 caracteres")
    .max(30)
    .regex(/^[A-Za-z0-9_-]+$/, "Solo letras, números, guion y guion bajo"),
  kind: z.enum(["percent", "amount"]),
  rateBp: safeInt.min(1).max(10_000).optional(),
  amountMinor: safeInt.min(1).optional(),
  currency: currencyCodeSchema.optional(),
  maxUses: safeInt.min(1).nullish(),
  validFrom: dateSchema.nullish(),
  validUntil: dateSchema.nullish(),
  note: z.string().trim().max(200).nullish(),
}

export const createDiscountCodeSchema = z.object(discountCodeFields)
export type CreateDiscountCodeBody = z.infer<typeof createDiscountCodeSchema>

export const updateDiscountCodeSchema = z
  .object(discountCodeFields)
  .partial()
  .extend({ active: z.boolean().optional() })
export type UpdateDiscountCodeBody = z.infer<typeof updateDiscountCodeSchema>

// Restaurante: salas, mesas y cuentas abiertas

export const tabStatusSchema = z.enum(["open", "closed", "cancelled"])

/** Una cuenta como se ve en el plano de mesas. */
export const tabSummarySchema = z.object({
  id: z.string(),
  number: z.string(),
  tableId: z.string().nullable(),
  tableName: z.string().nullable(),
  areaName: z.string().nullable(),
  /** Nombre de una cuenta sin mesa («Juan», «Para llevar»). */
  label: z.string().nullable(),
  guests: safeInt.nullable(),
  status: tabStatusSchema,
  waiterId: z.string().nullable(),
  waiterName: z.string().nullable(),
  note: z.string().nullable(),
  openedAt: safeInt,
  closedAt: safeInt.nullable(),
  /** Productos por cobrar (en milésimas) y lo que suman en cada moneda de precio. */
  pendingQtyMilli: safeInt,
  pending: z.array(z.object({ currency: z.string(), amountMinor: safeInt })),
})
export type TabSummary = z.infer<typeof tabSummarySchema>

export const tabLineSchema = z.object({
  id: z.string(),
  variantId: z.string(),
  name: z.string(),
  qtyMilli: safeInt,
  priceMinor: safeInt,
  priceCurrency: z.string(),
  /** IVA del producto (null = el por defecto), para armar el ticket al cobrar. */
  taxId: z.string().nullable(),
  note: z.string().nullable(),
  /** Opciones y extras, con lo que suma cada uno (aparte de `priceMinor`). */
  modifiers: z.array(pickedModifierSchema),
  /** En la cocina: por preparar o listo; null si no fue a ninguna estación. */
  kitchen: z.enum(["pending", "ready"]).nullable(),
  addedAt: safeInt,
  addedBy: z.string().nullable(),
  voidedAt: safeInt.nullable(),
  voidedBy: z.string().nullable(),
  voidReason: z.string().nullable(),
  /** La venta que lo cobró. */
  documentId: z.string().nullable(),
  documentNumber: z.string().nullable(),
})
export type TabLine = z.infer<typeof tabLineSchema>

export const tabDetailSchema = tabSummarySchema.extend({
  cancelReason: z.string().nullable(),
  /** En el orden en que se pidieron. */
  lines: z.array(tabLineSchema),
})
export type TabDetail = z.infer<typeof tabDetailSchema>

export const diningTableSchema = z.object({
  id: z.string(),
  areaId: z.string(),
  name: z.string(),
  seats: safeInt.nullable(),
  /** La cuenta abierta de la mesa; null = libre. */
  tab: tabSummarySchema.nullable(),
})
export type DiningTable = z.infer<typeof diningTableSchema>

/** Las salas activas con sus mesas, y las cuentas abiertas sin mesa. */
export const diningFloorSchema = z.object({
  areas: z.array(
    z.object({ id: z.string(), name: z.string(), tables: z.array(diningTableSchema) }),
  ),
  others: z.array(tabSummarySchema),
})
export type DiningFloor = z.infer<typeof diningFloorSchema>

/**
 * Las salas y sus mesas, en orden, tal como deben quedar: las que traen id se renombran, las que
 * no, se crean, y las que faltan se desactivan (si no tienen una cuenta abierta).
 */
export const diningLayoutSchema = z.object({
  areas: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        name: z.string().trim().min(1, "Ponle nombre a la sala").max(40),
        tables: z
          .array(
            z.object({
              id: z.string().min(1).optional(),
              name: z.string().trim().min(1, "Ponle nombre a la mesa").max(20),
              seats: safeInt.min(1).max(99).nullish(),
            }),
          )
          .max(200),
      }),
    )
    .max(20),
})
export type DiningLayoutBody = z.infer<typeof diningLayoutSchema>

export const openTabSchema = z
  .object({
    id: uuidv7Schema,
    tableId: z.string().min(1).nullish(),
    label: z.string().trim().max(40).nullish(),
    guests: safeInt.min(1).max(999).nullish(),
    note: z.string().trim().max(200).nullish(),
  })
  .refine((t) => t.tableId || t.label, {
    message: "Elige la mesa o ponle nombre a la cuenta",
    path: ["label"],
  })
export type OpenTabBody = z.infer<typeof openTabSchema>

export const updateTabSchema = z.object({
  label: z.string().trim().max(40).nullish(),
  guests: safeInt.min(1).max(999).nullish(),
  note: z.string().trim().max(200).nullish(),
  waiterId: z.string().min(1).nullish(),
})
export type UpdateTabBody = z.infer<typeof updateTabSchema>

/** Un pedido: lo que se agrega a la cuenta de una vez. Cada línea trae su id (reintentar no duplica). */
export const addTabLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        id: uuidv7Schema,
        variantId: z.string().min(1),
        qtyMilli: safeInt.min(1).max(1_000_000),
        note: z.string().trim().max(140).nullish(),
        modifierIds: z.array(z.string().min(1)).max(20).optional(),
      }),
    )
    .min(1)
    .max(100),
})
export type AddTabLinesBody = z.infer<typeof addTabLinesSchema>

export const voidTabLineSchema = z.object({
  qtyMilli: safeInt.min(1),
  reason: z.string().trim().min(2, "Escribe por qué se anula").max(200),
})
export type VoidTabLineBody = z.infer<typeof voidTabLineSchema>

/** Pasa la cuenta (o algunos de sus productos) a otra mesa o cuenta; si está ocupada, se juntan. */
export const moveTabSchema = z
  .object({
    tableId: z.string().min(1).optional(),
    tabId: z.string().min(1).optional(),
    /** Solo estos productos y cuánto de cada uno; si falta, toda la cuenta. */
    lines: z
      .array(z.object({ lineId: z.string().min(1), qtyMilli: safeInt.min(1) }))
      .min(1)
      .max(500)
      .optional(),
  })
  .refine((m) => !m.tableId !== !m.tabId, {
    message: "Elige la mesa o la cuenta a la que pasa",
    path: ["tableId"],
  })
export type MoveTabBody = z.infer<typeof moveTabSchema>

export const cancelTabSchema = z.object({ reason: z.string().trim().max(200).nullish() })
export type CancelTabBody = z.infer<typeof cancelTabSchema>

/**
 * Una precuenta ya armada (con los montos escritos como se ven en pantalla) para imprimirla en la
 * térmica: no es un documento, solo lo que la mesa debe hasta ahora.
 */
export const printBillSchema = z.object({
  title: z.string().max(60),
  info: z.array(z.string().max(120)).max(10),
  items: z
    .array(
      z.object({
        name: z.string().max(200),
        detail: z.string().max(200),
        amount: z.string().max(40),
      }),
    )
    .max(300),
  rows: z
    .array(
      z.object({
        label: z.string().max(120),
        amount: z.string().max(40),
        bold: z.boolean().optional(),
      }),
    )
    .max(30),
  footer: z.array(z.string().max(200)).max(10),
})
export type PrintBillBody = z.infer<typeof printBillSchema>

// Opciones y extras

export const modifierGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  minSelect: safeInt,
  maxSelect: safeInt.nullable(),
  active: z.boolean(),
  /** Las opciones, también las desactivadas, en su orden. */
  modifiers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      priceMinor: safeInt,
      priceCurrency: z.string().nullable(),
      active: z.boolean(),
    }),
  ),
  /** Productos activos que lo ofrecen. */
  productCount: safeInt,
})
export type ModifierGroup = z.infer<typeof modifierGroupSchema>

/**
 * Un grupo con sus opciones tal como deben quedar: las que traen id se editan, las nuevas se
 * crean y las que faltan se desactivan (las ventas pasadas conservan su nombre y su precio).
 */
export const saveModifierGroupSchema = z
  .object({
    name: z.string().trim().min(1, "Ponle nombre al grupo").max(40),
    minSelect: safeInt.min(0).max(20).default(0),
    maxSelect: safeInt.min(1).max(20).nullable().default(null),
    active: z.boolean().default(true),
    modifiers: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          name: z.string().trim().min(1, "Ponle nombre a la opción").max(40),
          priceMinor: safeInt.min(0).default(0),
          priceCurrency: currencyCodeSchema.nullish(),
        }),
      )
      .min(1, "Agrega al menos una opción")
      .max(40),
  })
  .refine((g) => g.maxSelect === null || g.maxSelect >= Math.max(g.minSelect, 1), {
    message: "El máximo no puede ser menor que el mínimo",
    path: ["maxSelect"],
  })
  .refine((g) => g.minSelect <= g.modifiers.length, {
    message: "Hay que elegir más opciones de las que hay",
    path: ["minSelect"],
  })
  .refine((g) => g.modifiers.every((m) => m.priceMinor === 0 || m.priceCurrency), {
    message: "Elige la moneda del precio",
    path: ["modifiers"],
  })
export type SaveModifierGroupBody = z.infer<typeof saveModifierGroupSchema>

// Comandas a cocina

/** La impresora de una estación: de red, compartida en Windows o un dispositivo. */
export const stationPrinterSchema = printerSettingsSchema
  .pick({ host: true, port: true, share: true, device: true, paperWidth: true })
  .extend({ mode: z.enum(["network", "windows", "device"]) })
export type StationPrinter = z.infer<typeof stationPrinterSchema>

export const kitchenStationSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Categorías que prepara; null = todo lo que no va a otra estación. */
  categoryIds: z.array(z.string()).nullable(),
  /** null = solo la pantalla de cocina. */
  printer: stationPrinterSchema.nullable(),
  /** También recibe lo vendido directo en la caja. */
  counterSales: z.boolean(),
  /** Minutos en que debería estar listo. */
  targetMinutes: safeInt,
  active: z.boolean(),
})
export type KitchenStation = z.infer<typeof kitchenStationSchema>

export const saveKitchenStationSchema = z.object({
  name: z.string().trim().min(1, "Ponle nombre a la estación").max(40),
  categoryIds: z.array(z.string().min(1)).max(100).nullable(),
  printer: stationPrinterSchema.nullable(),
  counterSales: z.boolean().default(true),
  targetMinutes: safeInt.min(1).max(240).default(15),
  active: z.boolean().default(true),
})
export type SaveKitchenStationBody = z.infer<typeof saveKitchenStationSchema>

export const kitchenTicketSchema = z.object({
  id: z.string(),
  /** Número del día. */
  number: safeInt,
  stationId: z.string(),
  stationName: z.string(),
  /** «order»: preparar; «void»: se anuló, dejar de preparar. */
  kind: z.enum(["order", "void"]),
  /** Para quién: «Mesa 4», «Juan (barra)», «Venta C1-000123». */
  source: z.string(),
  tabId: z.string().nullable(),
  documentId: z.string().nullable(),
  status: z.enum(["pending", "ready"]),
  createdAt: safeInt,
  /** Quien lo pidió. */
  createdBy: z.string().nullable(),
  readyAt: safeInt.nullable(),
  printedAt: safeInt.nullable(),
  printError: z.string().nullable(),
  lines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      qtyMilli: safeInt,
      modifiers: z.array(pickedModifierSchema),
      note: z.string().nullable(),
    }),
  ),
})
export type KitchenTicket = z.infer<typeof kitchenTicketSchema>
