import { afterEach, describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NetworkInfo } from "@millhiore/contracts"
import { ensureLocalTls, localHosts } from "../../infra/tls"
import { harness, setUp } from "../../testing/harness"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function withHttps() {
  const dir = mkdtempSync(join(tmpdir(), "millhiore-net-"))
  dirs.push(dir)
  const hosts = localHosts(["192.168.1.10"], "caja")
  const tls = ensureLocalTls(dir, hosts, Date.now())
  return {
    httpPort: 3000,
    httpsPort: 3443,
    hosts,
    caCert: tls.caCert,
    caFingerprint: tls.caFingerprint,
  }
}

describe("conectar otros equipos", () => {
  test("las direcciones de la red local, con y sin HTTPS", async () => {
    const network = withHttps()
    const h = harness({ network })
    const s = await setUp(h)
    const info = (await (await h.call("/api/network", { cookie: s.owner })).json()) as NetworkInfo
    expect(info).toEqual({
      httpUrls: ["http://caja.local:3000", "http://192.168.1.10:3000"],
      httpsUrls: ["https://caja.local:3443", "https://192.168.1.10:3443"],
      caUrls: [
        "http://caja.local:3000/api/network/ca.crt",
        "http://192.168.1.10:3000/api/network/ca.crt",
      ],
      caFingerprint: network.caFingerprint,
    })
    // Pide sesión: no es para cualquiera que pase por la red.
    expect((await h.call("/api/network")).status).toBe(401)
  })

  test("el certificado de la autoridad se descarga sin entrar, listo para instalar", async () => {
    const network = withHttps()
    const h = harness({ network })
    await setUp(h)
    const res = await h.call("/api/network/ca.crt")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/x-x509-ca-cert")
    expect(res.headers.get("content-disposition")).toContain("millhiore-ca.crt")
    const cert = new X509Certificate(Buffer.from(await res.arrayBuffer()))
    expect(cert.ca).toBe(true)
    expect(cert.fingerprint256).toBe(network.caFingerprint)
  })

  test("con HTTPS apagado no hay certificado ni direcciones seguras", async () => {
    const h = harness({
      network: {
        httpPort: 3000,
        httpsPort: null,
        hosts: localHosts(["10.0.0.5"], "caja"),
        caCert: null,
        caFingerprint: null,
      },
    })
    const s = await setUp(h)
    expect((await h.call("/api/network/ca.crt")).status).toBe(404)
    const info = (await (await h.call("/api/network", { cookie: s.owner })).json()) as NetworkInfo
    expect(info.httpsUrls).toEqual([])
    expect(info.httpUrls).toContain("http://10.0.0.5:3000")
  })
})
