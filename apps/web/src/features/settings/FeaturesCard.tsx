import type { Features } from "@millhiore/contracts"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { bootstrapQuery, onboardingQuery, queryClient } from "../../lib/queries"

type Toggles = Features & { credit: boolean }

const OPTIONS: { key: keyof Toggles; label: string; hint: string }[] = [
  {
    key: "credit",
    label: "Fiado",
    hint: "Vender a crédito a clientes registrados, con abonos y días para pagar. Lo que ya se debe se sigue cobrando aunque lo apagues.",
  },
  {
    key: "quotes",
    label: "Cotizaciones",
    hint: "Guardar presupuestos desde la caja y venderlos después con sus precios.",
  },
  {
    key: "priceLists",
    label: "Listas de precios",
    hint: "Precios al mayor o para revendedores, por cliente.",
  },
  {
    key: "charges",
    label: "Recargos de venta",
    hint: "Delivery, servicio o empaque aparte de los productos.",
  },
  {
    key: "recurring",
    label: "Gastos recurrentes",
    hint: "Alquiler, internet o sueldos que se repiten cada mes.",
  },
  {
    key: "payables",
    label: "Cuentas por pagar",
    hint: "Dejar compras y gastos a deber a los proveedores y pagarlos después.",
  },
  {
    key: "locations",
    label: "Varias ubicaciones y cajas",
    hint: "Depósito, otra tienda o un segundo mostrador: existencia en cada sitio, traslados y una caja con su propio turno en cada mostrador.",
  },
  {
    key: "lots",
    label: "Lotes con vencimiento",
    hint: "Para perecederos: cada compra anota su fecha de vencimiento, la caja vende primero lo que vence antes y se avisa de lo que va a vencer.",
  },
]

/**
 * Lo que suele usar cada tipo de negocio; después se ajusta casilla por casilla. Las ubicaciones
 * dependen del local y los lotes de lo que se vende, no del tipo de negocio: ningún perfil los toca.
 */
const PRESETS: { id: string; label: string; toggles: Omit<Toggles, "locations" | "lots"> }[] = [
  {
    id: "bodega",
    label: "Bodega o abasto",
    toggles: {
      credit: true,
      quotes: false,
      priceLists: false,
      charges: false,
      recurring: true,
      payables: true,
    },
  },
  {
    id: "tienda",
    label: "Tienda (ferretería, ropa, repuestos…)",
    toggles: {
      credit: true,
      quotes: true,
      priceLists: true,
      charges: false,
      recurring: true,
      payables: true,
    },
  },
  {
    id: "comida",
    label: "Comida (restaurante, cafetín, delivery)",
    toggles: {
      credit: false,
      quotes: false,
      priceLists: false,
      charges: true,
      recurring: true,
      payables: true,
    },
  },
  {
    id: "mayorista",
    label: "Distribuidora o mayorista",
    toggles: {
      credit: true,
      quotes: true,
      priceLists: true,
      charges: true,
      recurring: true,
      payables: true,
    },
  },
]

/**
 * Funciones que el comercio usa. Las apagadas se esconden del menú y de la caja; no se borra nada
 * de lo ya registrado y se pueden volver a encender cuando se quiera.
 */
export function FeaturesCard() {
  const boot = useQuery(bootstrapQuery)
  const [busy, setBusy] = useState(false)
  const onboarding = useQuery(onboardingQuery)
  // Lo que se acaba de marcar se ve al instante, mientras el servidor lo guarda.
  const [pending, setPending] = useState<Partial<Toggles>>({})
  const current: Toggles | null = boot.data
    ? { ...boot.data.features, credit: boot.data.credit.enabled, ...pending }
    : null

  const save = async (next: Partial<Toggles>, message: string) => {
    setBusy(true)
    setPending(next)
    try {
      const { credit, ...features } = next
      if (credit !== undefined) {
        await api("/api/settings/credit", { method: "PUT", body: { enabled: credit } })
      }
      await api("/api/settings/features", { method: "PUT", body: features })
      await queryClient.invalidateQueries({ queryKey: ["bootstrap"] })
      await queryClient.invalidateQueries({ queryKey: ["onboarding"] })
      toast.success(message)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending({})
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Funciones</CardTitle>
        <CardDescription>
          Apaga lo que tu negocio no usa: se esconde del menú y de la caja. No se borra nada y se
          puede volver a encender.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <Field
          label="Según el tipo de negocio"
          htmlFor="f-preset"
          hint="Marca de una vez lo que suele usar ese tipo de negocio"
        >
          <NativeSelect
            id="f-preset"
            value=""
            disabled={!current || busy}
            onChange={(e) => {
              const preset = PRESETS.find((p) => p.id === e.target.value)
              if (preset) void save(preset.toggles, `Funciones de «${preset.label}»`)
            }}
          >
            <option value="">Elegir…</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {OPTIONS.map((o) => (
            <div key={o.key} className="flex items-start gap-3">
              <input
                id={`f-${o.key}`}
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={current?.[o.key] ?? true}
                disabled={!current || busy}
                onChange={(e) =>
                  void save(
                    { [o.key]: e.target.checked },
                    `${o.label}: ${e.target.checked ? "encendido" : "apagado"}`,
                  )
                }
              />
              <div className="grid grid-cols-1 gap-1">
                <Label htmlFor={`f-${o.key}`}>{o.label}</Label>
                <p className="text-muted-foreground text-xs">{o.hint}</p>
              </div>
            </div>
          ))}
        </div>
        {onboarding.data?.dismissed ? (
          <Button
            variant="ghost"
            className="justify-self-start px-2"
            onClick={async () => {
              await api("/api/onboarding", { method: "PUT", body: { dismissed: false } })
              await queryClient.invalidateQueries({ queryKey: ["onboarding"] })
              toast.success("La guía para arrancar vuelve a salir en Inicio")
            }}
          >
            Volver a mostrar la guía para arrancar
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}
