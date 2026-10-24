import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@millhiore/ui"
import { CopyIcon, MessageCircleIcon } from "lucide-react"
import { useRef } from "react"
import { toast } from "sonner"

/** Un texto (un cierre, un resumen) que se edita, se copia o se manda directo por WhatsApp. */
export function ShareTextDialog({
  title,
  description,
  text,
  copied = "Texto copiado",
  onClose,
}: {
  title: string
  description: string
  text: string
  /** Lo que avisa al copiar. */
  copied?: string
  onClose: () => void
}) {
  const box = useRef<HTMLTextAreaElement>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(box.current?.value ?? text)
    } catch {
      // Sin HTTPS (celular por la red local) el portapapeles no está disponible: se copia a mano.
      box.current?.select()
      if (!document.execCommand("copy")) {
        toast.error("No se pudo copiar. Mantén presionado el texto y elige «Copiar».")
        return
      }
    }
    toast.success(copied)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          ref={box}
          defaultValue={text}
          key={text}
          rows={16}
          className="font-mono text-sm"
          aria-label={`Texto: ${title}`}
          onFocus={(e) => e.currentTarget.select()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <Button variant="outline" onClick={copy}>
            <CopyIcon /> Copiar
          </Button>
          <Button
            variant="success"
            onClick={() => {
              const current = box.current?.value ?? text
              window.open(
                `https://wa.me/?text=${encodeURIComponent(current)}`,
                "_blank",
                "noopener",
              )
            }}
          >
            <MessageCircleIcon /> Enviar por WhatsApp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
