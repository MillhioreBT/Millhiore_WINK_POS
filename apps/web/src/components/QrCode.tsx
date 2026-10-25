import { useMemo } from "react"
import { qrPath } from "../lib/qr"

/** Un código QR (siempre negro sobre blanco, también en el tema oscuro, para que la cámara lo lea). */
export function QrCode({
  value,
  label,
  size = 176,
}: {
  value: string
  label: string
  size?: number
}) {
  const { path, size: dim } = useMemo(() => qrPath(value), [value])
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dim} ${dim}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md"
    >
      <title>{label}</title>
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
