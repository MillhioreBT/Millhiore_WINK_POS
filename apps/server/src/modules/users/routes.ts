import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  changePasswordSchema,
  createUserSchema,
  meSchema,
  resetPasswordSchema,
  sessionRowSchema,
  setPinSchema,
  updateUserSchema,
  userRowSchema,
  verifyPinSchema,
} from "@millhiore/contracts"
import { role } from "@millhiore/db"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { setOwnPin, verifyOwnPin } from "./pin"
import {
  changeOwnPassword,
  createUserAccount,
  listUsers,
  resetUserPassword,
  updateUser,
} from "./service"
import { listSessions, revokeOtherSessions, revokeSession } from "./sessions"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const ok = { 200: { description: "Hecho", content: json(z.object({ ok: z.literal(true) })) } }
const idParam = z.object({ id: z.string().min(1) })

const meRoute = createRoute({
  method: "get",
  path: "/api/me",
  tags: ["Usuarios"],
  summary: "Usuario de la sesión y sus permisos",
  responses: {
    200: { description: "Usuario", content: json(meSchema) },
    401: { description: "Sin sesión", ...err },
  },
})

const changeOwnRoute = createRoute({
  method: "post",
  path: "/api/me/password",
  tags: ["Usuarios"],
  summary: "Cambia la propia contraseña (pide la actual)",
  description:
    "Mantiene abierta la sesión desde la que se pide y, por defecto, cierra las de los demás equipos. Cinco intentos fallidos bloquean el cambio 15 minutos.",
  request: { body: { content: json(changePasswordSchema), required: true } },
  responses: {
    ...ok,
    422: { description: "Contraseña actual incorrecta o nueva débil", ...err },
    429: { description: "Demasiados intentos", ...err },
  },
})

const setPinRoute = createRoute({
  method: "put",
  path: "/api/me/pin",
  tags: ["Usuarios"],
  summary: "Pone, cambia o quita el PIN de caja propio (pide la contraseña)",
  description:
    "El PIN (4 a 6 dígitos) sirve para desbloquear la pantalla; no abre sesión. Se guarda con Argon2id. Enviar `pin: null` lo quita.",
  request: { body: { content: json(setPinSchema), required: true } },
  responses: {
    ...ok,
    422: { description: "Contraseña incorrecta o PIN débil", ...err },
    429: { description: "Demasiados intentos", ...err },
  },
})

const verifyPinRoute = createRoute({
  method: "post",
  path: "/api/me/pin/verify",
  tags: ["Usuarios"],
  summary: "Comprueba el PIN propio (desbloquear la pantalla)",
  description: "Cinco intentos fallidos bloquean la comprobación 5 minutos.",
  request: { body: { content: json(verifyPinSchema), required: true } },
  responses: {
    ...ok,
    401: { description: "PIN incorrecto", ...err },
    409: { description: "No tiene PIN", ...err },
    429: { description: "Demasiados intentos", ...err },
  },
})

const rolesRoute = createRoute({
  method: "get",
  path: "/api/roles",
  tags: ["Usuarios"],
  summary: "Roles disponibles",
  responses: {
    200: {
      description: "Roles",
      content: json(
        z.array(z.object({ id: z.string(), name: z.string(), permissions: z.array(z.string()) })),
      ),
    },
    403: { description: "Falta user.manage", ...err },
  },
})

const listRoute = createRoute({
  method: "get",
  path: "/api/users",
  tags: ["Usuarios"],
  summary: "Lista de usuarios",
  responses: {
    200: { description: "Usuarios", content: json(z.array(userRowSchema)) },
    403: { description: "Falta user.manage", ...err },
  },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/users",
  tags: ["Usuarios"],
  summary: "Crea un usuario",
  request: { body: { content: json(createUserSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(z.object({ id: z.string() })) },
    403: { description: "Falta user.manage", ...err },
    409: { description: "El usuario ya existe", ...err },
    422: { description: "Datos inválidos o contraseña débil", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/users/{id}",
  tags: ["Usuarios"],
  summary: "Cambia nombre, rol o estado de un usuario",
  description: "Nunca deja el negocio sin un dueño activo; a un dueño solo lo modifica otro dueño.",
  request: { params: idParam, body: { content: json(updateUserSchema), required: true } },
  responses: {
    200: { description: "Guardado", content: json(userRowSchema) },
    403: { description: "Sin permiso", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Dejaría el negocio sin dueño, o es la propia cuenta", ...err },
  },
})

const resetRoute = createRoute({
  method: "post",
  path: "/api/users/{id}/password",
  tags: ["Usuarios"],
  summary: "Restablece la contraseña de otro usuario con una temporal",
  description:
    "Cierra todas las sesiones de esa persona; al entrar con la temporal debe elegir la suya antes de hacer nada más.",
  request: { params: idParam, body: { content: json(resetPasswordSchema), required: true } },
  responses: {
    ...ok,
    403: { description: "Sin permiso, o es un dueño y quien pide no lo es", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Es la propia cuenta", ...err },
    422: { description: "Contraseña débil", ...err },
  },
})

const sessionsRoute = createRoute({
  method: "get",
  path: "/api/sessions",
  tags: ["Usuarios"],
  summary: "Sesiones abiertas (las propias, o las de todos con all=true)",
  description:
    "Cada equipo donde se entró y no se salió. Ver las de todos exige user.manage; el token nunca se devuelve.",
  request: { query: z.object({ all: z.enum(["true", "false"]).default("false") }) },
  responses: {
    200: { description: "Sesiones", content: json(z.array(sessionRowSchema)) },
    403: { description: "Falta user.manage", ...err },
  },
})

const closeOthersRoute = createRoute({
  method: "post",
  path: "/api/sessions/close-others",
  tags: ["Usuarios"],
  summary: "Cierra las demás sesiones propias",
  responses: {
    200: { description: "Cerradas", content: json(z.object({ closed: z.number().int() })) },
  },
})

const revokeSessionRoute = createRoute({
  method: "delete",
  path: "/api/sessions/{id}",
  tags: ["Usuarios"],
  summary: "Cierra una sesión",
  description:
    "La propia con su dueño; cualquiera con user.manage. La sesión actual no se cierra aquí.",
  request: { params: idParam },
  responses: {
    ...ok,
    403: { description: "Sin permiso", ...err },
    404: { description: "Ya no existe", ...err },
    409: { description: "Es la sesión actual", ...err },
  },
})

export function registerUserRoutes(app: App, deps: AppDeps): void {
  app.openapi(meRoute, (c) => {
    const a = actorOf(c)
    return c.json(
      {
        id: a.userId,
        username: a.username,
        name: a.name,
        roleId: a.roleId,
        permissions: [...a.permissions],
        mustChangePassword: a.mustChangePassword,
        hasPin: a.hasPin,
        branchIds: a.branchIds ? [...a.branchIds] : null,
      },
      200,
    )
  })

  app.openapi(changeOwnRoute, async (c) => {
    const actor = actorOf(c)
    await changeOwnPassword(deps.db, actor, c.req.valid("json"), deps.now())
    return c.json({ ok: true as const }, 200)
  })

  app.openapi(setPinRoute, async (c) => {
    const actor = actorOf(c)
    await setOwnPin(deps.db, actor.userId, c.req.valid("json"), deps.now())
    return c.json({ ok: true as const }, 200)
  })

  app.openapi(verifyPinRoute, async (c) => {
    const actor = actorOf(c)
    await verifyOwnPin(deps.db, actor.userId, c.req.valid("json").pin, deps.now())
    return c.json({ ok: true as const }, 200)
  })

  app.openapi(sessionsRoute, (c) => {
    const actor = actorOf(c)
    const all = c.req.valid("query").all === "true"
    return c.json(listSessions(deps.db, actor, { all, now: deps.now() }), 200)
  })

  app.openapi(closeOthersRoute, (c) => {
    return c.json({ closed: revokeOtherSessions(deps.db, actorOf(c)) }, 200)
  })

  app.openapi(revokeSessionRoute, (c) => {
    revokeSession(deps.db, actorOf(c), c.req.valid("param").id)
    return c.json({ ok: true as const }, 200)
  })

  app.openapi(rolesRoute, (c) => {
    requirePermission(c, "user.manage")
    return c.json(deps.db.select().from(role).all(), 200)
  })

  app.openapi(listRoute, (c) => {
    requirePermission(c, "user.manage")
    return c.json(listUsers(deps.db), 200)
  })

  app.openapi(createRouteDef, async (c) => {
    const actor = requirePermission(c, "user.manage")
    const id = await createUserAccount(deps.auth, deps.db, c.req.valid("json"), actor.branchIds)
    return c.json({ id }, 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "user.manage")
    return c.json(updateUser(deps.db, actor, c.req.valid("param").id, c.req.valid("json")), 200)
  })

  app.openapi(resetRoute, async (c) => {
    const actor = requirePermission(c, "user.manage")
    await resetUserPassword(
      deps.db,
      actor,
      c.req.valid("param").id,
      c.req.valid("json").temporaryPassword,
    )
    return c.json({ ok: true as const }, 200)
  })
}
