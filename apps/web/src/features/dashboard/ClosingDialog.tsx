import type { DaySummary } from "@millhiore/contracts"
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
import { useQuery } from "@tanstack/react-query"
import { CopyIcon, MessageCircleIcon } from "lucide-react"
import { useRef } from "react"
import { toast } from "sonner"
import { bootstrapQuery, payablesQuery, receivablesQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { closingText } from "./closingText"

/** El cierre del día como texto: se copia o se manda directo por WhatsApp. */
export function ClosingDialog({ summary, onClose }: { summary: DaySummary; onClose: () => void }) {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const sees = can(me, "payment.receive", "finance.view")
  const owed = useQuery({ ...receivablesQuery, enabled: sees })
  const seesPayables = can(me, "payable.manage", "finance.view")
  const owing = useQuery({ ...payablesQuery, enabled: seesPayables })
  const box = useRef<HTMLTextAreaElement>(null)
  const text = closingText(
    summary,
    { name: boot.data?.business.name ?? "Mi negocio" },
    sees ? (owed.data ?? null) : null,
    seesPayables ? (owing.data ?? null) : null,
  )

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
    toast.success("Cierre copiado")
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cierre del día</DialogTitle>
          <DialogDescription>
            Un resumen en texto para mandarlo por WhatsApp o guardarlo. Lo puedes editar antes de
            enviarlo.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          ref={box}
          defaultValue={text}
          key={text}
          rows={16}
          className="font-mono text-sm"
          aria-label="Texto del cierre del día"
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
