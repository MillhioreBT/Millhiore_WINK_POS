import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  telegramChatSchema,
  telegramSettingsSchema,
  telegramTestSchema,
  updateTelegramSchema,
} from "@millhiore/contracts"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { discoverChats, sendTest, telegramSettings, updateTelegram } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const common = {
  403: { description: "Falta settings.manage", ...err },
  409: { description: "Falta conectar el bot o agregar un chat", ...err },
  422: { description: "Telegram rechazó el token o la petición", ...err },
  502: { description: "No hay conexión con Telegram", ...err },
}

const getRoute = createRoute({
  method: "get",
  path: "/api/telegram",
  tags: ["Integraciones"],
  summary: "El bot de Telegram, sus chats y qué alertas manda (nunca el token)",
  responses: { 200: { description: "Ajustes", content: json(telegramSettingsSchema) }, ...common },
})

const putRoute = createRoute({
  method: "put",
  path: "/api/telegram",
  tags: ["Integraciones"],
  summary: "Conecta o desconecta el bot, y elige los chats y las alertas",
  request: { body: { content: json(updateTelegramSchema), required: true } },
  responses: {
    200: { description: "Guardados", content: json(telegramSettingsSchema) },
    ...common,
  },
})

const discoverRoute = createRoute({
  method: "post",
  path: "/api/telegram/discover",
  tags: ["Integraciones"],
  summary: "Los chats que le escribieron al bot, para elegirlos",
  responses: {
    200: { description: "Chats", content: json(z.array(telegramChatSchema)) },
    ...common,
  },
})

const testRoute = createRoute({
  method: "post",
  path: "/api/telegram/test",
  tags: ["Integraciones"],
  summary: "Manda ya una prueba a cada chat",
  responses: { 200: { description: "Resultado", content: json(telegramTestSchema) }, ...common },
})

export function registerTelegramRoutes(app: App, deps: AppDeps): void {
  const fetcher = deps.telegram?.fetcher ?? fetch

  app.openapi(getRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(telegramSettings(deps.db), 200)
  })

  app.openapi(putRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    const body = c.req.valid("json")
    return c.json(await updateTelegram(deps.db, body, actor.userId, deps.now(), fetcher), 200)
  })

  app.openapi(discoverRoute, async (c) => {
    requirePermission(c, "settings.manage")
    return c.json(await discoverChats(deps.db, fetcher), 200)
  })

  app.openapi(testRoute, async (c) => {
    requirePermission(c, "settings.manage")
    return c.json(await sendTest(deps.db, fetcher), 200)
  })
}
