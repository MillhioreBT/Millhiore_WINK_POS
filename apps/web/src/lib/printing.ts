import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "./api"
import { bootstrapQuery } from "./queries"

/**
 * Imprime el recibo de un documento según la impresora configurada: con la del navegador abre el
 * diálogo de impresión (el recibo debe estar en pantalla, con id="receipt"); con una térmica, se
 * lo pide al servidor, que la maneja por ESC/POS.
 */
export function usePrintDocument() {
  const { data: boot } = useQuery(bootstrapQuery)
  const [printing, setPrinting] = useState(false)
  const mode = boot?.printer.mode ?? "browser"

  const print = async (documentId: string, opts: { openDrawer?: boolean } = {}) => {
    if (mode === "browser") {
      window.print()
      return
    }
    setPrinting(true)
    try {
      await api(`/api/print/documents/${documentId}`, {
        body: { openDrawer: opts.openDrawer ?? false },
      })
    } catch (e) {
      toast.error(`No se pudo imprimir: ${errorMessage(e)}`)
    } finally {
      setPrinting(false)
    }
  }
  return { print, printing, mode, autoPrint: boot?.printer.autoPrint ?? false }
}

export async function openDrawer(): Promise<void> {
  try {
    await api("/api/print/drawer", { body: {} })
  } catch (e) {
    toast.error(`No se pudo abrir la gaveta: ${errorMessage(e)}`)
  }
}
