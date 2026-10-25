import { afterEach, describe, expect, test } from "bun:test"
import { createPrivateKey, X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:tls"
import { ensureLocalTls, localHosts } from "./tls"
import { createLocalCa, issueServerCert, subjectOf } from "./x509"

const NOW = Date.parse("2026-10-25T12:00:00Z")
const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "millhiore-tls-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("autoridad local", () => {
  test("es una autoridad válida, limitada a la red local", () => {
    const ca = new X509Certificate(createLocalCa({ commonName: "Prueba", now: NOW }).cert)
    expect(ca.ca).toBe(true)
    expect(ca.subject).toContain("CN=Prueba")
    expect(ca.verify(ca.publicKey)).toBe(true)
    expect(Date.parse(ca.validTo)).toBeGreaterThan(NOW + 9 * 365 * 86_400_000)
  })
})

describe("certificado del servidor", () => {
  test("cubre sus nombres y direcciones y lo firma la autoridad", () => {
    const dir = tempDir()
    const hosts = localHosts(["192.168.1.10", "10.0.0.5"], "CAJA-1")
    expect(hosts).toEqual(["localhost", "caja-1.local", "127.0.0.1", "192.168.1.10", "10.0.0.5"])
    const tls = ensureLocalTls(dir, hosts, NOW)
    const ca = new X509Certificate(tls.caCert)
    const server = new X509Certificate(tls.cert)
    expect(server.ca).toBe(false)
    expect(server.verify(ca.publicKey)).toBe(true)
    expect(server.checkIssued(ca)).toBe(true)
    expect(server.checkIP("192.168.1.10")).toBe("192.168.1.10")
    expect(server.checkHost("caja-1.local")).toBe("caja-1.local")
    expect(server.checkHost("google.com")).toBeUndefined()
    expect(subjectOf(tls.caCert).equals(subjectOf(tls.caCert))).toBe(true)
    expect(tls.caFingerprint).toBe(ca.fingerprint256)
    // La clave de la autoridad no la lee cualquiera (en Windows no hay permisos de Unix).
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "ca.key")).mode & 0o077).toBe(0)
    }
  })

  test("se conserva la autoridad y se renueva el del servidor si cambia la IP o va a vencer", () => {
    const dir = tempDir()
    const first = ensureLocalTls(dir, localHosts(["192.168.1.10"], "caja"), NOW)
    const same = ensureLocalTls(dir, localHosts(["192.168.1.10"], "caja"), NOW + 86_400_000)
    expect(same.cert).toBe(first.cert)
    // Otra IP: nuevo certificado del servidor, misma autoridad (los equipos no reinstalan nada).
    const moved = ensureLocalTls(dir, localHosts(["192.168.1.20"], "caja"), NOW)
    expect(moved.caCert).toBe(first.caCert)
    expect(moved.cert).not.toBe(first.cert)
    expect(new X509Certificate(moved.cert).checkIP("192.168.1.20")).toBe("192.168.1.20")
    // A menos de un mes de vencer, también.
    const later = ensureLocalTls(dir, localHosts(["192.168.1.20"], "caja"), NOW + 380 * 86_400_000)
    expect(later.cert).not.toBe(moved.cert)
    expect(readFileSync(join(dir, "ca.crt"), "utf8")).toBe(first.caCert)
  })

  test("un navegador que confía en la autoridad se conecta sin avisos", async () => {
    const tls = ensureLocalTls(tempDir(), localHosts([], "caja"), Date.now())
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: tls.cert, key: tls.key },
      fetch: () => new Response("ok"),
    })
    try {
      const authorized = await new Promise<boolean>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: server.port, ca: tls.caCert }, () => {
          resolve(socket.authorized)
          socket.end()
        })
        socket.on("error", reject)
      })
      expect(authorized).toBe(true)
      // Sin la autoridad instalada, el certificado no es de confianza.
      const rejected = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
          resolve(!socket.authorized)
          socket.end()
        })
        socket.on("error", () => resolve(true))
      })
      expect(rejected).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("con la clave de la autoridad no se puede suplantar un dominio de internet", async () => {
    const dir = tempDir()
    const tls = ensureLocalTls(dir, localHosts([], "caja"), Date.now())
    const ca = new X509Certificate(tls.caCert)
    const forged = issueServerCert({
      ca: {
        cert: tls.caCert,
        key: createPrivateKey(readFileSync(join(dir, "ca.key"), "utf8")),
        publicKey: ca.publicKey,
      },
      hosts: ["banco.com.ve"],
      now: Date.now(),
    })
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: forged.cert + tls.caCert, key: forged.key },
      fetch: () => new Response("ok"),
    })
    try {
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect(
          { host: "127.0.0.1", port: server.port, ca: tls.caCert, servername: "banco.com.ve" },
          () => {
            resolve(socket.authorized ? "confiado" : String(socket.authorizationError))
            socket.end()
          },
        )
        socket.on("error", (e) => resolve(e.message))
      })
      expect(outcome).not.toBe("confiado")
    } finally {
      server.stop(true)
    }
  })
})
