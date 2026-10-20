import { authAccount, type Db, session, user, verification } from "@millhiore/db"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { username } from "better-auth/plugins"

export interface AuthOptions {
  secret: string
  /** URL pública del servidor, p. ej. http://localhost:3000 */
  baseURL: string
  trustedOrigins?: string[]
  /** Límite de intentos de login. Se apaga en pruebas. */
  rateLimit?: boolean
}

/** Los usuarios del POS entran con usuario y contraseña; Better Auth exige un correo, así que se sintetiza. */
export function syntheticEmail(username: string): string {
  return `${username}@usuarios.millhiore.local`
}

/** Argon2id con Bun: lo usan Better Auth y los cambios de contraseña propios. */
export const hashPassword = (password: string) =>
  Bun.password.hash(password, { algorithm: "argon2id" })
export const verifyPassword = (password: string, hash: string) =>
  Bun.password.verify(password, hash)

/**
 * Rutas de Better Auth que se exponen. El resto (cambiar contraseña o correo, borrar cuenta…) se
 * hace por la API propia, que aplica las reglas de contraseñas, los permisos y la auditoría.
 */
export const PUBLIC_AUTH_PATHS = [
  "/api/auth/sign-in/username",
  "/api/auth/sign-out",
  "/api/auth/get-session",
]

/**
 * Better Auth sobre la misma base SQLite. Contraseñas con Argon2id (Bun). El registro público
 * está cerrado: los usuarios solo los crea el servidor (asistente inicial o administrador).
 */
export function createAuth(db: Db, opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    ...(opts.trustedOrigins ? { trustedOrigins: opts.trustedOrigins } : {}),
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, auth_account: authAccount, verification },
    }),
    account: { modelName: "auth_account" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: false,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    user: {
      additionalFields: {
        roleId: { type: "string", required: false, input: false },
        active: { type: "boolean", required: false, defaultValue: true, input: false },
        mustChangePassword: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30 },
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 30 })],
    rateLimit: {
      enabled: opts.rateLimit ?? true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/username": { window: 60, max: 5 } },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
