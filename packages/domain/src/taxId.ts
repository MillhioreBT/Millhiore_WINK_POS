/** "v12345678" → "V-12345678"; "j123456789" → "J-12345678-9" (formato del RIF). */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const letter = compact[0] ?? ""
  const digits = compact.slice(1)
  if (letter === "V" || letter === "E") return `${letter}-${digits}`
  // RIF jurídico: 8 dígitos + dígito verificador.
  return digits.length === 9
    ? `${letter}-${digits.slice(0, 8)}-${digits.slice(8)}`
    : `${letter}-${digits}`
}
