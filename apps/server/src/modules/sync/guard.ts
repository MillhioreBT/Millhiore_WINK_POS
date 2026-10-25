import type { Db } from "@millhiore/db"
import { HttpError } from "../../http/errors"
import { readLink } from "./link"

/**
 * Lo que en una sucursal se cambia en el central: el catálogo, los usuarios, el dinero, los
 * ajustes del negocio y la tasa (todo eso baja del central y aquí se pisaría). Se puede vender,
 * comprar, ajustar, trasladar, abrir y cerrar turnos, y crear clientes.
 */
const MANAGED: { methods?: readonly string[]; pattern: RegExp }[] = [
  {
    pattern:
      /^\/api\/(accounts|branches|categories|charges|discount-codes|expense-categories|locations|modifier-groups|payment-methods|price-lists|products|stock-reasons|surcharges|taxes|terminals|users|rates|import|recurring-expenses)(\/|$)/,
  },
  { pattern: /^\/api\/me\/password$/ },
  { methods: ["PUT"], pattern: /^\/api\/me\/pin$/ },
  // Los de este equipo (la impresora y la balanza) sí se cambian aquí.
  { pattern: /^\/api\/settings\/(?!printer$|scale$)/ },
  { methods: ["PATCH"], pattern: /^\/api\/(lots|contacts)\/[^/]+$/ },
]

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** En una sucursal unida a un central, lo que se maneja allá no se cambia aquí. */
export function requireNotManagedByCentral(
  db: Pick<Db, "select">,
  method: string,
  path: string,
): void {
  if (!WRITES.has(method)) return
  const managed = MANAGED.some(
    (m) => (!m.methods || m.methods.includes(method)) && m.pattern.test(path),
  )
  if (!managed) return
  const link = readLink(db)
  if (!link) return
  throw new HttpError(
    409,
    "MANAGED_BY_CENTRAL",
    "Esta PC es una sucursal: eso se cambia en el central y llega aquí solo",
  )
}
