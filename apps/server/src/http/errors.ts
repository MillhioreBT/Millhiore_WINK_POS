import type { ApiError } from "@millhiore/contracts"
import type { PostingErrorCode } from "@millhiore/domain"
import type { ContentfulStatusCode } from "hono/utils/http-status"

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export const unauthorized = () => new HttpError(401, "UNAUTHORIZED", "Inicia sesión para continuar")
export const forbidden = (permission: string) =>
  new HttpError(403, "FORBIDDEN", `Falta el permiso ${permission}`)

export function errorBody(
  code: string,
  message: string,
  issues?: ApiError["error"]["issues"],
): ApiError {
  return { error: { code, message, ...(issues ? { issues } : {}) } }
}

const POSTING_STATUS: Record<PostingErrorCode, ContentfulStatusCode> = {
  UNSUPPORTED_TYPE: 422,
  EMPTY_DOCUMENT: 422,
  INVALID_LINE: 422,
  INVALID_PAYMENT: 422,
  MISSING_RATE: 422,
  CURRENCY_MISMATCH: 422,
  UNSETTLED: 422,
  UNKNOWN_REFERENCE: 422,
  INSUFFICIENT_STOCK: 409,
  ID_CONFLICT: 409,
  ALREADY_REVERSED: 409,
  NOT_REVERSIBLE: 409,
  SHIFT_CLOSED: 409,
  CREDIT_DENIED: 409,
  INVALID_ALLOCATION: 422,
  HAS_COLLECTIONS: 409,
  HAS_PAYMENTS: 409,
  NOT_RETURNABLE: 409,
  HAS_RETURNS: 409,
  QUOTE_CLOSED: 409,
  DISCOUNT_DENIED: 409,
}

export function postingStatus(code: PostingErrorCode): ContentfulStatusCode {
  return POSTING_STATUS[code]
}
