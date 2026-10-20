# Millhiore WINK POS

[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-green.svg)](LICENSE)
[![Código de conducta](https://img.shields.io/badge/c%C3%B3digo%20de%20conducta-Contributor%20Covenant-blue.svg)](CODE_OF_CONDUCT.md)
[![PRs bienvenidos](https://img.shields.io/badge/PRs-bienvenidos-brightgreen.svg)](CONTRIBUTING.md)

Sistema administrativo y punto de venta **libre y autohospedado** para comercios en Venezuela: corre en una PC del negocio y se usa desde el navegador de esa PC, de otras computadoras o de los celulares de la misma red. Funciona sin internet y los datos quedan en tu equipo. Plan completo en [PLAN.md](PLAN.md).

> Estado: **en desarrollo, todavía sin versión publicada**. La fase 1 (MVP bodega/tienda) está completa en el código y la fase 2 (paridad de gestión) está en curso. Aún no se ha probado en un negocio real: falta el piloto.

**Contenido:** [Qué hace hoy](#qué-hace-hoy) · [Qué falta](#qué-falta) · [Probarlo](#probarlo) · [Usuarios](#usuarios-y-contraseñas) · [App de escritorio](#app-de-escritorio-windows) · [Desarrollo](#desarrollo) · [Configuración](#configuración-variables-de-entorno) · [Contribuir](#contribuir) · [Seguridad](#seguridad)

Cada comercio configura lo suyo desde la aplicación: nombre, RIF, dirección, teléfono y mensaje del recibo; condición ante el SENIAT (ordinario, especial con IGTF o sin IVA); si los precios incluyen el IVA (por defecto sí, como en vitrina); alícuotas; usuarios y roles (dueño, administrador, cajero, almacenista).

## Qué hace hoy

- **Caja:** búsqueda y lector de códigos sin tocar el teclado, categorías, pagos mixtos en dólares y bolívares, vuelto en otra moneda o método, descuentos por producto o por toda la venta (con permiso), IVA e IGTF, ventas en espera, recibo e impresión automática.
- **Turnos:** apertura, ingresos y retiros de efectivo, y cierre con arqueo por billete y reporte de diferencias.
- **Productos y compras:** categorías, existencia, existencia mínima con aviso, ajustes y compras a proveedores.
- **Ventas:** historial, recibo, anulación con documento de reverso y devolución parcial: el cliente devuelve parte de lo que llevó y se le reembolsa el dinero o se descuenta de lo que debe.
- **Fiado:** se deja a deber el resto de una venta a un cliente registrado, con días para pagar y límite de deuda por cliente. La deuda va en dólares aunque la factura sea en bolívares. Hay una pantalla con lo que debe cada cliente, su estado de cuenta y el cobro de abonos (en cualquier método y moneda), con recordatorio por WhatsApp. Se puede desactivar en Ajustes.
- **Gastos:** alquiler, luz, sueldos, fletes… con categorías que cada comercio edita; el dinero sale de la cuenta con la que se paga y se puede anular. Los que se repiten (alquiler, internet) se avisan al vencer o se registran solos a deber.
- **Informes:** resultados con la utilidad (ventas, costo, gastos, pérdidas y comisiones), ventas por día, producto, método y vendedor, inventario valorado y finanzas; se exportan a Excel y se imprimen o guardan como PDF.
- **Inventario:** los ajustes de existencia llevan un motivo editable (merma, vencido, uso interno, conteos…) y se ve lo que costó la mercancía que salió.
- **Cuentas:** el efectivo, los bancos, el pago móvil y las billeteras con lo que hay en cada una; se crean nuevas y se transfiere dinero entre ellas (con cambio de moneda si hace falta). Cada método de pago puede llevar la comisión que descuenta el banco o el punto de venta: la cuenta recibe el cobro menos la comisión.
- **Por pagar:** compras y gastos que se dejan a deber a un proveedor, con su fecha límite, pagos parciales o totales, y la antigüedad de saldos (también en el fiado).
- **Contactos:** clientes y proveedores con cédula o RIF.
- **Inicio:** resumen del día, productos con existencia baja y el cierre del día en texto, para copiar o mandar por WhatsApp.
- **Tasa del BCV** automática, con carga manual e historial.
- **Respaldos** diarios y manuales, con descarga y restauración.
- **Impresora térmica** de 58 u 80 mm y gaveta de dinero.
- **App de escritorio** para Windows con instalador, y uso desde celulares y otras PC de la red local.
- **Usuarios** con roles y contraseñas: cambiar la propia, restablecimiento por el dueño y recuperación desde el servidor.
- **Seguridad:** PIN de cajero para bloquear la pantalla a mano o por inactividad, lista de sesiones abiertas (cada quien cierra las suyas, el dueño las de todos) y bitácora de lo que se hace en el sistema, con filtros.

## Qué falta

Antes de un piloto: probar con una impresora térmica real y con una USB compartida, y firmar el instalador. Pendiente aparte: cambio rápido de cajero y aprobación de supervisor con PIN, y devoluciones a proveedores.

En la fase 2 siguen: cambio masivo de precios, listas de precios y recargos de venta, cotizaciones, importación desde Excel, funciones activables por tipo de negocio, pendientes manuales de cobro y pago, y la comparación y el libro de ventas en los informes. Después, varias ubicaciones, lotes, cámara, y luego restaurante y ropa. El detalle, con la comparación contra Wink POS, está en [PLAN.md](PLAN.md#avance-al-15-de-octubre-de-2026).

## Requisitos

[Bun](https://bun.sh) 1.3+. Para compilar la app de escritorio: Rust (ver más abajo).

## Probarlo

```sh
bun install
bun run start        # compila la web y abre el servidor en http://localhost:3000
```

Abre <http://localhost:3000>: la primera vez sale el asistente para crear el negocio y tu usuario. Los datos quedan en `./data` (bórrala para empezar de cero).

**Desde el celular o de otra PC de la misma red:** al arrancar, el servidor muestra la dirección («Desde la red local: http://192.168.x.x:3000»). Si no carga:

- En Windows, permite el puerto en el firewall (PowerShell como administrador):
  `New-NetFirewallRule -DisplayName "Millhiore WINK POS (3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private`
- La red de la PC debe estar como **privada**.
- Si usas una VPN en la PC, activa la opción de permitir conexiones de la red local (LAN).

**Impresora térmica y gaveta:** en Ajustes → Impresora. Puede ser una impresora de red, una USB compartida en Windows o el diálogo del navegador. Detalles en [docs/impresion.md](docs/impresion.md).

## Usuarios y contraseñas

Cada persona entra con su usuario y su contraseña, y lo que puede hacer depende de su rol: dueño, administrador, cajero o almacenista. Los usuarios se crean en **Ajustes → Usuarios**. Cada quien cambia su contraseña con el ícono de la llave; el dueño puede darle una temporal a otra persona; y si nadie recuerda la del dueño, se recupera desde la PC donde corre el servidor:

```sh
bun run reset-password            # lista los usuarios
bun run reset-password duena      # da una contraseña temporal a «duena»
```

Los pasos completos, las protecciones y las reglas de seguridad están en [docs/usuarios-y-contrasenas.md](docs/usuarios-y-contrasenas.md).

## App de escritorio (Windows)

Un instalador que trae todo: el servidor, la base y la ventana de la caja. No hace falta instalar Bun. Los datos quedan en `%APPDATA%\com.millhiore.wink\data`, y la ubicación exacta se ve en Ajustes → Respaldos. Los celulares de la red entran igual, por la IP de la PC.

Para compilarlo hacen falta [Rust](https://rustup.rs) y WebView2 (ya viene en Windows 10/11):

```sh
cd apps/desktop
bun run desktop:build   # compila la web y el servidor (bun build --compile) y arma el instalador NSIS
```

El instalador queda en `apps/desktop/src-tauri/target/release/bundle/nsis/`.

## Desarrollo

```sh
bun run dev          # servidor (3000) + web con recarga en caliente (http://localhost:5173)
bun run ci           # Biome + tsc + tests + compilación de la web
```

La documentación interactiva de la API queda en `http://localhost:3000/api/docs` (la carga de Scalar usa un CDN: necesita internet) y la especificación en `/api/openapi.json`.

Primer uso: `POST /api/setup` crea el negocio, la caja, las cuentas, los roles y el usuario dueño (una sola vez). Luego se entra con `POST /api/auth/sign-in/username`.

Impuestos: IVA por alícuota (16 %, 8 %, 31 %, exento) e IGTF del 3 % para sujetos pasivos especiales, todo configurable (`/api/settings/fiscal`, `/api/taxes`, `/api/surcharges`). Reglas, fuentes y lo pendiente de validar en [docs/fiscal-venezuela.md](docs/fiscal-venezuela.md).

## Configuración (variables de entorno)

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `DATA_DIR` | `./data` | Base SQLite, respaldos y secreto de sesión |
| `BASE_URL` | `http://localhost:PORT` | URL pública |
| `TRUSTED_ORIGINS` | redes locales privadas | Orígenes extra permitidos, separados por coma |
| `AUTH_SECRET` | se genera en `DATA_DIR/auth.secret` | Secreto de sesiones (≥ 32 caracteres) |
| `TRUST_PROXY` | `false` | `true` si hay un proxy de confianza delante (Tailscale, Cloudflare Tunnel) |
| `BACKUPS_KEEP` | `14` | Respaldos que se conservan de cada tipo |

## Estructura

```
apps/server        API Hono + OpenAPI, Better Auth, motor de contabilización, tareas; sirve la web
apps/web           React + Vite + TanStack: inicio, caja, productos, ventas, compras, contactos y ajustes
apps/desktop       Tauri 2: ventana de la caja + el servidor compilado como sidecar (instalador de Windows)
packages/printing  recibos en texto y ESC/POS (térmicas de 58 y 80 mm, gaveta), sin dependencias
packages/ui        componentes (estilo shadcn/ui) y tokens del tema
packages/domain    reglas puras: dinero, tasas, impuestos, documentos, fechas, permisos
packages/db        esquema Drizzle, migraciones, triggers de inmutabilidad
packages/contracts esquemas Zod compartidos entre servidor y web
packages/bcv       tasa oficial del BCV con fuentes de respaldo (sin dependencias)
```

Migraciones: tras cambiar `packages/db/src/schema`, `bun run db:generate --cwd packages/db`. Si drizzle-kit propone recrear una tabla solo para agregar una columna, conviene escribir la migración a mano con `ALTER TABLE … ADD` (ver `0007_min_stock.sql`).

## Contribuir

Los aportes son bienvenidos: código, pruebas, documentación y, sobre todo, la experiencia de quien atiende un negocio. Empieza por [CONTRIBUTING.md](CONTRIBUTING.md): cómo preparar el entorno, el estilo de código (lo decide Biome), las reglas del dominio y cómo mandar un pull request. Para reportar un error o proponer una idea, abre un issue con la plantilla correspondiente. Al participar aceptas el [código de conducta](CODE_OF_CONDUCT.md).

```sh
bun run format      # arregla el formato
bun run ci          # lo mismo que corre GitHub antes de aceptar un cambio
```

Los cambios visibles para quien usa el sistema se anotan en [CHANGELOG.md](CHANGELOG.md).

## Seguridad

Si encuentras una vulnerabilidad, **no abras un issue público**: sigue [SECURITY.md](SECURITY.md).

## Licencia

[MIT](LICENSE): puedes usarlo en tu negocio, modificarlo y redistribuirlo libremente, también con fines comerciales, conservando el aviso de copyright y la licencia.
