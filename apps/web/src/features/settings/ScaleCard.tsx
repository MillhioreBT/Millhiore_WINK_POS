import type { ScaleSettings } from "@millhiore/contracts"
import { parseWeightBarcode } from "@millhiore/domain"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { CheckIcon, PlugIcon, WeightIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { currencySymbol, formatMoney, formatQtyUnit } from "../../lib/format"
import { bootstrapQuery, productsQuery, queryClient, scaleSettingsQuery } from "../../lib/queries"
import {
  DEFAULT_SCALE_DEVICE,
  forgetScale,
  loadScaleDevice,
  pairScale,
  readScale,
  SCALE_COMMANDS,
  type ScaleCommand,
  type ScaleDevice,
  saveScaleDevice,
  scalePaired,
  scaleSupported,
} from "../../lib/scale"
import { can, useMe } from "../../lib/session"

const PREFIXES = ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"]
const BAUD_RATES = [1200, 2400, 4800, 9600, 19200]
const FRAMES = {
  "8N": { label: "8 bits, sin paridad", dataBits: 8, parity: "none" },
  "7E": { label: "7 bits, paridad par", dataBits: 7, parity: "even" },
  "7O": { label: "7 bits, paridad impar", dataBits: 7, parity: "odd" },
} as const
const frameOf = (d: ScaleDevice) =>
  (Object.entries(FRAMES).find(
    ([, f]) => f.dataBits === d.dataBits && f.parity === d.parity,
  )?.[0] ?? "8N") as keyof typeof FRAMES

/** Lo que llegó por el puerto, con los caracteres de control a la vista. */
const visible = (raw: string) =>
  [...raw]
    .map((c) => {
      const n = c.charCodeAt(0)
      if (n >= 32) return c
      return c === "\r" ? "⏎" : c === "\n" ? "↵\n" : `<${n.toString(16).padStart(2, "0")}>`
    })
    .join("")

/** Un ejemplo de etiqueta con el formato elegido, para ver dónde va cada parte. */
function example(s: ScaleSettings): string {
  const valueDigits = 10 - s.pluDigits
  const plu = "12".padStart(s.pluDigits, "0")
  const value = (s.value === "weight" ? "350" : "45000").padStart(valueDigits, "0")
  return `${s.prefixes[0] ?? "20"} ${plu} ${value} + control`
}

/**
 * La balanza: cómo leer las etiquetas que imprime (prefijo, código del producto, peso o precio) y,
 * en este equipo, la balanza conectada por el puerto serie para pesar desde la caja.
 */
export function ScaleCard() {
  const me = useMe()
  const canManage = can(me, "settings.manage")
  const settings = useQuery(scaleSettingsQuery)
  const boot = useQuery(bootstrapQuery)
  const [draft, setDraft] = useState<ScaleSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const current = draft ?? settings.data
  const legal = boot.data?.business.legalCurrency ?? "VES"
  const reference = boot.data?.business.referenceCurrency ?? "USD"

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await api("/api/settings/scale", { method: "PUT", body: draft })
      await Promise.all(
        ["settings", "bootstrap"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      )
      setDraft(null)
      toast.success("Formato de las etiquetas guardado")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Balanza</CardTitle>
        <CardDescription>
          La caja lee las etiquetas que imprime la balanza y agrega el producto con su peso o su
          precio. Cada producto lleva su código de la balanza (PLU) en su ficha.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {current ? (
          <section className="grid min-w-0 content-start gap-3">
            <h3 className="font-medium text-sm">Etiquetas de la balanza</h3>
            <fieldset className="grid min-w-0 gap-1.5" disabled={!canManage}>
              <legend className="mb-1.5 text-sm">Empiezan con</legend>
              <div className="flex flex-wrap gap-1.5">
                {PREFIXES.map((p) => {
                  const on = current.prefixes.includes(p)
                  return (
                    <Button
                      key={p}
                      type="button"
                      size="sm"
                      variant={on ? "default" : "outline"}
                      className="tabular h-8 w-11 rounded-full px-0"
                      aria-pressed={on}
                      onClick={() =>
                        setDraft({
                          ...current,
                          prefixes: on
                            ? current.prefixes.filter((x) => x !== p)
                            : [...current.prefixes, p].sort(),
                        })
                      }
                    >
                      {p}
                    </Button>
                  )
                })}
              </div>
            </fieldset>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Dígitos del producto (PLU)" htmlFor="scale-plu">
                <NativeSelect
                  id="scale-plu"
                  disabled={!canManage}
                  value={current.pluDigits}
                  onChange={(e) => setDraft({ ...current, pluDigits: Number(e.target.value) })}
                >
                  {[4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n} dígitos
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Después trae" htmlFor="scale-value">
                <NativeSelect
                  id="scale-value"
                  disabled={!canManage}
                  value={current.value}
                  onChange={(e) =>
                    setDraft({ ...current, value: e.target.value as ScaleSettings["value"] })
                  }
                >
                  <option value="weight">El peso (en gramos)</option>
                  <option value="price">El precio (con céntimos)</option>
                </NativeSelect>
              </Field>
              {current.value === "price" ? (
                <Field label="Moneda del precio" htmlFor="scale-currency">
                  <NativeSelect
                    id="scale-currency"
                    disabled={!canManage}
                    value={current.priceCurrency}
                    onChange={(e) => setDraft({ ...current, priceCurrency: e.target.value })}
                  >
                    {[...new Set([legal, reference])].map((c) => (
                      <option key={c} value={c}>
                        {currencySymbol(c)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
            </div>
            <p className="tabular text-muted-foreground text-xs">Ejemplo: {example(current)}</p>
            <TryCode settings={current} />
            {canManage ? (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!draft || busy || current.prefixes.length === 0}
                  onClick={() => void save()}
                >
                  Guardar
                </Button>
              </div>
            ) : null}
          </section>
        ) : (
          <p className="text-muted-foreground text-sm">Cargando…</p>
        )}
        <DeviceSection />
      </CardContent>
    </Card>
  )
}

/** Escribir o escanear una etiqueta para ver qué producto y qué peso entiende la caja. */
function TryCode({ settings }: { settings: ScaleSettings }) {
  const [code, setCode] = useState("")
  const products = useQuery(productsQuery())
  const label = code.trim() ? parseWeightBarcode(code, settings) : null
  const item = label ? products.data?.find((p) => p.plu === label.plu) : undefined
  return (
    <Field
      label="Probar una etiqueta"
      htmlFor="scale-try"
      hint={
        !code.trim()
          ? "Escanea o escribe el código de una etiqueta"
          : !label
            ? "No es una etiqueta de la balanza con este formato"
            : `Producto ${label.plu}${item ? ` (${item.name})` : ", que no está en ningún producto"} · ${
                label.weightMilli !== undefined
                  ? formatQtyUnit(label.weightMilli, "kg")
                  : formatMoney(label.priceMinor, settings.priceCurrency)
              }`
      }
    >
      <Input
        id="scale-try"
        inputMode="numeric"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="tabular"
      />
    </Field>
  )
}

/** La balanza conectada a este equipo (cada caja la suya). */
function DeviceSection() {
  const supported = scaleSupported()
  const [device, setDevice] = useState<ScaleDevice>(() => loadScaleDevice() ?? DEFAULT_SCALE_DEVICE)
  const [paired, setPaired] = useState(false)
  const [configured, setConfigured] = useState(() => loadScaleDevice() !== null)
  const [test, setTest] = useState<{ raw: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (supported) void scalePaired().then(setPaired)
  }, [supported])

  const update = (patch: Partial<ScaleDevice>) => {
    const next = { ...device, ...patch }
    setDevice(next)
    if (configured) saveScaleDevice(next)
  }

  if (!supported) {
    return (
      <section className="grid content-start gap-2">
        <h3 className="font-medium text-sm">Balanza conectada a este equipo</h3>
        <p className="text-muted-foreground text-sm">
          Este navegador no lee balanzas por el puerto serie. Para pesar desde la caja, abre la app
          en Chrome o Edge en la PC donde está la balanza (por HTTPS o en la PC del servidor). Las
          etiquetas de la balanza se leen igual con cualquier lector de códigos.
        </p>
      </section>
    )
  }

  return (
    <section className="grid min-w-0 content-start gap-3">
      <h3 className="flex items-center gap-2 font-medium text-sm">
        Balanza conectada a este equipo
        {configured && paired ? (
          <Badge variant="secondary">
            <CheckIcon /> Lista
          </Badge>
        ) : null}
      </h3>
      <p className="text-muted-foreground text-xs">
        Por el puerto serie o un cable USB-serie. Al tocar un producto por kilo en la caja, se pesa
        solo.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Velocidad" htmlFor="scale-baud">
          <NativeSelect
            id="scale-baud"
            value={device.baudRate}
            onChange={(e) => update({ baudRate: Number(e.target.value) })}
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b} baudios
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Datos" htmlFor="scale-frame">
          <NativeSelect
            id="scale-frame"
            value={frameOf(device)}
            onChange={(e) => {
              const f = FRAMES[e.target.value as keyof typeof FRAMES]
              update({ dataBits: f.dataBits, parity: f.parity })
            }}
          >
            {Object.entries(FRAMES).map(([id, f]) => (
              <option key={id} value={id}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Cómo da el peso" htmlFor="scale-command" className="sm:col-span-2">
          <NativeSelect
            id="scale-command"
            value={device.command}
            onChange={(e) => update({ command: e.target.value as ScaleCommand })}
          >
            {Object.entries(SCALE_COMMANDS).map(([id, c]) => (
              <option key={id} value={id}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={configured && paired ? "outline" : "default"}
          onClick={async () => {
            try {
              await pairScale()
              saveScaleDevice(device)
              setConfigured(true)
              setPaired(true)
              toast.success("Balanza conectada a este equipo")
            } catch (e) {
              // Cerrar el selector del navegador no es un error.
              if ((e as Error).name !== "NotFoundError") toast.error(errorMessage(e))
            }
          }}
        >
          <PlugIcon /> {configured && paired ? "Elegir otro puerto" : "Conectar la balanza"}
        </Button>
        {configured && paired ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const { reading, raw } = await readScale(device, 2500)
                  setTest({
                    raw,
                    text: reading
                      ? `${formatQtyUnit(reading.weightMilli, "kg")}${reading.stable ? "" : " (todavía se mueve)"}`
                      : raw
                        ? "Llegaron datos, pero no se entiende el peso: revisa la velocidad y los datos"
                        : "No llegó nada: revisa el cable, la velocidad y cómo da el peso",
                  })
                } catch (e) {
                  setTest({ raw: "", text: errorMessage(e) })
                } finally {
                  setBusy(false)
                }
              }}
            >
              <WeightIcon /> {busy ? "Pesando…" : "Probar"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await forgetScale().catch(() => {})
                saveScaleDevice(null)
                setConfigured(false)
                setPaired(false)
                setTest(null)
              }}
            >
              Quitar
            </Button>
          </>
        ) : null}
      </div>
      {test ? (
        <div className="grid gap-1 rounded-lg bg-muted/60 p-3 text-sm">
          <p className="font-medium">{test.text}</p>
          {test.raw ? (
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
              {visible(test.raw)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
