import { type Barcode, QUIET_ZONE } from "../lib/barcode"

/**
 * Dibuja un código de barras que ocupa todo el ancho y el alto de su caja, con el margen en
 * blanco a los lados que necesita el lector. Las barras se estiran: lo que importa es la
 * proporción entre ellas.
 */
export function BarcodeSvg({ code, className }: { code: Barcode; className?: string }) {
  const bars: { x: number; width: number }[] = []
  for (let i = 0; i < code.modules.length; i++) {
    if (code.modules[i] !== "1") continue
    const last = bars.at(-1)
    if (last && last.x + last.width === i) last.width++
    else bars.push({ x: i, width: 1 })
  }
  const total = code.modules.length + QUIET_ZONE * 2
  return (
    <svg
      viewBox={`0 0 ${total} 100`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={`Código de barras ${code.text}`}
    >
      {bars.map((b) => (
        <rect key={b.x} x={b.x + QUIET_ZONE} y={0} width={b.width} height={100} fill="#000" />
      ))}
    </svg>
  )
}
