import type { Contact } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PencilIcon, PlusIcon, SearchIcon } from "lucide-react"
import { useState } from "react"
import { contactsQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { ContactDialog } from "./ContactDialog"

const KIND: Record<Contact["kind"], string> = {
  customer: "Cliente",
  supplier: "Proveedor",
  both: "Cliente y proveedor",
}

export function ContactsPage() {
  const me = useMe()
  const [kind, setKind] = useState<"" | "customer" | "supplier">("")
  const [search, setSearch] = useState("")
  const contacts = useQuery(
    contactsQuery({
      all: true,
      ...(kind ? { kind } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    }),
  )
  const [editing, setEditing] = useState<Contact | null | undefined>(undefined)
  const canEdit = can(me, "contact.manage")

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Clientes y proveedores</h1>
        <div className="relative ml-auto w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nombre, cédula, RIF o teléfono"
            className="pl-9"
            aria-label="Buscar contactos"
          />
        </div>
        <NativeSelect
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="w-40"
          aria-label="Tipo"
        >
          <option value="">Todos</option>
          <option value="customer">Clientes</option>
          <option value="supplier">Proveedores</option>
        </NativeSelect>
        <Button onClick={() => setEditing(null)}>
          <PlusIcon /> Nuevo
        </Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead className="hidden sm:table-cell">Cédula / RIF</TableHead>
              <TableHead className="hidden md:table-cell">Teléfono</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(contacts.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {contacts.isLoading ? "Cargando…" : "No hay contactos que mostrar."}
                </TableCell>
              </TableRow>
            ) : null}
            {(contacts.data ?? []).map((c) => (
              <TableRow key={c.id} className={c.active ? "" : "opacity-60"}>
                <TableCell className="whitespace-normal font-medium">
                  {c.name}
                  {c.active ? null : (
                    <Badge variant="outline" className="ml-2">
                      Inactivo
                    </Badge>
                  )}
                  <span className="block font-normal text-muted-foreground text-xs sm:hidden">
                    {[c.taxId, c.phone].filter(Boolean).join(" · ")}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{c.taxId ?? "—"}</TableCell>
                <TableCell className="hidden md:table-cell">{c.phone ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{KIND[c.kind]}</Badge>
                </TableCell>
                <TableCell>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Editar"
                      title="Editar"
                      onClick={() => setEditing(c)}
                    >
                      <PencilIcon /> <span className="hidden sm:inline">Editar</span>
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {editing !== undefined ? (
        <ContactDialog
          key={editing?.id ?? "new"}
          contact={editing}
          defaultKind={kind || "customer"}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  )
}
