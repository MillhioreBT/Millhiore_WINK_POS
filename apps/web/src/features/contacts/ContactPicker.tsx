import type { Contact } from "@millhiore/contracts"
import { Button, Input } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PlusIcon, UserIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { contactsQuery } from "../../lib/queries"
import { ContactDialog } from "./ContactDialog"

/** Busca un cliente o proveedor por nombre, cédula/RIF o teléfono, o lo registra al vuelo. */
export function ContactPicker({
  kind,
  value,
  onChange,
  placeholder,
}: {
  kind: "customer" | "supplier"
  value: Contact | null
  onChange: (c: Contact | null) => void
  placeholder: string
}) {
  const [search, setSearch] = useState("")
  const [creating, setCreating] = useState(false)
  const term = search.trim()
  const results = useQuery({ ...contactsQuery({ kind, search: term }), enabled: term.length >= 2 })

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
        <UserIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">{value.name}</span>
        {value.taxId ? <span className="text-muted-foreground">{value.taxId}</span> : null}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={() => onChange(null)}
          aria-label="Quitar"
        >
          <XIcon />
        </Button>
      </div>
    )
  }

  return (
    <div className="relative grid gap-1">
      <div className="flex gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <Button variant="outline" onClick={() => setCreating(true)} title="Registrar nuevo">
          <PlusIcon /> Nuevo
        </Button>
      </div>
      {term.length >= 2 ? (
        <ul className="absolute top-11 z-10 max-h-56 w-full divide-y overflow-y-auto rounded-md border bg-popover shadow-lg">
          {(results.data ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onChange(c)
                  setSearch("")
                }}
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground">{c.taxId ?? c.phone ?? ""}</span>
              </button>
            </li>
          ))}
          {results.data?.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground text-sm">
              No hay coincidencias.{" "}
              <button
                type="button"
                className="cursor-pointer text-primary underline"
                onClick={() => setCreating(true)}
              >
                Registrar “{term}”
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {creating ? (
        <ContactDialog
          contact={null}
          defaultKind={kind}
          initialName={/\d/.test(term) ? "" : term}
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            onChange(c)
            setSearch("")
          }}
        />
      ) : null}
    </div>
  )
}
