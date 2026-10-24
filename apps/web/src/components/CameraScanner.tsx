import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@millhiore/ui"
import { CameraIcon, ScanBarcodeIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { liveCameraAvailable, readCode } from "../lib/scanner"

/** Botón con el ícono de escanear que abre la cámara. */
export function ScanButton({
  onCode,
  continuous = false,
  label = "Escanear con la cámara",
  className,
}: {
  onCode: (code: string) => void
  /** Seguir leyendo después de cada código (un conteo): se cierra a mano. */
  continuous?: boolean
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={cn("shrink-0", className)}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <ScanBarcodeIcon />
      </Button>
      {open ? (
        <CameraScanner
          continuous={continuous}
          onCode={(code) => {
            onCode(code)
            if (!continuous) setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

/** Una vibración corta al leer un código (en los celulares que la tienen). */
function buzz() {
  try {
    navigator.vibrate?.(60)
  } catch {
    // Sin vibración: no pasa nada.
  }
}

/**
 * Lee códigos de barras con la cámara. En vivo si el navegador lo permite (HTTPS o la PC del
 * servidor); si no, con una foto del código, que funciona también por la red local con http://.
 */
export function CameraScanner({
  onCode,
  onClose,
  continuous = false,
}: {
  onCode: (code: string) => void
  onClose: () => void
  continuous?: boolean
}) {
  const live = liveCameraAvailable()
  const video = useRef<HTMLVideoElement>(null)
  const photo = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<"starting" | "scanning" | "denied" | "photo">(
    live ? "starting" : "photo",
  )
  const [last, setLast] = useState<string | null>(null)
  // El último código y cuándo se leyó: el mismo código frente a la cámara no cuenta dos veces seguidas.
  const seen = useRef({ code: "", at: 0 })
  const onCodeRef = useRef(onCode)
  onCodeRef.current = onCode

  useEffect(() => {
    if (!live) return
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const loop = async () => {
      if (stopped) return
      const v = video.current
      if (v && v.readyState >= 2) {
        try {
          const code = await readCode(v)
          const now = Date.now()
          if (code && (code !== seen.current.code || now - seen.current.at > 2000)) {
            seen.current = { code, at: now }
            buzz()
            setLast(code)
            onCodeRef.current(code)
          } else if (code) {
            seen.current.at = now
          }
        } catch {
          // Un cuadro que no se pudo leer: se prueba con el siguiente.
        }
      }
      timer = setTimeout(loop, 250)
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(async (s) => {
        if (stopped) {
          for (const t of s.getTracks()) t.stop()
          return
        }
        stream = s
        if (video.current) {
          video.current.srcObject = s
          await video.current.play().catch(() => undefined)
        }
        setStatus("scanning")
        void loop()
      })
      .catch(() => setStatus("denied"))
    return () => {
      stopped = true
      clearTimeout(timer)
      for (const t of stream?.getTracks() ?? []) t.stop()
    }
  }, [live])

  const fromPhoto = async (file: File | undefined) => {
    if (!file) return
    try {
      const bitmap = await createImageBitmap(file)
      const code = await readCode(bitmap)
      bitmap.close()
      if (!code) {
        toast.error("No se encontró un código en la foto: acércate y que se vea nítido")
        return
      }
      buzz()
      setLast(code)
      onCode(code)
    } catch {
      toast.error("No se pudo leer la foto")
    } finally {
      if (photo.current) photo.current.value = ""
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Escanear código</DialogTitle>
          <DialogDescription>
            {status === "photo"
              ? "Toma una foto del código de barras, de cerca y sin reflejos."
              : status === "denied"
                ? "No se pudo abrir la cámara (permiso negado o en uso). Puedes tomar una foto del código."
                : "Apunta la cámara al código de barras."}
          </DialogDescription>
        </DialogHeader>
        {live && status !== "denied" ? (
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video
              ref={video}
              className="aspect-[4/3] w-full object-cover"
              muted
              playsInline
              aria-label="Imagen de la cámara"
            />
            <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
            {status === "starting" ? (
              <p className="absolute inset-0 grid place-items-center text-sm text-white">
                Abriendo la cámara…
              </p>
            ) : null}
          </div>
        ) : null}
        <input
          ref={photo}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          aria-label="Foto del código de barras"
          onChange={(e) => void fromPhoto(e.target.files?.[0])}
        />
        {status === "photo" || status === "denied" ? (
          <Button size="lg" onClick={() => photo.current?.click()}>
            <CameraIcon /> Tomar foto del código
          </Button>
        ) : null}
        {last ? (
          <p className="text-center text-muted-foreground text-sm">
            Último código: <span className="tabular font-medium text-foreground">{last}</span>
          </p>
        ) : null}
        {status === "photo" ? (
          <p className="text-muted-foreground text-xs">
            Para escanear en vivo, la app tiene que abrirse con HTTPS o en la PC del servidor.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {continuous ? "Listo" : "Cancelar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
