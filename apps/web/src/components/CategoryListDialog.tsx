import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@millhiore/ui"
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, PlusIcon } from "lucide-react"
import { type ReactNode, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../lib/api"

interface Item {
  id: string
  name: string
  active: boolean
}

/**
 * Crea, renombra, ordena y desactiva una lista de categorías (de productos, de gastos…). Habla con
 * `basePath` (`POST basePath`, `PATCH basePath/{id}`) y avisa con `refresh` para recargar la lista.
 */
export function CategoryListDialog<T extends Item>({
  title,
  description,
  placeholder,
  basePath,
  items,
  loading,
  countText,
  refresh,
  onClose,
  canManage,
  createBody,
  addControl,
  itemTag,
}: {
  title: string
  description: string
  placeholder: string
  basePath: string
  items: T[]
  loading: boolean
  /** Cuánto tiene cada categoría («3 productos», «1 gasto»). */
  countText: (item: T) => string
  refresh: () => Promise<unknown>
  onClose: () => void
  canManage: boolean
  /** Lo que se envía al crear además del nombre (p. ej. el sentido de un motivo). */
  createBody?: (name: string) => Record<string, unknown>
  /** Un control extra junto al nombre al agregar (p. ej. entrada o salida). */
  addControl?: ReactNode
  /** Una etiqueta corta junto al nombre de cada elemento. */
  itemTag?: (item: T) => string | null
}) {
  const [name, setName] = useState("")
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    run(async () => {
      if (!name.trim()) return
      await api(basePath, { body: createBody ? createBody(name.trim()) : { name: name.trim() } })
      setName("")
    })

  const patch = (c: T, body: Record<string, unknown>) =>
    run(() => api(`${basePath}/${c.id}`, { method: "PATCH", body }))

  // Mover = intercambiar posiciones con la vecina; las posiciones se normalizan al índice.
  const move = (index: number, delta: -1 | 1) =>
    run(async () => {
      const target = items[index + delta]
      const current = items[index]
      if (!(target && current)) return
      const order = items.map((c) => c.id)
      order[index] = target.id
      order[index + delta] = current.id
      await Promise.all(
        order.map((id, i) =>
          api(`${basePath}/${id}`, { method: "PATCH", body: { position: i + 1 } }),
        ),
      )
    })

  const rename = () =>
    run(async () => {
      if (!renaming?.name.trim()) return
      await api(`${basePath}/${renaming.id}`, {
        method: "PATCH",
        body: { name: renaming.name.trim() },
      })
      setRenaming(null)
    })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {canManage ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={placeholder}
              aria-label="Nueva categoría"
              maxLength={60}
            />
            {addControl}
            <Button type="submit" disabled={busy || !name.trim()}>
              <PlusIcon /> Agregar
            </Button>
          </form>
        ) : null}

        <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {items.length === 0 ? (
            <li className="p-4 text-center text-muted-foreground text-sm">
              {loading ? "Cargando…" : "Todavía no hay categorías."}
            </li>
          ) : null}
          {items.map((c, i) => (
            <li
              key={c.id}
              className={`flex items-center gap-2 px-3 py-2 text-sm ${c.active ? "" : "opacity-60"}`}
            >
              {renaming?.id === c.id ? (
                <form
                  className="flex min-w-0 flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void rename()
                  }}
                >
                  <Input
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                    aria-label={`Nombre de ${c.name}`}
                    maxLength={60}
                  />
                  <Button type="submit" size="sm" disabled={busy}>
                    Guardar
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                    Cancelar
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {canManage ? (
                      <button
                        type="button"
                        className="cursor-pointer text-left underline-offset-4 hover:underline"
                        title="Cambiar el nombre"
                        onClick={() => setRenaming({ id: c.id, name: c.name })}
                      >
                        {c.name}
                      </button>
                    ) : (
                      c.name
                    )}
                    <span className="ml-2 font-normal text-muted-foreground text-xs">
                      {countText(c)}
                    </span>
                    {itemTag?.(c) ? (
                      <Badge variant="secondary" className="ml-2">
                        {itemTag(c)}
                      </Badge>
                    ) : null}
                    {c.active ? null : (
                      <Badge variant="outline" className="ml-2">
                        Inactiva
                      </Badge>
                    )}
                  </span>
                  {canManage ? (
                    <span className="flex shrink-0 gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Subir ${c.name}`}
                        disabled={busy || i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Bajar ${c.name}`}
                        disabled={busy || i === items.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={c.active ? `Desactivar ${c.name}` : `Activar ${c.name}`}
                        title={c.active ? "Desactivar" : "Activar"}
                        disabled={busy}
                        onClick={() => patch(c, { active: !c.active })}
                      >
                        {c.active ? <EyeIcon /> : <EyeOffIcon />}
                      </Button>
                    </span>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button onClick={onClose}>Listo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
