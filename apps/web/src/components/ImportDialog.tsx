import type { ImportResult } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@millhiore/ui"
import { DownloadIcon, FileSpreadsheetIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../lib/api"
import { queryClient } from "../lib/queries"
import { mapColumns, readSpreadsheet, type SheetCell } from "../lib/sheetReader"
import { bold, downloadXlsx } from "../lib/xlsx"

export interface ImportField {
  key: string
  label: string
  /** Cómo se puede llamar la columna (además de su etiqueta). */
  synonyms: readonly string[]
  required?: boolean
  /** Ancho en la plantilla. */
  width: number
}

export interface ImportConfig {
  title: string
  description: string
  endpoint: string
  /** Nombre del archivo de la plantilla y de su hoja. */
  template: { file: string; sheet: string; examples: SheetCell[][] }
  fields: readonly ImportField[]
  /** Qué se recarga al terminar. */
  invalidate: readonly string[]
  /** Qué significa «ya existe» (para la casilla de actualizar). */
  existingHint: string
}

type Parsed = {
  fileName: string
  rows: { row: number; values: Record<string, SheetCell> }[]
  found: string[]
  unknown: string[]
}

const STATUS: Record<
  ImportResult["rows"][number]["status"],
  { label: string; variant: "success" | "secondary" | "outline" | "destructive" }
> = {
  create: { label: "Nuevo", variant: "success" },
  update: { label: "Se actualiza", variant: "secondary" },
  skip: { label: "Se omite", variant: "outline" },
  error: { label: "Error", variant: "destructive" },
}

/**
 * Importa filas de un Excel (.xlsx) o un CSV: reconoce las columnas por su nombre, muestra fila por
 * fila qué se va a hacer y los errores, y solo entonces importa las filas válidas.
 */
export function ImportDialog({ config, onClose }: { config: ImportConfig; onClose: () => void }) {
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [updateExisting, setUpdateExisting] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [busy, setBusy] = useState(false)

  const synonyms = Object.fromEntries(
    config.fields.map((f) => [f.key, [f.label, ...f.synonyms]]),
  ) as Record<string, readonly string[]>
  const missing = parsed
    ? config.fields.filter((f) => f.required && !parsed.found.includes(f.key))
    : []

  const run = async (data: Parsed, apply: boolean, update = updateExisting) => {
    setBusy(true)
    try {
      const result = await api<ImportResult>(config.endpoint, {
        body: { rows: data.rows, apply, updateExisting: update },
      })
      if (apply) {
        await Promise.all(
          config.invalidate.map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
        )
        toast.success(
          [
            result.created ? `${result.created} nuevos` : null,
            result.updated ? `${result.updated} actualizados` : null,
            result.stockDocumentNumber ? `existencia en ${result.stockDocumentNumber}` : null,
            result.debts
              ? `${result.debts} saldo${result.debts === 1 ? "" : "s"} anotado${result.debts === 1 ? "" : "s"}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Nada que importar",
        )
        onClose()
      } else {
        setPreview(result)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    setPreview(null)
    try {
      const sheet = await readSpreadsheet(file)
      const [header = [], ...body] = sheet
      const { columns, unknown } = mapColumns(header, synonyms)
      const found = Object.keys(columns)
      const rows = body.map((cells, i) => ({
        row: i + 2,
        values: Object.fromEntries(
          Object.entries(columns).map(([k, index]) => [k, cells[index as number] ?? null]),
        ),
      }))
      const data = { fileName: file.name, rows, found, unknown }
      setParsed(data)
      const required = config.fields.filter((f) => f.required && !found.includes(f.key))
      if (!rows.length) toast.error("El archivo no tiene filas debajo de los encabezados")
      else if (!required.length) await run(data, false)
    } catch (e) {
      setParsed(null)
      toast.error(errorMessage(e))
    }
  }

  const downloadTemplate = () =>
    downloadXlsx(config.template.file, [
      {
        name: config.template.sheet,
        widths: config.fields.map((f) => f.width),
        rows: [config.fields.map((f) => bold(f.label)), ...config.template.examples],
      },
    ])

  const shown = (preview?.rows ?? []).filter(
    (r) => !onlyProblems || r.status === "error" || r.status === "skip",
  )
  const toImport = (preview?.created ?? 0) + (preview?.updated ?? 0)

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <label className="cursor-pointer">
              <FileSpreadsheetIcon />
              {parsed ? "Elegir otro archivo" : "Elegir archivo (.xlsx o .csv)"}
              <input
                type="file"
                accept=".xlsx,.csv,.txt"
                className="sr-only"
                aria-label="Archivo a importar"
                onChange={(e) => {
                  void pick(e.target.files?.[0])
                  e.target.value = ""
                }}
              />
            </label>
          </Button>
          <Button variant="ghost" onClick={() => void downloadTemplate()}>
            <DownloadIcon /> Descargar plantilla
          </Button>
        </div>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={updateExisting}
            onChange={(e) => {
              setUpdateExisting(e.target.checked)
              if (parsed && !missing.length) void run(parsed, false, e.target.checked)
            }}
          />
          <span>
            Actualizar los que ya existen
            <span className="block text-muted-foreground text-xs">{config.existingHint}</span>
          </span>
        </label>

        {parsed ? (
          <div className="grid gap-1.5 text-sm">
            <p>
              <span className="font-medium">{parsed.fileName}</span> ·{" "}
              {parsed.rows.length === 1 ? "1 fila" : `${parsed.rows.length} filas`}
            </p>
            <div className="flex flex-wrap gap-1">
              {config.fields
                .filter((f) => parsed.found.includes(f.key))
                .map((f) => (
                  <Badge key={f.key} variant="secondary">
                    {f.label}
                  </Badge>
                ))}
            </div>
            {parsed.unknown.length ? (
              <p className="text-muted-foreground text-xs">
                Se ignoran las columnas: {parsed.unknown.join(", ")}
              </p>
            ) : null}
            {missing.length ? (
              <p className="text-destructive">
                Falta la columna {missing.map((f) => `«${f.label}»`).join(" y ")}. Usa la plantilla
                para ver cómo se llaman.
              </p>
            ) : null}
          </div>
        ) : null}

        {preview ? (
          <div className="grid gap-2">
            <p className="text-sm">
              <span className="font-medium">
                {[
                  preview.created ? `${preview.created} nuevos` : null,
                  preview.updated ? `${preview.updated} se actualizan` : null,
                  preview.skipped ? `${preview.skipped} se omiten` : null,
                  preview.errors ? `${preview.errors} con errores` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Nada que importar"}
              </span>
              {preview.debts ? (
                <span className="block text-muted-foreground text-xs">
                  Se anota el saldo pendiente de {preview.debts} contacto
                  {preview.debts === 1 ? "" : "s"}
                </span>
              ) : null}
              {preview.newCategories.length ? (
                <span className="block text-muted-foreground text-xs">
                  Categorías nuevas: {preview.newCategories.join(", ")}
                </span>
              ) : null}
            </p>
            {preview.errors || preview.skipped ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={onlyProblems}
                  onChange={(e) => setOnlyProblems(e.target.checked)}
                />
                Ver solo las filas con avisos
              </label>
            ) : null}
            <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-sm">
              {shown.slice(0, 500).map((r) => (
                <li
                  key={r.row}
                  className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 px-3 py-1.5"
                >
                  <span className="tabular text-muted-foreground text-xs">{r.row}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{r.name}</span>
                    {r.messages.map((m) => (
                      <span
                        key={m}
                        className={`block text-xs ${r.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {m}
                      </span>
                    ))}
                  </span>
                  <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={() => parsed && run(parsed, true)}
            disabled={busy || !preview || toImport === 0 || missing.length > 0}
          >
            {busy
              ? "Revisando…"
              : toImport === 1
                ? "Importar 1 fila"
                : `Importar ${toImport} filas`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
