import { cn } from "@millhiore/ui"
import { Link, useRouterState } from "@tanstack/react-router"
import {
  ArrowLeftRightIcon,
  BarChart3Icon,
  BookOpenIcon,
  BoxesIcon,
  CalendarClockIcon,
  ChefHatIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  CookingPotIcon,
  FileTextIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SquareMenuIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { can, useFeatures, useMe } from "../lib/session"

export interface NavLink {
  to: string
  label: string
  icon: LucideIcon
}

/** Una entrada del menú: un enlace suelto o una sección con sus enlaces. */
export type NavEntry = NavLink | { label: string; icon: LucideIcon; items: NavLink[] }

const isGroup = (e: NavEntry): e is Extract<NavEntry, { items: NavLink[] }> => "items" in e

/**
 * El menú agrupado por lo que se hace: vender, el catálogo, el dinero… Cada quien solo ve lo que
 * su rol permite; una sección con un solo enlace visible se muestra como enlace suelto.
 */
export function useNav(): { main: NavEntry[]; settings: NavLink | null } {
  const me = useMe()
  const features = useFeatures()
  const show = (...p: string[]) => can(me, ...p)
  const entries: (NavEntry | null)[] = [
    show("report.view") ? { to: "/inicio", label: "Inicio", icon: LayoutDashboardIcon } : null,
    group("Ventas", ShoppingCartIcon, [
      show("sale.create") ? { to: "/caja", label: "Vender", icon: ShoppingCartIcon } : null,
      features.tables && show("table.serve")
        ? { to: "/mesas", label: "Mesas", icon: SquareMenuIcon }
        : null,
      features.kitchen && show("kitchen.view")
        ? { to: "/cocina", label: "Cocina", icon: ChefHatIcon }
        : null,
      show("sale.create", "report.view")
        ? { to: "/ventas", label: "Historial", icon: ReceiptTextIcon }
        : null,
      features.quotes && show("sale.create", "report.view")
        ? { to: "/cotizaciones", label: "Cotizaciones", icon: FileTextIcon }
        : null,
      show("payment.receive", "finance.view")
        ? { to: "/fiado", label: "Fiado", icon: BookOpenIcon }
        : null,
    ]),
    show("catalog.manage", "inventory.view")
      ? { to: "/productos", label: "Productos", icon: PackageIcon }
      : null,
    // Inventario agrupa los ajustes con el conteo, los traslados, los vencimientos y la producción.
    inventoryGroup([
      show("inventory.view", "inventory.adjust")
        ? { to: "/inventario", label: "Ajustes", icon: BoxesIcon }
        : null,
      show("inventory.adjust")
        ? { to: "/conteo", label: "Conteo físico", icon: ClipboardCheckIcon }
        : null,
      features.locations && show("inventory.adjust")
        ? { to: "/traslados", label: "Traslados", icon: ArrowLeftRightIcon }
        : null,
      features.lots && show("inventory.view", "inventory.adjust")
        ? { to: "/vencimientos", label: "Vencimientos", icon: CalendarClockIcon }
        : null,
      features.recipes && show("inventory.view", "inventory.adjust")
        ? { to: "/produccion", label: "Producción", icon: CookingPotIcon }
        : null,
    ]),
    show("purchase.create") ? { to: "/compras", label: "Compras", icon: TruckIcon } : null,
    show("contact.manage", "purchase.create")
      ? { to: "/contactos", label: "Contactos", icon: UsersIcon }
      : null,
    show("report.view") ? { to: "/informes", label: "Informes", icon: BarChart3Icon } : null,
    group("Finanzas", WalletIcon, [
      show("expense.create", "finance.view", "report.view")
        ? { to: "/gastos", label: "Gastos", icon: WalletIcon }
        : null,
      features.payables && show("payable.manage", "finance.view")
        ? { to: "/pagar", label: "Por pagar", icon: ScrollTextIcon }
        : null,
      show("finance.manage", "finance.view")
        ? { to: "/cuentas", label: "Cuentas", icon: LandmarkIcon }
        : null,
    ]),
  ]
  return {
    main: entries.filter((e): e is NavEntry => e !== null),
    settings: show("settings.manage", "rate.manage", "user.manage", "audit.view")
      ? { to: "/ajustes", label: "Ajustes", icon: SettingsIcon }
      : null,
  }
}

/** Inventario: si solo se ve la pantalla de ajustes, el enlace se llama «Inventario». */
function inventoryGroup(items: (NavLink | null)[]): NavEntry | null {
  const visible = items.filter((i): i is NavLink => i !== null)
  const [only] = visible
  if (visible.length === 1 && only?.to === "/inventario") return { ...only, label: "Inventario" }
  return group("Inventario", BoxesIcon, visible)
}

function group(label: string, icon: LucideIcon, items: (NavLink | null)[]): NavEntry | null {
  const visible = items.filter((i): i is NavLink => i !== null)
  if (visible.length === 0) return null
  const [only] = visible
  return visible.length === 1 && only ? only : { label, icon, items: visible }
}

export const itemClass =
  "flex h-9 items-center gap-3 rounded-md px-3 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
const activeClass =
  "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"

function NavGroup({
  entry,
  path,
  onNavigate,
  big,
}: {
  entry: Extract<NavEntry, { items: NavLink[] }>
  path: string
  onNavigate?: (() => void) | undefined
  big: boolean
}) {
  const active = entry.items.some((i) => path === i.to || path.startsWith(`${i.to}/`))
  const [open, setOpen] = useState(active)
  // Al entrar a una página de la sección se despliega sola.
  useEffect(() => {
    if (active) setOpen(true)
  }, [active])
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          itemClass,
          big && "h-11 text-base",
          "w-full cursor-pointer",
          active && activeClass,
        )}
      >
        <entry.icon className={big ? "size-5" : "size-4"} />
        <span className="flex-1 text-left">{entry.label}</span>
        <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="mt-1 grid gap-0.5">
          {entry.items.map((i) => (
            <Link
              key={i.to}
              to={i.to}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md py-2 pr-3 pl-9 text-muted-foreground text-sm transition-colors hover:text-foreground",
                big && "py-2.5 text-base",
              )}
              activeProps={{ className: "font-semibold text-foreground" }}
            >
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
              {i.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Los enlaces del menú: en la barra lateral (compacto) y en el panel del celular (grande). */
export function NavList({ big = false, onNavigate }: { big?: boolean; onNavigate?: () => void }) {
  const { main, settings } = useNav()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const link = (l: NavLink) => (
    <Link
      key={l.to}
      to={l.to}
      onClick={onNavigate}
      className={cn(itemClass, big && "h-11 text-base")}
      activeProps={{ className: activeClass }}
    >
      <l.icon className={big ? "size-5" : "size-4"} />
      {l.label}
    </Link>
  )
  return (
    <>
      <nav className="grid content-start gap-1" aria-label="Secciones">
        {main.map((e) =>
          isGroup(e) ? (
            <NavGroup key={e.label} entry={e} path={path} onNavigate={onNavigate} big={big} />
          ) : (
            link(e)
          ),
        )}
        {settings && big ? link(settings) : null}
      </nav>
      {settings && !big ? <div className="mt-auto grid gap-1 pt-3">{link(settings)}</div> : null}
    </>
  )
}
