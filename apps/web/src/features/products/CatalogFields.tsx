import { Button, Label, Textarea } from "@millhiore/ui"
import { ImageIcon, Trash2Icon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "../../lib/api"
import { shrinkImage } from "../../lib/images"

/** Qué pasa con la foto al guardar: sigue la que tiene, se pone una nueva o se quita. */
export type PhotoChange = { kind: "keep" } | { kind: "set"; blob: Blob } | { kind: "remove" }

/** Sube o quita la foto después de guardar el producto. */
export async function savePhoto(productId: string, change: PhotoChange): Promise<void> {
  if (change.kind === "set") {
    await api(`/api/products/${productId}/image`, { method: "PUT", body: change.blob })
  } else if (change.kind === "remove") {
    await api(`/api/products/${productId}/image`, { method: "DELETE" })
  }
}

/** Foto, descripción y si sale en el catálogo en línea (solo con el catálogo encendido). */
export function CatalogFields({
  productId,
  imageVersion,
  photo,
  onPhoto,
  description,
  onDescription,
  inCatalog,
  onInCatalog,
}: {
  productId: string | null
  imageVersion: number | null
  photo: PhotoChange
  onPhoto: (change: PhotoChange) => void
  description: string
  onDescription: (text: string) => void
  inCatalog: boolean
  onInCatalog: (on: boolean) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  // La vista previa de la foto nueva vive mientras no se cambie otra vez.
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (photo.kind !== "set") return setPreview(null)
    const url = URL.createObjectURL(photo.blob)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])
  const src =
    photo.kind === "set"
      ? preview
      : photo.kind === "keep" && productId && imageVersion
        ? `/api/products/${productId}/image?v=${imageVersion}`
        : null

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      onPhoto({ kind: "set", blob: await shrinkImage(file) })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ""
    }
  }

  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-3">
      <legend className="px-1 text-muted-foreground text-sm">Catálogo en línea</legend>
      <div className="flex items-center gap-3">
        {src ? (
          <img
            src={src}
            alt="Foto del producto"
            className="size-20 shrink-0 rounded-lg border bg-muted object-cover"
          />
        ) : (
          <div className="grid size-20 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
            <ImageIcon className="size-6" />
          </div>
        )}
        <div className="grid min-w-0 gap-1.5">
          <input
            ref={input}
            id="p-photo"
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <ImageIcon /> {busy ? "Preparando…" : src ? "Cambiar foto" : "Poner foto"}
          </Button>
          {src ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onPhoto({ kind: "remove" })}
            >
              <Trash2Icon /> Quitar foto
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="p-description">Descripción</Label>
        <Textarea
          id="p-description"
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Opcional: de qué es, cuánto trae, sabores…"
        />
      </div>
      <div className="flex items-center gap-3">
        <input
          id="p-in-catalog"
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          checked={inCatalog}
          onChange={(e) => onInCatalog(e.target.checked)}
        />
        <Label htmlFor="p-in-catalog">Mostrar en el catálogo en línea</Label>
      </div>
    </fieldset>
  )
}
