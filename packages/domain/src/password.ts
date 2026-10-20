// Reglas de contraseñas. Las aplica el servidor (siempre) y la web (para avisar al escribir).

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

/** Las que más se prueban primero. En minúsculas y sin acentos. */
const COMMON = new Set([
  "12345678",
  "123456789",
  "1234567890",
  "87654321",
  "11111111",
  "00000000",
  "12341234",
  "abc12345",
  "abcd1234",
  "password",
  "password1",
  "contrasena",
  "contrasena1",
  "qwertyui",
  "qwerty123",
  "asdfghjk",
  "iloveyou",
  "venezuela",
  "caracas1",
  "bodega123",
  "millhiore",
  "admin123",
  "administrador",
  "cajero123",
])

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]/g, "")

/**
 * Por qué una contraseña no sirve, o null si está bien. `context` aporta lo que no debe contener:
 * el usuario, su nombre y el del negocio.
 */
export function passwordProblem(
  password: string,
  context: { username?: string | null; name?: string | null; businessName?: string | null } = {},
): string | null {
  if (password.length < PASSWORD_MIN) return `Debe tener al menos ${PASSWORD_MIN} caracteres`
  if (password.length > PASSWORD_MAX) return `Debe tener como máximo ${PASSWORD_MAX} caracteres`
  const p = plain(password)
  if (new Set(password).size <= 2) return "Usa una contraseña más variada"
  if (COMMON.has(p) || /^(\d)\1+$/.test(p) || "0123456789012345678901".includes(p)) {
    return "Es demasiado común: elige otra"
  }
  for (const word of [context.username, context.name, context.businessName]) {
    const w = plain(word ?? "")
    if (w.length >= 3 && p.includes(w)) return "No uses tu usuario, tu nombre ni el del negocio"
  }
  return null
}

/** Contraseña temporal fácil de dictar: sin letras que se confunden (0/O, 1/l/I). */
export function temporaryPassword(random: (n: number) => number = secureRandom): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  const block = () => Array.from({ length: 4 }, () => alphabet[random(alphabet.length)]).join("")
  return `${block()}-${block()}-${block()}`
}

function secureRandom(n: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return (buf[0] ?? 0) % n
}
