import type {
  Account,
  AuditEntry,
  Bootstrap,
  CatalogItem,
  Category,
  Contact,
  DaySummary,
  DiscountCode,
  DocumentDetail,
  DocumentSummary,
  ExchangeExposure,
  ExpenseCategory,
  Expenses,
  FiscalSettingsBody,
  InventoryReport,
  Lots,
  Me,
  Onboarding,
  Payables,
  PaymentMethodRow,
  PriceList,
  QuoteDetail,
  QuoteSummary,
  Receivables,
  RecurringExpense,
  ResultsReport,
  SaleCharge,
  SalesReport,
  SessionRow,
  Shift,
  ShiftReport,
  Statement,
  StockAdjustments,
  StockLocation,
  StockReason,
  TaxBook,
  TerminalInfo,
  TransferRow,
} from "@millhiore/contracts"
import { QueryClient, queryOptions } from "@tanstack/react-query"
import { ApiError, api } from "./api"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
})

export interface Rate {
  id: string
  base: string
  quote: string
  value: string
  source: "bcv" | "dolarapi" | "manual"
  effectiveAt: number
  createdAt: number
}

export interface RateStatus {
  pair: { base: string; quote: string } | null
  current: Rate | null
  lastCheck: { at: number; ok: boolean; source: string | null; error: string | null } | null
  stale: boolean
}

export interface UserRow {
  id: string
  username: string | null
  name: string
  roleId: string | null
  active: boolean
  mustChangePassword: boolean
}

export interface Tax {
  id: string
  code: string
  name: string
  kind: "taxed" | "exempt" | "exonerated" | "not_subject"
  rateBp: number
  active: boolean
}

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: () => api<{ status: string; configured: boolean }>("/api/health"),
  staleTime: Number.POSITIVE_INFINITY,
})

/** Usuario de la sesión, o null si no hay sesión. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    try {
      return await api<Me>("/api/me")
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  staleTime: 5 * 60_000,
})

export const bootstrapQuery = queryOptions({
  queryKey: ["bootstrap"],
  queryFn: () => api<Bootstrap>("/api/bootstrap"),
  staleTime: 5 * 60_000,
})

export const rateStatusQuery = queryOptions({
  queryKey: ["rates", "status"],
  queryFn: () => api<RateStatus>("/api/rates/status"),
  // Sin tasa (p. ej. recién instalado, mientras el servidor consulta al BCV) se insiste seguido.
  refetchInterval: (query) => (query.state.data?.current ? 5 * 60_000 : 5_000),
})

export const productsQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["products", opts.all ? "all" : "active"],
    queryFn: () => api<CatalogItem[]>(`/api/products${opts.all ? "?all=true" : ""}`),
  })

export const documentsQuery = (params: { type: string; from?: number; to?: number }) =>
  queryOptions({
    queryKey: ["documents", params],
    queryFn: () => {
      const q = new URLSearchParams({ type: params.type, limit: "500" })
      if (params.from !== undefined) q.set("from", String(params.from))
      if (params.to !== undefined) q.set("to", String(params.to))
      return api<DocumentSummary[]>(`/api/documents?${q}`)
    },
  })

export const documentQuery = (id: string) =>
  queryOptions({
    queryKey: ["document", id],
    queryFn: () => api<DocumentDetail>(`/api/documents/${id}`),
    staleTime: Number.POSITIVE_INFINITY,
  })

export const usersQuery = queryOptions({
  queryKey: ["users"],
  queryFn: () => api<UserRow[]>("/api/users"),
})

export const rolesQuery = queryOptions({
  queryKey: ["roles"],
  queryFn: () => api<{ id: string; name: string; permissions: string[] }[]>("/api/roles"),
  staleTime: Number.POSITIVE_INFINITY,
})

export const fiscalQuery = queryOptions({
  queryKey: ["fiscal"],
  queryFn: () => api<FiscalSettingsBody>("/api/settings/fiscal"),
})

export const taxesQuery = queryOptions({
  queryKey: ["taxes"],
  queryFn: () => api<Tax[]>("/api/taxes"),
})

export const currentShiftQuery = (terminalId: string) =>
  queryOptions({
    queryKey: ["shifts", "current", terminalId],
    queryFn: () => api<Shift | null>(`/api/shifts/current?terminalId=${terminalId}`),
  })

export const shiftsQuery = queryOptions({
  queryKey: ["shifts", "list"],
  queryFn: () => api<Shift[]>("/api/shifts?limit=60"),
})

export const shiftReportQuery = (id: string) =>
  queryOptions({
    queryKey: ["shifts", "report", id],
    queryFn: () => api<ShiftReport>(`/api/shifts/${id}/report`),
  })

export const contactsQuery = (
  params: { kind?: "customer" | "supplier"; search?: string; all?: boolean } = {},
) =>
  queryOptions({
    queryKey: ["contacts", params],
    queryFn: () => {
      const q = new URLSearchParams()
      if (params.kind) q.set("kind", params.kind)
      if (params.search) q.set("search", params.search)
      if (params.all) q.set("all", "true")
      return api<Contact[]>(`/api/contacts?${q}`)
    },
  })

/** Resumen de un día (sin fecha = hoy en la zona del negocio). Hoy se refresca solo. */
export const daySummaryQuery = (date?: string) =>
  queryOptions({
    queryKey: ["reports", "day", date ?? "today"],
    queryFn: () => api<DaySummary>(`/api/reports/day${date ? `?date=${date}` : ""}`),
    // Siempre fresco al entrar: lo vendido hace un momento tiene que verse ya.
    staleTime: 0,
    refetchInterval: date ? false : 60_000,
  })

export const ratesHistoryQuery = queryOptions({
  queryKey: ["rates", "history"],
  queryFn: () => api<Rate[]>("/api/rates?limit=20"),
})

/** Lo que debe cada cliente (fiado). Se refresca al volver a la pantalla. */
export const receivablesQuery = queryOptions({
  queryKey: ["receivables"],
  queryFn: () => api<Receivables>("/api/receivables"),
  staleTime: 0,
})

/** Lo que se le debe a cada proveedor, con la antigüedad de saldos. */
export const payablesQuery = queryOptions({
  queryKey: ["payables"],
  queryFn: () => api<Payables>("/api/payables"),
  staleTime: 0,
})

/** Estado de cuenta de un cliente: lo que debe venta por venta y su historial. */
export const statementQuery = (contactId: string) =>
  queryOptions({
    queryKey: ["receivables", "statement", contactId],
    queryFn: () => api<Statement>(`/api/contacts/${contactId}/statement`),
    staleTime: 0,
  })

/** Categorías de productos, en su orden. `all` incluye las desactivadas. */
export const categoriesQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["categories", opts.all ? "all" : "active"],
    queryFn: () => api<Category[]>(`/api/categories${opts.all ? "?all=true" : ""}`),
    staleTime: 60_000,
  })

/** Sesiones abiertas: las propias, o las de todos (exige gestionar usuarios). */
export const sessionsQuery = (all = false) =>
  queryOptions({
    queryKey: ["sessions", all],
    queryFn: () => api<SessionRow[]>(`/api/sessions?all=${all}`),
    staleTime: 0,
  })

/** Bitácora de acciones sensibles, de lo más reciente a lo más antiguo. */
export const auditQuery = (params: { from: number; to: number; action: string }) =>
  queryOptions({
    queryKey: ["audit", params],
    queryFn: () => {
      const q = new URLSearchParams({
        from: String(params.from),
        to: String(params.to),
        limit: "500",
      })
      if (params.action) q.set("action", params.action)
      return api<AuditEntry[]>(`/api/audit?${q}`)
    },
    staleTime: 0,
  })

/** Categorías de gasto, en su orden. `all` incluye las desactivadas. */
export const expenseCategoriesQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["expense-categories", opts.all ? "all" : "active"],
    queryFn: () => api<ExpenseCategory[]>(`/api/expense-categories${opts.all ? "?all=true" : ""}`),
    staleTime: 60_000,
  })

/** Gastos de un período con lo gastado en total y por categoría. */
export const expensesQuery = (params: { from: number; to: number; categoryId: string }) =>
  queryOptions({
    queryKey: ["expenses", params],
    queryFn: () => {
      const q = new URLSearchParams({
        from: String(params.from),
        to: String(params.to),
        limit: "500",
      })
      if (params.categoryId) q.set("categoryId", params.categoryId)
      return api<Expenses>(`/api/expenses?${q}`)
    },
    staleTime: 0,
  })

/** Gastos recurrentes (alquiler, internet, sueldos…), los vencidos primero. */
export const recurringQuery = queryOptions({
  queryKey: ["recurring"],
  queryFn: () => api<RecurringExpense[]>("/api/recurring-expenses"),
  staleTime: 0,
})

/** Cuentas de dinero con su saldo. `all` incluye las desactivadas. */
export const accountsQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["accounts", opts.all ? "all" : "active"],
    queryFn: () => api<Account[]>(`/api/accounts${opts.all ? "?all=true" : ""}`),
    staleTime: 0,
  })

/** Exposición cambiaria de los saldos en bolívares (se refresca con las cuentas). */
export const exposureQuery = queryOptions({
  queryKey: ["accounts", "exposure"],
  queryFn: () => api<ExchangeExposure>("/api/accounts/exposure"),
  staleTime: 0,
})

/** Transferencias entre cuentas desde una fecha, las más recientes primero. */
export const transfersQuery = (params: { from: number }) =>
  queryOptions({
    queryKey: ["transfers", params],
    queryFn: () => api<TransferRow[]>(`/api/transfers?from=${params.from}&limit=200`),
    staleTime: 0,
  })

/** Métodos de pago con su cuenta y su comisión (también los que no se ofrecen). */
export const paymentMethodsQuery = queryOptions({
  queryKey: ["payment-methods"],
  queryFn: () => api<PaymentMethodRow[]>("/api/payment-methods"),
  staleTime: 0,
})

/** Motivos de ajuste de inventario, en su orden. `all` incluye los desactivados. */
export const stockReasonsQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["stock-reasons", opts.all ? "all" : "active"],
    queryFn: () => api<StockReason[]>(`/api/stock-reasons${opts.all ? "?all=true" : ""}`),
    staleTime: 60_000,
  })

/** Ajustes de inventario de un período con su valor por motivo. */
export const stockAdjustmentsQuery = (params: { from: number; to: number; reasonId: string }) =>
  queryOptions({
    queryKey: ["stock-adjustments", params],
    queryFn: () => {
      const q = new URLSearchParams({
        from: String(params.from),
        to: String(params.to),
        limit: "500",
      })
      if (params.reasonId) q.set("reasonId", params.reasonId)
      return api<StockAdjustments>(`/api/stock-adjustments?${q}`)
    },
    staleTime: 0,
  })

const rangeQuery = (b: { from: number; to: number }) => `from=${b.from}&to=${b.to}`

/** Estado de resultados de un período (ventas, costo, gastos, utilidad). */
export const resultsReportQuery = (bounds: { from: number; to: number }) =>
  queryOptions({
    queryKey: ["reports", "results", bounds],
    queryFn: () => api<ResultsReport>(`/api/reports/results?${rangeQuery(bounds)}`),
    staleTime: 0,
  })

/** Ventas de un período por día, producto, método y vendedor. */
export const salesReportQuery = (bounds: { from: number; to: number }) =>
  queryOptions({
    queryKey: ["reports", "sales", bounds],
    queryFn: () => api<SalesReport>(`/api/reports/sales?${rangeQuery(bounds)}`),
    staleTime: 0,
  })

/** Libro de ventas o de compras de un período, con el IVA de cada documento. */
export const taxBookQuery = (bounds: { from: number; to: number }, kind: "sales" | "purchases") =>
  queryOptions({
    queryKey: ["reports", "tax-book", kind, bounds],
    queryFn: () => api<TaxBook>(`/api/reports/tax-book?kind=${kind}&${rangeQuery(bounds)}`),
    staleTime: 0,
  })

/** Inventario valorado de hoy. */
/** Inventario valorado de hoy; con `locationId`, solo lo de esa ubicación. */
export const inventoryReportQuery = (locationId = "") =>
  queryOptions({
    queryKey: ["reports", "inventory", locationId],
    queryFn: () =>
      api<InventoryReport>(
        `/api/reports/inventory${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ""}`,
      ),
    staleTime: 0,
  })

/** Listas de precios, en su orden. `all` incluye las desactivadas. */
export const priceListsQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["price-lists", opts.all ? "all" : "active"],
    queryFn: () => api<PriceList[]>(`/api/price-lists${opts.all ? "?all=true" : ""}`),
    staleTime: 60_000,
  })

/** Recargos de venta (delivery, servicio…), en su orden. `all` incluye los desactivados. */
export const chargesQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["charges", opts.all ? "all" : "active"],
    queryFn: () => api<SaleCharge[]>(`/api/charges${opts.all ? "?all=true" : ""}`),
    staleTime: 60_000,
  })

/** Ubicaciones (tienda, depósito…), la tienda primero. `all` incluye las desactivadas. */
export const locationsQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["locations", opts.all ? "all" : "active"],
    queryFn: () => api<StockLocation[]>(`/api/locations${opts.all ? "?all=true" : ""}`),
    staleTime: 30_000,
  })

/** Cajas con su ubicación y si tienen turno abierto. `all` incluye las desactivadas. */
export const terminalsQuery = (opts: { all?: boolean } = {}) =>
  queryOptions({
    queryKey: ["terminals", opts.all ? "all" : "active"],
    queryFn: () => api<TerminalInfo[]>(`/api/terminals${opts.all ? "?all=true" : ""}`),
    staleTime: 30_000,
  })

/** Lotes con existencia, el que vence primero arriba. */
export const lotsQuery = (
  params: { status?: "expiring" | "expired" | "all"; variantId?: string; locationId?: string } = {},
) =>
  queryOptions({
    queryKey: ["lots", params],
    queryFn: () => {
      const q = new URLSearchParams({ status: params.status ?? "all" })
      if (params.variantId) q.set("variantId", params.variantId)
      if (params.locationId) q.set("locationId", params.locationId)
      return api<Lots>(`/api/lots?${q}`)
    },
    staleTime: 0,
  })

/** Códigos de descuento, también los desactivados, con sus usos. */
export const discountCodesQuery = queryOptions({
  queryKey: ["discount-codes"],
  queryFn: () => api<DiscountCode[]>("/api/discount-codes?all=true"),
  staleTime: 0,
})

/** Cotizaciones, las más recientes primero. */
export const quotesQuery = (params: { status: string; search: string }) =>
  queryOptions({
    queryKey: ["quotes", params],
    queryFn: () => {
      const q = new URLSearchParams({ limit: "300" })
      if (params.status) q.set("status", params.status)
      if (params.search.trim()) q.set("search", params.search.trim())
      return api<QuoteSummary[]>(`/api/quotes?${q}`)
    },
    staleTime: 0,
  })

export const quoteQuery = (id: string) =>
  queryOptions({
    queryKey: ["quotes", "detail", id],
    queryFn: () => api<QuoteDetail>(`/api/quotes/${id}`),
    staleTime: 0,
  })

/** Guía para arrancar: los primeros pasos del comercio y cuáles faltan. */
export const onboardingQuery = queryOptions({
  queryKey: ["onboarding"],
  queryFn: () => api<Onboarding>("/api/onboarding"),
  staleTime: 0,
})
