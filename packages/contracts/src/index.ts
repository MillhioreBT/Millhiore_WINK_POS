import {
  isUuidv7,
  POSTABLE_TYPES,
  RECURRENCE_FREQUENCIES,
  TAX_KINDS,
  TAXPAYER_TYPES,
} from "@millhiore/domain"
import { z } from "zod"

// Esquemas de la API. Los usan el servidor (validación + OpenAPI) y la web (formularios y cliente).

const safeInt = z.number().int().safe()

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

export const postLineSchema = z.object({
  variantId: z.string().min(1),
  /** Milésimas de unidad: 1000 = 1. En ajustes lleva signo. */
  qtyMilli: safeInt.refine((n) => n !== 0, "La cantidad no puede ser cero"),
  unitPriceMinor: safeInt.min(0),
  /** Descuento sobre la línea, en la moneda del documento; exige el permiso de dar descuentos. */
  discountMinor: safeInt.min(0).default(0),
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
})
export type PostDocumentBody = z.infer<typeof postDocumentSchema>

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

// Catálogo. Por ahora cada producto tiene una sola variante (la que se vende).

export const productKindSchema = z.enum(["good", "service"])

export const catalogItemSchema = z.object({
  productId: z.string(),
  variantId: z.string(),
  name: z.string(),
  kind: productKindSchema,
  sku: z.string(),
  barcode: z.string().nullable(),
  priceMinor: safeInt,
  priceCurrency: z.string(),
  /** null = el impuesto por defecto del negocio. */
  taxId: z.string().nullable(),
  tracksStock: z.boolean(),
  active: z.boolean(),
  /** Último costo de compra; null si no hay o si quien consulta no tiene cost.view. */
  costMinor: safeInt.nullable(),
  costCurrency: z.string().nullable(),
  /** Existencia total en milésimas (1000 = 1). */
  stockMilli: safeInt,
  /** Existencia mínima en milésimas; null = sin aviso de reposición. */
  minStockMilli: safeInt.nullable(),
  /** Categoría del producto; null = sin categoría. */
  categoryId: z.string().nullable(),
})
export type CatalogItem = z.infer<typeof catalogItemSchema>

export const createProductSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre").max(120),
  kind: productKindSchema.default("good"),
  /** Si falta, se genera uno. */
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: z.string().trim().min(1).max(40).nullish(),
  priceMinor: safeInt.min(0, "El precio no puede ser negativo"),
  priceCurrency: currencyCodeSchema,
  /** null o ausente = el impuesto por defecto. */
  taxId: z.string().min(1).nullish(),
  minStockMilli: safeInt.min(0, "El mínimo no puede ser negativo").nullish(),
  /** null o ausente = sin categoría. */
  categoryId: z.string().min(1).nullish(),
})
export type CreateProductBody = z.infer<typeof createProductSchema>

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: z.string().trim().min(1).max(40).nullish(),
  priceMinor: safeInt.min(0).optional(),
  priceCurrency: currencyCodeSchema.optional(),
  taxId: z.string().min(1).nullish(),
  minStockMilli: safeInt.min(0, "El mínimo no puede ser negativo").nullish(),
  categoryId: z.string().min(1).nullish(),
  active: z.boolean().optional(),
})
export type UpdateProductBody = z.infer<typeof updateProductSchema>

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
  terminals: z.array(
    z.object({ id: z.string(), code: z.string(), name: z.string(), locationId: z.string() }),
  ),
  currencies: z.array(
    z.object({ code: z.string(), name: z.string(), symbol: z.string(), decimals: safeInt }),
  ),
  paymentMethods: z.array(paymentMethodInfoSchema),
  taxes: z.array(taxSchema),
  fiscal: fiscalSettingsSchema,
  credit: z.object({ enabled: z.boolean() }),
  security: z.object({ autoLockMinutes: safeInt }),
  printer: printerSettingsSchema.pick({
    mode: true,
    paperWidth: true,
    autoPrint: true,
    openDrawer: true,
  }),
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

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha AAAA-MM-DD")

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
  contactName: z.string().nullable(),
  contactTaxId: z.string().nullable(),
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
  /** Venta a crédito: lo que quedó a deber (negativo en el reverso). */
  creditMinor: safeInt,
  /** Moneda en que se debe lo fiado; null si no hay crédito. */
  creditCurrency: z.string().nullable(),
  /** Plazo para pagar lo fiado; null si no tiene. */
  dueAt: safeInt.nullable(),
})
export type DocumentSummary = z.infer<typeof documentSummarySchema>

export const documentDetailSchema = documentSummarySchema.extend({
  rate: exchangeRateSchema.nullable(),
  pricesIncludeTax: z.boolean(),
  lines: z.array(
    z.object({
      lineNo: safeInt,
      variantId: z.string(),
      name: z.string(),
      qtyMilli: safeInt,
      unitPriceMinor: safeInt,
      /** Descuento de la línea, ya restado de `lineTotalMinor`. */
      discountMinor: safeInt,
      lineTotalMinor: safeInt,
      taxId: z.string().nullable(),
      taxRateBp: safeInt,
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
})
export type Me = z.infer<typeof meSchema>

export const userRowSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  roleId: z.string().nullable(),
  active: z.boolean(),
  mustChangePassword: z.boolean(),
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
  kind: z.enum(["PURCHASE", "EXPENSE"]),
  /** Qué es: la descripción del gasto, o «Compra». */
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
      type: z.enum(["SALE", "PAYMENT_IN"]),
      postedAt: safeInt,
      currency: z.string(),
      /** Lo fiado (venta) o lo abonado (abono), en la moneda del documento. */
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

// Informes por período: resultados (utilidad), ventas e inventario valorado.

/** Un rango de días ya convertido a milisegundos [from, to) en la zona horaria del negocio. */
export const reportRangeQuerySchema = z.object({
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
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
