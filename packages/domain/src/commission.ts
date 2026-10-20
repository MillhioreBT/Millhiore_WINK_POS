/**
 * Lo que el banco o el punto de venta descuenta de un cobro: `bp` puntos básicos del monto
 * (250 = 2,5 %), redondeado al entero más cercano con la mitad hacia arriba. Sin monto positivo o
 * sin comisión, 0. Usa enteros grandes: un monto enorme por un porcentaje no pierde precisión.
 */
export function commissionMinor(amountMinor: number, bp: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return 0
  if (!Number.isInteger(bp) || bp <= 0) return 0
  return Number((BigInt(amountMinor) * BigInt(bp) + 5000n) / 10000n)
}
