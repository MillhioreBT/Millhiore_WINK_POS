import type { QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router"
import { AppShell } from "./components/AppShell"
import { AccountsPage } from "./features/accounts/AccountsPage"
import { LoginPage } from "./features/auth/LoginPage"
import { ContactsPage } from "./features/contacts/ContactsPage"
import { DashboardPage } from "./features/dashboard/DashboardPage"
import { ExpensesPage } from "./features/expenses/ExpensesPage"
import { CountPage } from "./features/inventory/CountPage"
import { ExpiryPage } from "./features/inventory/ExpiryPage"
import { InventoryPage } from "./features/inventory/InventoryPage"
import { ProductionPage } from "./features/inventory/ProductionPage"
import { TransfersPage } from "./features/inventory/TransfersPage"
import { KitchenPage } from "./features/kitchen/KitchenPage"
import { PayablesPage } from "./features/payables/PayablesPage"
import { PosPage } from "./features/pos/PosPage"
import { ProductsPage } from "./features/products/ProductsPage"
import { PurchasesPage } from "./features/purchases/PurchasesPage"
import { QuotesPage } from "./features/quotes/QuotesPage"
import { ReceivablesPage } from "./features/receivables/ReceivablesPage"
import { ReportsPage } from "./features/reports/ReportsPage"
import { SalesPage } from "./features/sales/SalesPage"
import { SettingsPage } from "./features/settings/SettingsPage"
import { SetupPage } from "./features/setup/SetupPage"
import { FloorPage } from "./features/tables/FloorPage"
import { TabPage } from "./features/tables/TabPage"
import { healthQuery, meQuery, queryClient } from "./lib/queries"
import { can } from "./lib/session"

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
})

/** Primer uso: sin negocio configurado todo lleva al asistente. */
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/configurar",
  beforeLoad: async ({ context }) => {
    const health = await context.queryClient.ensureQueryData(healthQuery)
    if (health.configured) throw redirect({ to: "/entrar" })
  },
  component: SetupPage,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/entrar",
  beforeLoad: async ({ context }) => {
    const health = await context.queryClient.ensureQueryData(healthQuery)
    if (!health.configured) throw redirect({ to: "/configurar" })
    if (await context.queryClient.fetchQuery(meQuery)) throw redirect({ to: "/" })
  },
  component: LoginPage,
})

/** Todo lo demás exige sesión. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context }) => {
    const health = await context.queryClient.ensureQueryData(healthQuery)
    if (!health.configured) throw redirect({ to: "/configurar" })
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (!me) throw redirect({ to: "/entrar" })
    return { me }
  },
  component: AppShell,
})

/**
 * Quien ve informes entra al resumen del día; el cajero, directo a la caja; el mesonero, a las
 * mesas; la cocina, a sus comandas.
 */
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    const me = context.me
    throw redirect({
      to: can(me, "report.view")
        ? "/inicio"
        : can(me, "sale.create")
          ? "/caja"
          : can(me, "table.serve")
            ? "/mesas"
            : can(me, "kitchen.view")
              ? "/cocina"
              : "/caja",
    })
  },
})

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/inicio",
  component: DashboardPage,
})

const posRoute = createRoute({ getParentRoute: () => appRoute, path: "/caja", component: PosPage })
const floorRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/mesas",
  component: FloorPage,
})
const kitchenRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/cocina",
  component: KitchenPage,
})
const tabRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/mesas/$tabId",
  component: function TabRoute() {
    const { tabId } = tabRoute.useParams()
    // Con la clave, cambiar de cuenta (al juntar mesas) arranca la pantalla de cero.
    return <TabPage key={tabId} tabId={tabId} />
  },
})
const productsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/productos",
  component: ProductsPage,
})
const salesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ventas",
  component: SalesPage,
})
const quotesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/cotizaciones",
  component: QuotesPage,
})
const receivablesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fiado",
  component: ReceivablesPage,
})
const payablesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/pagar",
  component: PayablesPage,
})
const expensesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/gastos",
  component: ExpensesPage,
})
const accountsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/cuentas",
  component: AccountsPage,
})
const inventoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/inventario",
  component: InventoryPage,
})
const transfersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/traslados",
  component: TransfersPage,
})
const productionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/produccion",
  component: ProductionPage,
})
const countRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/conteo",
  component: CountPage,
})
const expiryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vencimientos",
  component: ExpiryPage,
})
const reportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/informes",
  component: ReportsPage,
})
const purchasesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/compras",
  component: PurchasesPage,
})
const contactsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contactos",
  component: ContactsPage,
})
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ajustes",
  // ?tab=impuestos abre esa pestaña (los enlaces de la guía para arrancar).
  validateSearch: (search: Record<string, unknown>): { tab?: string } =>
    typeof search.tab === "string" ? { tab: search.tab } : {},
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    dashboardRoute,
    posRoute,
    floorRoute,
    kitchenRoute,
    tabRoute,
    productsRoute,
    salesRoute,
    quotesRoute,
    receivablesRoute,
    purchasesRoute,
    expensesRoute,
    payablesRoute,
    accountsRoute,
    inventoryRoute,
    transfersRoute,
    expiryRoute,
    productionRoute,
    countRoute,
    reportsRoute,
    contactsRoute,
    settingsRoute,
  ]),
])

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
