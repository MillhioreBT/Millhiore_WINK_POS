/** "0414-1234567" → "584141234567" (el formato que pide wa.me); null si no parece un teléfono. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, "")
  if (digits.length < 10) return null
  if (digits.startsWith("58")) return digits
  return `58${digits.replace(/^0+/, "")}`
}
