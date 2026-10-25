/**
 * Códigos QR propios (modo byte, corrección de errores M, versiones 1 a 10: hasta 213 bytes,
 * de sobra para una dirección). Sigue el algoritmo de la norma ISO/IEC 18004 tal como lo explica
 * Project Nayuki; se prueba leyendo lo dibujado con zxing, el mismo lector de la cámara.
 * Devuelve la matriz de módulos (true = oscuro) sin el margen: quien dibuja deja 4 módulos claros
 * alrededor.
 */

// Corrección M, por versión (índice = versión): bytes de corrección por bloque y cuántos bloques.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
/** Los bits de formato de la corrección M. */
const FORMAT_M = 0
const MAX_VERSION = 10

const N1 = 3
const N2 = 3
const N3 = 40
const N4 = 10

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

const dataCodewords = (ver: number) =>
  Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK[ver] ?? 0) * (BLOCKS[ver] ?? 0)

// Reed-Solomon sobre GF(2^8) con el polinomio 0x11D.
function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const result: number[] = Array(degree - 1).fill(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j] ?? 0, root)
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0)
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0)
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ gfMul(coef, factor)
    })
  }
  return result
}

class Grid {
  readonly size: number
  readonly dark: boolean[][]
  readonly fixed: boolean[][]
  constructor(readonly ver: number) {
    this.size = ver * 4 + 17
    this.dark = Array.from({ length: this.size }, () => Array(this.size).fill(false))
    this.fixed = Array.from({ length: this.size }, () => Array(this.size).fill(false))
  }

  set(x: number, y: number, dark: boolean) {
    const row = this.dark[y]
    const fixedRow = this.fixed[y]
    if (!row || !fixedRow) return
    row[x] = dark
    fixedRow[x] = true
  }

  functionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    this.finder(3, 3)
    this.finder(this.size - 4, 3)
    this.finder(3, this.size - 4)
    const pos = this.alignmentPositions()
    const n = pos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
        this.alignment(pos[i] ?? 0, pos[j] ?? 0)
      }
    }
    this.formatBits(0)
    this.versionBits()
  }

  finder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.set(xx, yy, dist !== 2 && dist !== 4)
        }
      }
    }
  }

  alignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  alignmentPositions(): number[] {
    if (this.ver === 1) return []
    const numAlign = Math.floor(this.ver / 7) + 2
    const step = Math.ceil((this.ver * 4 + 4) / (numAlign * 2 - 2)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
    return result
  }

  formatBits(mask: number) {
    const data = (FORMAT_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(bits, i))
    this.set(8, this.size - 8, true)
  }

  versionBits() {
    if (this.ver < 7) return
    let rem = this.ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const b = bit(bits, i)
      const a = this.size - 11 + (i % 3)
      const c = Math.floor(i / 3)
      this.set(a, c, b)
      this.set(c, a, b)
    }
  }

  codewords(data: readonly number[]) {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          const row = this.dark[y]
          if (row && !this.fixed[y]?.[x] && i < data.length * 8) {
            row[x] = bit(data[i >>> 3] ?? 0, 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  mask(m: number) {
    for (let y = 0; y < this.size; y++) {
      const row = this.dark[y]
      if (!row) continue
      for (let x = 0; x < this.size; x++) {
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][m]
        if (flip && !this.fixed[y]?.[x]) row[x] = !row[x]
      }
    }
  }

  /** Penalización de la norma: rachas, bloques 2×2, patrones parecidos al buscador y balance. */
  penalty(): number {
    const size = this.size
    const at = (x: number, y: number) => this.dark[y]?.[x] ?? false
    let result = 0
    const addHistory = (run: number, history: number[]) => {
      if (history[0] === 0) run += size
      history.pop()
      history.unshift(run)
    }
    const countPatterns = (h: number[]) => {
      const n = h[1] ?? 0
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n
      return (
        (core && (h[0] ?? 0) >= n * 4 && (h[6] ?? 0) >= n ? 1 : 0) +
        (core && (h[6] ?? 0) >= n * 4 && (h[0] ?? 0) >= n ? 1 : 0)
      )
    }
    const terminate = (color: boolean, run: number, history: number[]) => {
      if (color) {
        addHistory(run, history)
        run = 0
      }
      addHistory(run + size, history)
      return countPatterns(history)
    }
    for (const horizontal of [true, false]) {
      for (let a = 0; a < size; a++) {
        let color = false
        let run = 0
        const history = [0, 0, 0, 0, 0, 0, 0]
        for (let b = 0; b < size; b++) {
          const m = horizontal ? at(b, a) : at(a, b)
          if (m === color) {
            run++
            if (run === 5) result += N1
            else if (run > 5) result++
          } else {
            addHistory(run, history)
            if (!color) result += countPatterns(history) * N3
            color = m
            run = 1
          }
        }
        result += terminate(color, run, history) * N3
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = at(x, y)
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) result += N2
      }
    }
    const darkCount = this.dark.reduce((acc, row) => acc + row.filter(Boolean).length, 0)
    const total = size * size
    const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1
    return result + k * N4
  }
}

/** El QR de un texto (una dirección, normalmente). */
export function qrCode(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  let ver = 1
  // Modo byte: 4 bits de modo, 8 de largo (versiones 1–9) o 16 (10) y 8 por byte.
  const bitsNeeded = (v: number) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8
  while (ver <= MAX_VERSION && bitsNeeded(ver) > dataCodewords(ver) * 8) ver++
  if (ver > MAX_VERSION) throw new Error("El texto es demasiado largo para el código QR")

  const capacity = dataCodewords(ver) * 8
  const out: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) out.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, ver < 10 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, capacity - out.length))
  push(0, (8 - (out.length % 8)) % 8)
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data: number[] = []
  for (let i = 0; i < out.length; i += 8) {
    data.push(out.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0))
  }

  // Bloques con su corrección, intercalados.
  const numBlocks = BLOCKS[ver] ?? 1
  const eccLen = ECC_PER_BLOCK[ver] ?? 10
  const raw = Math.floor(rawDataModules(ver) / 8)
  const numShort = numBlocks - (raw % numBlocks)
  const shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShort) dat.push(0)
    blocks.push([...dat, ...ecc])
  }
  const interleaved: number[] = []
  for (let i = 0; i < (blocks[0]?.length ?? 0); i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) interleaved.push(block[i] ?? 0)
    })
  }

  const grid = new Grid(ver)
  grid.functionPatterns()
  grid.codewords(interleaved)
  let best = 0
  let bestPenalty = Number.POSITIVE_INFINITY
  for (let m = 0; m < 8; m++) {
    grid.mask(m)
    grid.formatBits(m)
    const p = grid.penalty()
    if (p < bestPenalty) {
      best = m
      bestPenalty = p
    }
    grid.mask(m)
  }
  grid.mask(best)
  grid.formatBits(best)
  return grid.dark
}

/** El trazado SVG de los módulos oscuros, con el margen de 4 módulos, y el lado total. */
export function qrPath(text: string): { path: string; size: number } {
  const modules = qrCode(text)
  let path = ""
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`
    })
  })
  return { path, size: modules.length + 8 }
}

/** El QR como SVG, para guardarlo o imprimirlo. */
export function qrSvg(text: string): string {
  const { path, size } = qrPath(text)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
