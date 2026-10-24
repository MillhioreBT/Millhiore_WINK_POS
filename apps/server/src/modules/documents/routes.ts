import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  documentDetailSchema,
  documentSummarySchema,
  postDocumentSchema,
  postedDocumentSchema,
  returnableSchema,
  returnBodySchema,
  voidDocumentSchema,
} from "@millhiore/contracts"
import { document } from "@millhiore/db"
import { permissionToPost, permissionToVoid } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { postDocument, voidDocument } from "../../posting"
import { postingContext } from "../settings/service"
import { documentType, postReturn, returnableOf } from "./returns"
import { getDocument, isDocumentType, listDocuments } from "./service"

const errors = {
  401: { description: "Sin sesión", content: { "application/json": { schema: apiErrorSchema } } },
  403: {
    description: "Falta un permiso",
    content: { "application/json": { schema: apiErrorSchema } },
  },
  409: {
    description: "Conflicto (id repetido, ya anulado, sin stock)",
    content: { "application/json": { schema: apiErrorSchema } },
  },
  422: {
    description: "Documento inválido",
    content: { "application/json": { schema: apiErrorSchema } },
  },
} as const

const posted = { "application/json": { schema: postedDocumentSchema } }

const postRoute = createRoute({
  method: "post",
  path: "/api/documents",
  tags: ["Documentos"],
  summary: "Contabiliza un documento (venta, compra o ajuste)",
  description:
    "Idempotente: reenviar el mismo `id` devuelve el documento ya contabilizado con `duplicate: true`.",
  request: {
    body: { content: { "application/json": { schema: postDocumentSchema } }, required: true },
  },
  responses: {
    201: { description: "Contabilizado", content: posted },
    200: { description: "Ya estaba contabilizado", content: posted },
    ...errors,
  },
})

const voidRoute = createRoute({
  method: "post",
  path: "/api/documents/{id}/void",
  tags: ["Documentos"],
  summary: "Anula un documento generando un reverso",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: { "application/json": { schema: voidDocumentSchema } }, required: true },
  },
  responses: {
    201: { description: "Reverso contabilizado", content: posted },
    200: { description: "El reverso ya existía", content: posted },
    404: { description: "No existe", content: { "application/json": { schema: apiErrorSchema } } },
    ...errors,
  },
})

const returnableRoute = createRoute({
  method: "get",
  path: "/api/documents/{id}/returnable",
  tags: ["Documentos"],
  summary: "Qué se puede devolver de una venta o una compra",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: {
      description: "Líneas devolvibles",
      content: { "application/json": { schema: returnableSchema } },
    },
    403: errors[403],
    404: { description: "No existe", content: { "application/json": { schema: apiErrorSchema } } },
    409: errors[409],
  },
})

const returnRoute = createRoute({
  method: "post",
  path: "/api/documents/{id}/return",
  tags: ["Documentos"],
  summary: "Devuelve parte de una venta (o de una compra, al proveedor)",
  description:
    "El servidor usa el precio, el descuento y el IVA con que se vendió (o compró) cada línea. El dinero se mueve por los métodos indicados o se descuenta de la deuda del documento. Idempotente por `id`.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: { "application/json": { schema: returnBodySchema } }, required: true },
  },
  responses: {
    201: { description: "Devolución contabilizada", content: posted },
    200: { description: "Ya estaba contabilizada", content: posted },
    403: errors[403],
    404: { description: "No existe", content: { "application/json": { schema: apiErrorSchema } } },
    409: errors[409],
    422: errors[422],
  },
})

const listRoute = createRoute({
  method: "get",
  path: "/api/documents",
  tags: ["Documentos"],
  summary: "Documentos recientes (los más nuevos primero)",
  request: {
    query: z.object({
      /** Tipos separados por coma, p. ej. "SALE" o "PURCHASE,ADJUSTMENT". */
      type: z.string().max(100).optional(),
      /** Desde/hasta (ms Unix, hasta excluido). */
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  },
  responses: {
    200: {
      description: "Documentos",
      content: { "application/json": { schema: z.array(documentSummarySchema) } },
    },
    422: errors[422],
  },
})

const detailRoute = createRoute({
  method: "get",
  path: "/api/documents/{id}",
  tags: ["Documentos"],
  summary: "Documento completo con líneas, pagos e impuestos",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: {
      description: "Documento",
      content: { "application/json": { schema: documentDetailSchema } },
    },
    404: { description: "No existe", content: { "application/json": { schema: apiErrorSchema } } },
  },
})

/** Ver documentos de un tipo exige poder crearlos o ver informes. */
export function canView(permissions: ReadonlySet<string>, type: string): boolean {
  if (permissions.has("report.view")) return true
  const p = isDocumentType(type) ? permissionToPost(type) : undefined
  return p !== undefined && permissions.has(p)
}

export function registerDocumentRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    const actor = actorOf(c)
    const q = c.req.valid("query")
    const types = q.type
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean)
    for (const t of types ?? []) {
      if (!isDocumentType(t)) throw new HttpError(422, "UNSUPPORTED_TYPE", `Tipo desconocido: ${t}`)
    }
    const rows = listDocuments(deps.db, {
      types: types?.filter(isDocumentType),
      from: q.from,
      to: q.to,
      limit: q.limit,
    })
    return c.json(
      rows.filter((d) => canView(actor.permissions, d.type)),
      200,
    )
  })

  app.openapi(detailRoute, (c) => {
    const actor = actorOf(c)
    const doc = getDocument(deps.db, c.req.valid("param").id)
    if (!canView(actor.permissions, doc.type))
      throw new HttpError(403, "FORBIDDEN", "No puedes ver este documento")
    return c.json(doc, 200)
  })

  const context = (actorId: string) => postingContext(deps.db, deps.now(), actorId)

  app.openapi(postRoute, (c) => {
    const body = c.req.valid("json")
    // Una devolución no se arma desde la caja: parte de una venta o una compra
    // (POST /api/documents/{id}/return).
    if (body.type === "RETURN" || body.type === "PURCHASE_RETURN") {
      throw new HttpError(
        422,
        "UNSUPPORTED_TYPE",
        "Las devoluciones se hacen desde la venta o la compra",
      )
    }
    if (body.type === "EXPENSE") {
      throw new HttpError(422, "UNSUPPORTED_TYPE", "Los gastos se registran en /api/expenses")
    }
    if (body.type === "TRANSFER") {
      throw new HttpError(422, "UNSUPPORTED_TYPE", "Las transferencias se hacen en /api/transfers")
    }
    if (body.type === "DEBT_IN" || body.type === "DEBT_OUT") {
      throw new HttpError(422, "UNSUPPORTED_TYPE", "Las deudas se anotan en /api/debts")
    }
    const permission = permissionToPost(body.type)
    if (!permission) throw new HttpError(422, "UNSUPPORTED_TYPE", `Tipo no soportado: ${body.type}`)
    const actor = requirePermission(c, permission)
    // Fiar es una decisión aparte de vender: quien no puede fiar cobra todo en el momento.
    if (body.creditMinor > 0 && body.type === "SALE") requirePermission(c, "sale.credit")
    // Lo mismo con los descuentos: quien no puede darlos cobra el precio de lista, salvo lo que
    // dé un código de descuento (el motor verifica que no pase de ahí).
    const discounts = body.lines.some((l) => l.discountMinor > 0)
    const canDiscount = actor.permissions.has("sale.discount")
    if (discounts && !canDiscount && !body.discountCodeId) requirePermission(c, "sale.discount")
    const result = postDocument(
      deps.db,
      { ...body, discountFromCodeOnly: !canDiscount },
      context(actor.userId),
    )
    return result.duplicate ? c.json(result, 200) : c.json(result, 201)
  })

  // Devolver lo de una venta pide poder anular ventas; devolverle al proveedor, poder anular compras.
  const returnPermission = (id: string) =>
    documentType(deps.db, id) === "PURCHASE" ? "purchase.void" : "sale.void"

  app.openapi(returnableRoute, (c) => {
    const { id } = c.req.valid("param")
    requirePermission(c, returnPermission(id))
    return c.json(returnableOf(deps.db, id), 200)
  })

  app.openapi(returnRoute, (c) => {
    const actor = requirePermission(c, returnPermission(c.req.valid("param").id))
    const result = postReturn(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
      context(actor.userId),
    )
    return c.json(result, result.duplicate ? 200 : 201)
  })

  app.openapi(voidRoute, (c) => {
    const { id } = c.req.valid("param")
    const body = c.req.valid("json")
    const original = deps.db
      .select({ type: document.type })
      .from(document)
      .where(eq(document.id, id))
      .get()
    if (!original) throw new HttpError(404, "NOT_FOUND", `No existe el documento ${id}`)
    const permission = permissionToVoid(original.type)
    if (!permission)
      throw new HttpError(422, "UNSUPPORTED_TYPE", `Tipo no soportado: ${original.type}`)
    const actor = requirePermission(c, permission)
    const result = voidDocument(
      deps.db,
      id,
      body.reversalId,
      context(actor.userId),
      body.reason ?? null,
    )
    return result.duplicate ? c.json(result, 200) : c.json(result, 201)
  })
}
