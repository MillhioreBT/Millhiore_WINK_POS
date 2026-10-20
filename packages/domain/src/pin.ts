/** Largo permitido del PIN de caja: entre 4 y 6 dígitos. */
export const PIN_MIN = 4
export const PIN_MAX = 6

/**
 * Reglas del PIN de caja (el que desbloquea la pantalla). Un PIN es corto por naturaleza, así
 * que al menos se descartan los que cualquiera prueba primero: dígitos repetidos (0000) y
 * secuencias (1234, 4321). Devuelve el problema en español, o null si sirve.
 */
export function pinProblem(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return "El PIN solo lleva números"
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) {
    return `El PIN debe tener entre ${PIN_MIN} y ${PIN_MAX} dígitos`
  }
  const digits = [...pin].map(Number)
  if (digits.every((d) => d === digits[0])) return "Elige un PIN que no repita el mismo número"
  const step = (digits[1] ?? 0) - (digits[0] ?? 0)
  if (
    (step === 1 || step === -1) &&
    digits.every((d, i) => i === 0 || d - (digits[i - 1] ?? 0) === step)
  ) {
    return "Elige un PIN que no sea una secuencia (1234, 4321)"
  }
  return null
}
