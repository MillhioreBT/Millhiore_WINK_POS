import { describe, expect, test } from "bun:test"
import { agingBucket } from "./aging"

const DAY = 86_400_000
const NOW = 1_760_000_000_000

describe("antigüedad de saldos", () => {
  test("sin plazo o sin vencer cuenta como corriente", () => {
    expect(agingBucket(null, NOW)).toBe("current")
    expect(agingBucket(NOW + DAY, NOW)).toBe("current")
    expect(agingBucket(NOW, NOW)).toBe("current")
  })

  test("menos de un día completo de atraso todavía es corriente", () => {
    expect(agingBucket(NOW - DAY + 1, NOW)).toBe("current")
    expect(agingBucket(NOW - DAY, NOW)).toBe("d1_30")
  })

  test("los límites de cada tramo", () => {
    expect(agingBucket(NOW - 30 * DAY, NOW)).toBe("d1_30")
    expect(agingBucket(NOW - 31 * DAY, NOW)).toBe("d31_60")
    expect(agingBucket(NOW - 60 * DAY, NOW)).toBe("d31_60")
    expect(agingBucket(NOW - 61 * DAY, NOW)).toBe("d61_90")
    expect(agingBucket(NOW - 90 * DAY, NOW)).toBe("d61_90")
    expect(agingBucket(NOW - 91 * DAY, NOW)).toBe("d90plus")
    expect(agingBucket(NOW - 900 * DAY, NOW)).toBe("d90plus")
  })
})
