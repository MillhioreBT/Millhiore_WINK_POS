import { describe, expect, test } from "bun:test"
import { ApiError } from "../../lib/api"
import { onSendError } from "./offline"

describe("ventas cobradas sin conexión", () => {
  test("se reintentan si falta la conexión, el servidor falla o no hay sesión", () => {
    expect(onSendError(new ApiError(0, "OFFLINE", "No hay conexión"))).toBe("retry")
    expect(onSendError(new ApiError(502, "HTTP_ERROR", "Bad gateway"))).toBe("retry")
    expect(onSendError(new ApiError(401, "UNAUTHORIZED", "Inicia sesión"))).toBe("retry")
    expect(onSendError(new ApiError(429, "TOO_MANY_REQUESTS", "Espera"))).toBe("retry")
    expect(onSendError(new ApiError(403, "PASSWORD_CHANGE_REQUIRED", "Cambia tu clave"))).toBe(
      "retry",
    )
    expect(onSendError(new TypeError("fetch failed"))).toBe("retry")
  })

  test("lo que el servidor rechaza por la venta misma queda para revisarlo", () => {
    expect(onSendError(new ApiError(409, "SHIFT_CLOSED", "Abre el turno"))).toBe("fail")
    expect(onSendError(new ApiError(422, "INSUFFICIENT_STOCK", "No alcanza"))).toBe("fail")
    expect(onSendError(new ApiError(403, "FORBIDDEN", "Sin permiso"))).toBe("fail")
  })
})
