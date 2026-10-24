import type { Onboarding } from "@millhiore/contracts"
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CheckCircle2Icon, CircleIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { onboardingQuery, queryClient } from "../../lib/queries"

type StepId = Onboarding["steps"][number]["id"]

const STEPS: Record<StepId, { label: string; hint: string; to: string; tab?: string }> = {
  business: {
    label: "Datos del negocio",
    hint: "RIF y dirección: salen en los recibos",
    to: "/ajustes",
    tab: "negocio",
  },
  rate: {
    label: "Tasa del día",
    hint: "Se trae sola del BCV o se carga a mano",
    to: "/ajustes",
    tab: "tasa",
  },
  products: {
    label: "Tus productos",
    hint: "Uno por uno o todos desde Excel (Productos → Más)",
    to: "/productos",
  },
  users: {
    label: "Usuarios de tus cajeros",
    hint: "Cada quien con su clave y su PIN",
    to: "/ajustes",
    tab: "usuarios",
  },
  printer: {
    label: "Impresora de recibos",
    hint: "Térmica de 58 u 80 mm, o la del navegador",
    to: "/ajustes",
    tab: "impresora",
  },
  features: {
    label: "Funciones de tu negocio",
    hint: "Apaga lo que no usas (fiado, cotizaciones…)",
    to: "/ajustes",
    tab: "negocio",
  },
  sale: {
    label: "Primera venta",
    hint: "Abre el turno con lo que hay en la gaveta y vende",
    to: "/caja",
  },
}

/** Los primeros pasos de un comercio recién instalado. Se esconde al terminar o si se pide. */
export function OnboardingCard() {
  const onboarding = useQuery(onboardingQuery)
  const data = onboarding.data
  if (!data || data.dismissed) return null
  const done = data.steps.filter((s) => s.done).length
  if (done === data.steps.length) return null

  const dismiss = async () => {
    try {
      await api("/api/onboarding", { method: "PUT", body: { dismissed: true } })
      await queryClient.invalidateQueries({ queryKey: ["onboarding"] })
      toast.success("Guía escondida. Se vuelve a mostrar desde Ajustes → Negocio.")
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-2">
        <div className="grid flex-1 gap-1.5">
          <CardTitle>Para arrancar</CardTitle>
          <CardDescription>
            {done} de {data.steps.length} listos. Cada paso se marca solo al hacerlo.
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={dismiss}
          aria-label="Esconder la guía"
          title="Esconder la guía"
        >
          <XIcon />
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {data.steps.map((s) => {
            const step = STEPS[s.id]
            return (
              <li key={s.id}>
                <Link
                  to={step.to}
                  {...(step.tab ? { search: { tab: step.tab } } : {})}
                  className="flex items-start gap-2 rounded-md p-2 text-sm hover:bg-accent"
                >
                  {s.done ? (
                    <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={s.done ? "text-muted-foreground line-through" : ""}>
                    <span className="font-medium">{step.label}</span>
                    <span className="block text-muted-foreground text-xs no-underline">
                      {step.hint}
                    </span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
