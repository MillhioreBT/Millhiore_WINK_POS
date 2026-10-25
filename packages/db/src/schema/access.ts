import type { Permission } from "@millhiore/domain"
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { branch } from "./core"

export const role = sqliteTable("role", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  permissions: text("permissions", { mode: "json" }).notNull().$type<Permission[]>(),
  /** Los roles de fábrica no se pueden borrar. */
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
})

// Tablas de Better Auth. Los nombres de propiedad (camelCase) son los que el adaptador espera;
// las columnas van en snake_case. `auth_account` evita chocar con la `account` financiera.

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  /** Campos propios del POS. */
  roleId: text("role_id").references(() => role.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** Tiene una contraseña temporal: al entrar debe elegir la suya antes de hacer nada más. */
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  /** PIN de caja (4–6 dígitos) con Argon2id: desbloquea la pantalla sin escribir la contraseña. */
  pinHash: text("pin_hash"),
})

/** Sucursales donde trabaja cada usuario: sin filas, en todas. */
export const userBranch = sqliteTable(
  "user_branch",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.branchId] })],
)

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user").on(t.userId)],
)

export const authAccount = sqliteTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("auth_account_user").on(t.userId)],
)

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("verification_identifier").on(t.identifier)],
)

/**
 * Clave de la API para otros sistemas (tienda en línea, contabilidad, un script): actúa como el
 * usuario que la creó, con los permisos que se le dieron (nunca más que los de ese usuario). Solo
 * se guarda el hash del secreto, que se muestra una vez al crearla.
 */
export const apiKey = sqliteTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** El comienzo del secreto («mwk_Ab12Cd34»), para reconocerla en la lista. */
    prefix: text("prefix").notNull(),
    /** SHA-256 del secreto, en hexadecimal. */
    secretHash: text("secret_hash").notNull().unique(),
    permissions: text("permissions", { mode: "json" }).notNull().$type<Permission[]>(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    /** Revocada: deja de funcionar para siempre. */
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("api_key_user").on(t.userId)],
)
