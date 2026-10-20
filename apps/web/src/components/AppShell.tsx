import {
  Button,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, Outlet, useNavigate } from "@tanstack/react-router"
import {
  ChevronDownIcon,
  HashIcon,
  KeyRoundIcon,
  LockIcon,
  LogOutIcon,
  MenuIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  SunIcon,
  UserIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { LockScreen } from "../features/account/LockScreen"
import { ChangePasswordDialog, ForcedPasswordChange } from "../features/account/PasswordForms"
import { PinDialog } from "../features/account/PinDialog"
import { SessionsDialog } from "../features/account/SessionsPanel"
import { useLock } from "../lib/lock"
import { bootstrapQuery } from "../lib/queries"
import { signOut, useMe } from "../lib/session"
import { itemClass, NavList } from "./Nav"
import { RateCalculator } from "./RateCalculator"

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    try {
      localStorage.setItem("theme", next ? "dark" : "light")
    } catch {
      // sin almacenamiento: el tema dura hasta recargar
    }
    setDark(next)
  }
  return { dark, toggle }
}

interface AccountActions {
  onSignOut: () => void
  onChangePassword: () => void
  onLock: () => void
  onPin: () => void
  onSessions: () => void
}

/** Menú lateral del celular: las secciones con su nombre, el tema y la salida. */
function MobileMenu({
  businessName,
  onSignOut,
  onChangePassword,
  onLock,
  onPin,
  onSessions,
}: AccountActions & { businessName: string }) {
  const me = useMe()
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const row =
    "flex h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
  const then = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" title="Menú">
          <MenuIcon className="size-5" />
          <span className="sr-only">Menú</span>
        </Button>
      </SheetTrigger>
      <SheetContent>
        <div className="flex items-center gap-2 pr-8">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div className="min-w-0">
            <SheetTitle className="truncate font-semibold">{businessName}</SheetTitle>
            <SheetDescription className="truncate text-muted-foreground text-xs">
              {me.name}
            </SheetDescription>
          </div>
        </div>
        <NavList big onNavigate={() => setOpen(false)} />
        <div className="mt-auto grid gap-1 border-t pt-3">
          <button type="button" onClick={theme.toggle} className={row}>
            {theme.dark ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
            {theme.dark ? "Tema claro" : "Tema oscuro"}
          </button>
          {me.hasPin ? (
            <button type="button" onClick={then(onLock)} className={row}>
              <LockIcon className="size-5" /> Bloquear pantalla
            </button>
          ) : null}
          <button type="button" onClick={then(onPin)} className={row}>
            <HashIcon className="size-5" /> {me.hasPin ? "Cambiar mi PIN" : "Poner un PIN"}
          </button>
          <button type="button" onClick={then(onChangePassword)} className={row}>
            <KeyRoundIcon className="size-5" /> Cambiar mi contraseña
          </button>
          <button type="button" onClick={then(onSessions)} className={row}>
            <MonitorSmartphoneIcon className="size-5" /> Mis sesiones
          </button>
          <button type="button" onClick={then(onSignOut)} className={row}>
            <LogOutIcon className="size-5" /> Salir
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Lo de la persona que usa el sistema, en un menú: tema, bloqueo, PIN, contraseña y sesiones. */
function UserMenu({ onSignOut, onChangePassword, onLock, onPin, onSessions }: AccountActions) {
  const me = useMe()
  const theme = useTheme()
  const row =
    "flex h-9 w-full cursor-pointer items-center gap-3 rounded-md px-3 text-sm hover:bg-accent hover:text-accent-foreground"
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="max-w-56 gap-2" title="Mi cuenta">
          <UserIcon />
          <span className="truncate">{me.name}</span>
          <ChevronDownIcon className="size-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <div className="px-3 py-2">
          <p className="truncate font-medium text-sm">{me.name}</p>
          <p className="truncate text-muted-foreground text-xs">@{me.username}</p>
        </div>
        <div className="grid gap-0.5 border-t pt-1">
          <PopoverClose asChild>
            <button type="button" onClick={theme.toggle} className={row}>
              {theme.dark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
              {theme.dark ? "Tema claro" : "Tema oscuro"}
            </button>
          </PopoverClose>
          <PopoverClose asChild>
            <button type="button" onClick={me.hasPin ? onLock : onPin} className={row}>
              <LockIcon className="size-4" />
              {me.hasPin ? "Bloquear pantalla" : "Poner un PIN para bloquear"}
            </button>
          </PopoverClose>
          {me.hasPin ? (
            <PopoverClose asChild>
              <button type="button" onClick={onPin} className={row}>
                <HashIcon className="size-4" /> Cambiar mi PIN
              </button>
            </PopoverClose>
          ) : null}
          <PopoverClose asChild>
            <button type="button" onClick={onChangePassword} className={row}>
              <KeyRoundIcon className="size-4" /> Cambiar mi contraseña
            </button>
          </PopoverClose>
          <PopoverClose asChild>
            <button type="button" onClick={onSessions} className={row}>
              <MonitorSmartphoneIcon className="size-4" /> Mis sesiones
            </button>
          </PopoverClose>
        </div>
        <div className="mt-1 border-t pt-1">
          <PopoverClose asChild>
            <button type="button" onClick={onSignOut} className={row}>
              <LogOutIcon className="size-4" /> Cerrar sesión
            </button>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function AppShell() {
  const me = useMe()
  const navigate = useNavigate()
  const { data: boot } = useQuery(bootstrapQuery)
  const businessName = boot?.business.name ?? "WINK POS"
  const [changingPassword, setChangingPassword] = useState(false)
  const [settingPin, setSettingPin] = useState(false)
  const [showingSessions, setShowingSessions] = useState(false)
  const lockedFor = useLock((s) => s.lockedFor)
  const lock = useLock((s) => s.lock)
  const unlock = useLock((s) => s.unlock)
  const locked = lockedFor === me.id && me.hasPin
  const idleMinutes = me.hasPin ? (boot?.security.autoLockMinutes ?? 0) : 0

  // Un bloqueo que quedó de otra persona, o de un PIN que ya no existe, no encierra a nadie.
  useEffect(() => {
    if (lockedFor && !locked) unlock()
  }, [lockedFor, locked, unlock])

  // Bloqueo por inactividad: tras N minutos sin tocar la pantalla (si hay PIN y está configurado).
  useEffect(() => {
    if (!idleMinutes || locked) return
    let timer = window.setTimeout(() => lock(me.id), idleMinutes * 60_000)
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => lock(me.id), idleMinutes * 60_000)
    }
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const
    for (const e of events) window.addEventListener(e, reset, { passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, reset)
    }
  }, [idleMinutes, locked, lock, me.id])

  const out = async () => {
    await signOut()
    await navigate({ to: "/entrar" })
  }

  // Con una contraseña temporal no se ve nada más hasta elegir la propia (el servidor también lo
  // exige: responde 403 a todo lo demás).
  if (me.mustChangePassword) return <ForcedPasswordChange />
  // Bloqueada: no se dibuja nada de la caja (ni sus atajos ni el lector de códigos).
  if (locked) return <LockScreen />

  const actions: AccountActions = {
    onSignOut: out,
    onChangePassword: () => setChangingPassword(true),
    onLock: () => lock(me.id),
    onPin: () => setSettingPin(true),
    onSessions: () => setShowingSessions(true),
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur print:hidden">
        <div className="flex h-14 items-center gap-2 px-2 sm:px-4 lg:gap-3">
          <MobileMenu businessName={businessName} {...actions} />
          <Link to="/" className="flex min-w-0 shrink items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="size-7 shrink-0" />
            <span className="truncate lg:max-w-64">{businessName}</span>
          </Link>
          <div className="ml-auto hidden shrink-0 items-center gap-2 lg:flex">
            <RateCalculator />
            <UserMenu {...actions} />
          </div>
        </div>
        <div className="border-t px-3 py-1.5 lg:hidden">
          <RateCalculator />
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-56 print:hidden shrink-0 flex-col gap-1 overflow-y-auto border-r bg-card p-3 lg:flex">
          <NavList />
          <button type="button" onClick={out} className={`${itemClass} w-full cursor-pointer`}>
            <LogOutIcon className="size-4" /> Cerrar sesión
          </button>
        </aside>
        <main className="min-w-0 flex-1 p-3 sm:p-4">
          <div className="mx-auto w-full max-w-[1500px]">
            <Outlet />
          </div>
        </main>
      </div>
      {changingPassword ? (
        <ChangePasswordDialog onClose={() => setChangingPassword(false)} />
      ) : null}
      {settingPin ? <PinDialog onClose={() => setSettingPin(false)} /> : null}
      {showingSessions ? <SessionsDialog onClose={() => setShowingSessions(false)} /> : null}
    </div>
  )
}
