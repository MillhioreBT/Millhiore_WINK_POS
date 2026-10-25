import { describe, expect, test } from "bun:test"
import type { RemoteStatus, ServeResult } from "@millhiore/contracts"
import { harness, setUp } from "../../testing/harness"
import type { Runner } from "./tailscale"

const running = {
  BackendState: "Running",
  Self: {
    HostName: "CAJA-1",
    DNSName: "caja-1.tail1234.ts.net.",
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  },
  CurrentTailnet: { Name: "bodega@gmail.com" },
}

/** Un Tailscale de mentira: responde según el comando y anota lo que se le pidió. */
function fakeTailscale(opts: {
  status: unknown
  serve?: unknown
  serveRun?: Awaited<ReturnType<Runner>>
}) {
  const calls: string[][] = []
  const run: Runner = async (args) => {
    calls.push(args)
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false })
    if (args[0] === "status") return ok(JSON.stringify(opts.status))
    if (args[0] === "serve" && args[1] === "status") return ok(JSON.stringify(opts.serve ?? {}))
    if (args[0] === "serve") return opts.serveRun ?? ok("")
    return { code: 1, stdout: "", stderr: "?", timedOut: false }
  }
  return { run, calls }
}

async function status(run: Runner | null, origins = new Set<string>()) {
  const h = harness({ remote: { run, origins } })
  const s = await setUp(h)
  const res = await h.call("/api/remote", { cookie: s.owner })
  return { h, s, body: (await res.json()) as RemoteStatus }
}

describe("acceso remoto con Tailscale", () => {
  test("sin Tailscale, apagado o sin entrar", async () => {
    expect((await status(null)).body.tailscale.state).toBe("missing")
    const stopped = fakeTailscale({ status: { BackendState: "Stopped" } })
    expect((await status(stopped.run)).body.tailscale.state).toBe("stopped")
    const logout = fakeTailscale({ status: { BackendState: "NeedsLogin" } })
    expect((await status(logout.run)).body.tailscale.state).toBe("loggedOut")
  })

  test("funcionando: la dirección por la red de Tailscale y, si se sirve, la de HTTPS", async () => {
    const plain = fakeTailscale({ status: running })
    expect((await status(plain.run)).body).toEqual({
      port: 3000,
      tailscale: {
        state: "running",
        name: "CAJA-1",
        tailnet: "bodega@gmail.com",
        httpUrl: "http://100.101.102.103:3000",
        httpsUrl: null,
      },
    })
    const origins = new Set<string>()
    const served = fakeTailscale({
      status: running,
      serve: {
        Web: {
          "caja-1.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
        },
      },
    })
    const { body } = await status(served.run, origins)
    expect(body.tailscale.httpsUrl).toBe("https://caja-1.tail1234.ts.net")
    // Entrar por esa dirección: su origen pasa a ser de confianza.
    expect([...origins]).toEqual(["https://caja-1.tail1234.ts.net"])
  })

  test("activar HTTPS de Tailscale, o la dirección para habilitarlo en la cuenta", async () => {
    const ok = fakeTailscale({ status: running })
    const { h, s } = await status(ok.run)
    const res = await h.call("/api/remote/tailscale/serve", { cookie: s.owner, method: "POST" })
    expect(((await res.json()) as ServeResult).ok).toBe(true)
    expect(ok.calls).toContainEqual(["serve", "--bg", "3000"])

    const pending = fakeTailscale({
      status: running,
      serveRun: {
        code: null,
        stdout:
          "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n",
        stderr: "",
        timedOut: true,
      },
    })
    const second = await status(pending.run)
    const r = (await (
      await second.h.call("/api/remote/tailscale/serve", { cookie: second.s.owner, method: "POST" })
    ).json()) as ServeResult
    expect(r).toMatchObject({
      ok: false,
      approveUrl: "https://login.tailscale.com/f/serve?node=abc123",
    })
  })

  test("exige settings.manage", async () => {
    const { h, s } = await status(null)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/remote", { cookie: cashier })).status).toBe(403)
  })
})
