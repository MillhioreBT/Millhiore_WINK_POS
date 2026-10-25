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
    key: "branches",
    label: "Sucursales",
    hint: "Otro local contra este mismo servidor: cada sucursal con sus ubicaciones, sus cajas, su lista de precios y sus datos en el recibo; el personal trabaja en las suyas y los informes se ven por sucursal.",
  },
  {
    key: "lots",
    label: "Lotes con vencimiento",
    hint: "Para perecederos: cada compra anota su fecha de vencimiento, la caja vende primero lo que vence antes y se avisa de lo que va a vencer.",
  },
  {
    key: "variants",
    label: "Tallas y colores",
    hint: "Para ropa, calzado o accesorios: cada combinación (M azul, L negra) con su código, su precio y su existencia; en la caja se elige en una cuadrícula.",
  },
  {
    key: "tables",
    label: "Mesas y cuentas abiertas",
    hint: "Para restaurantes: salas y mesas, cada una con su cuenta abierta mientras consumen. Se pasa de mesa, se junta y se cobra toda, por partes o a partes iguales.",
  },
  {
    key: "modifiers",
    label: "Opciones y extras",
    hint: "Lo que se elige al vender un producto: el término de la carne, el tamaño, queso extra con su precio o «sin cebolla» para la cocina.",
  },
  {
    key: "kitchen",
    label: "Comandas a cocina",
    hint: "Lo que se pide va a la cocina o a la barra: a su impresora o a una pantalla de cocina donde se marca lo que está listo.",
  },
  {
    key: "recipes",
    label: "Recetas e insumos",
    hint: "Cada plato con sus ingredientes y su merma: al venderlo se descuentan del inventario y se sabe cuánto cuesta.",
  },
  {
    key: "tips",
    label: "Propinas",
    hint: "Al cobrar se anota la propina y para quién es; el cierre del turno y los informes dicen cuánto le toca a cada mesonero.",
  },
  {
    key: "scale",
    label: "Balanza",
    hint: "Para charcutería, carnicería o frutería: la caja lee las etiquetas con el peso o el precio que imprime la balanza, o pesa directo en una balanza conectada a la PC.",
  },
  {
    key: "catalog",
    label: "Catálogo en línea",
    hint: "Una página con tus productos, sus fotos y sus precios en $ y Bs para compartir por WhatsApp o Instagram. Se arma en Ajustes → Integraciones.",
  },
]

/**
 * Lo que suele usar cada tipo de negocio; después se ajusta casilla por casilla. Las ubicaciones y
 * las sucursales dependen del local y los lotes de lo que se vende, no del tipo de negocio, y
 * publicar los precios en internet lo decide cada uno: ningún perfil los toca.
 */
const PRESETS: {
  id: string
  label: string
  toggles: Omit<Toggles, "locations" | "lots" | "branches" | "catalog">
}[] = [
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
      variants: false,
      tables: false,
      modifiers: false,
      kitchen: false,
      recipes: false,
      tips: false,
      scale: true,
    },
  },
  {
    id: "tienda",
    label: "Tienda (ferretería, repuestos, variedades…)",
    toggles: {
      credit: true,
      quotes: true,
      priceLists: true,
      charges: false,
      recurring: true,
      payables: true,
      variants: false,
      tables: false,
      modifiers: false,
      kitchen: false,
      recipes: false,
      tips: false,
      scale: false,
    },
  },
  {
    id: "ropa",
    label: "Ropa, calzado o accesorios",
    toggles: {
      credit: true,
      quotes: false,
      priceLists: true,
      charges: false,
      recurring: true,
      payables: true,
      variants: true,
      tables: false,
      modifiers: false,
      kitchen: false,
      recipes: false,
      tips: false,
      scale: false,
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
      variants: false,
      tables: true,
      modifiers: true,
      kitchen: true,
      recipes: true,
      tips: true,
      scale: false,
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
      variants: false,
      tables: false,
      modifiers: false,
      kitchen: false,
      recipes: false,
      tips: false,
      scale: false,
    },
  },
]

/** Las sucursales tienen sus ubicaciones y sus cajas: van de la mano con «Varias ubicaciones». */
function linked(key: keyof Toggles, on: boolean): Partial<Toggles> {
  if (key === "branches" && on) return { branches: true, locations: true }
  if (key === "locations" && !on) return { locations: false, branches: false }
  return { [key]: on }
}

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
                    linked(o.key, e.target.checked),
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
