# Cómo contribuir a Millhiore WINK POS

Gracias por querer ayudar. Millhiore WINK POS es un sistema administrativo y punto de venta libre (MIT) para comercios en Venezuela. Cualquier aporte sirve: código, pruebas, documentación, traducciones, reportes de errores y, sobre todo, **experiencia real de quien atiende un negocio**.

Al participar aceptas el [Código de conducta](CODE_OF_CONDUCT.md). Las vulnerabilidades **no** se reportan en un issue público: sigue [SECURITY.md](SECURITY.md).

## Antes de empezar

- Busca si ya existe un [issue](../../issues) o una [discusión](../../discussions) sobre lo mismo.
- Para algo grande (una función nueva, un cambio en el modelo de datos o en cómo se calculan totales e impuestos), **abre primero un issue** y cuéntanos la idea. Evitamos que trabajes semanas en algo que no encaje. El rumbo del proyecto está en [PLAN.md](PLAN.md).
- Para algo pequeño (un error, un texto, una prueba que falta) puedes mandar el PR directo.
- Las reglas fiscales (IVA, IGTF, retenciones, factura) cambian y dependen del tipo de contribuyente. Si tu cambio las toca, cita la norma o la fuente; ver [docs/fiscal-venezuela.md](docs/fiscal-venezuela.md).

## Preparar el entorno

Necesitas [Bun](https://bun.sh) 1.3 o superior y Git. Para la app de escritorio, además, [Rust](https://rustup.rs) y WebView2 (ya viene en Windows 10/11).

```sh
git clone <tu fork>
cd Millhiore_WINK
bun install
bun run dev        # servidor en :3000 y web con recarga en caliente en :5173
```

La primera vez, <http://localhost:5173> muestra el asistente para crear un negocio de prueba. Los datos quedan en `./data` (bórrala para empezar de cero).

`bun install` también activa los ganchos de git de `.githooks/`: antes de cada commit se revisa el formato de lo que preparaste con Biome.

## Estructura

```
apps/server        API Hono, Better Auth, motor de contabilización y tareas
apps/web           React + Vite + TanStack: caja y administración
apps/desktop       Tauri 2: ventana de la caja con el servidor como sidecar
packages/domain    reglas puras: dinero, tasas, impuestos, documentos, permisos
packages/db        esquema Drizzle, migraciones y triggers de inmutabilidad
packages/contracts esquemas Zod compartidos entre servidor y web
packages/printing  recibos de texto y ESC/POS
packages/bcv       tasa oficial del BCV
packages/ui        componentes (estilo shadcn/ui) y tokens del tema
```

`packages/domain` no conoce la base de datos ni HTTP: es lógica pura y es lo más probado del proyecto. Pon ahí las reglas de negocio.

## Estilo de código

No se discute a mano: lo decide **Biome** (`biome.json`) y lo comprueba el CI.

| | |
|---|---|
| Sangría | 2 espacios (4 en Rust) |
| Línea | 100 columnas |
| Comillas | dobles |
| Punto y coma | solo cuando hace falta |
| Finales de línea | LF (`.gitattributes` lo fuerza también en Windows) |
| TypeScript | estricto, con `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes` |
| Rust | `cargo fmt` |

```sh
bun run format     # arregla formato y lo que Biome puede corregir solo
bun run lint       # solo revisa
```

Convenciones:

- **Código en inglés** (nombres, comentarios). **Interfaz y documentación en español**; el inglés llega después.
- Comenta el *porqué*, no el *qué*. Si algo existe por una regla fiscal o por un error ya vivido, dilo.
- Archivos de prueba junto al código: `algo.test.ts`.
- Sin dependencias nuevas si la plataforma ya lo resuelve. Si hace falta una, explica por qué en el PR (peso, licencia compatible con MIT, mantenimiento).

## Reglas del dominio que no se rompen

Estas reglas vienen del [diseño](PLAN.md#3-principios). Un PR que las rompa no se acepta, aunque funcione:

1. **Dinero exacto.** Los montos son enteros (`*_minor`, céntimos) y las tasas decimales de 8 cifras con `big.js`. Nunca `number` con decimales para dinero.
2. **Documento → libro.** Nadie edita una existencia ni un saldo directamente. Todo pasa por un documento que genera movimientos en los libros de inventario y de dinero, dentro de una sola transacción.
3. **Los documentos contabilizados son inmutables.** Un error se corrige con un documento de reverso, nunca con `UPDATE` (hay triggers que lo impiden).
4. **Los permisos se verifican en el servidor.** Esconder un botón en la interfaz no cuenta.
5. **Todo lo propio del negocio es configurable** (nombre, RIF, impuestos, recibo, motivos, categorías). No fijes en el código datos de un comercio ni cifras fiscales.
6. **Funciona sin internet.** Lo que necesite internet debe ser opcional y fallar con gracia.
7. **Pensado para el celular.** Cada pantalla debe verse bien entre 360 y 440 px, sin desplazamiento horizontal, y seguir siendo compacta en escritorio.

## Pruebas

```sh
bun run ci         # lo mismo que corre GitHub: Biome + tsc + pruebas + compilación de la web
bun run test       # solo las pruebas
```

- Todo cambio de comportamiento lleva su prueba. Un error corregido lleva la prueba que lo habría detectado.
- Las pruebas del servidor usan SQLite real en memoria con el arnés de `apps/server/src/testing/harness.ts` (`harness()` y `setUp()`). No simules la base de datos.
- Si tocas el motor de contabilización, las invariantes (`apps/server/src/posting/invariants.ts`) deben seguir en pie.
- Si cambias la interfaz, revísala en el navegador a 360 y 440 px, y en escritorio, antes de pedir la revisión.

## Cambios en la base de datos

1. Edita el esquema en `packages/db/src/schema`.
2. Genera la migración: `bun run db:generate --cwd packages/db`.
3. Revisa el `.sql`. Si drizzle-kit propone recrear una tabla solo para agregar una columna, escribe la migración a mano con `ALTER TABLE … ADD` (ejemplo: `0007_min_stock.sql`).
4. Las tablas de documentos son inmutables: una migración no puede hacerles `UPDATE`.
5. Las migraciones se aplican solas al arrancar el servidor, con un respaldo previo. Nunca edites una migración que ya se publicó: agrega otra.

## Commits y pull requests

**Commits:** seguimos [Conventional Commits](https://www.conventionalcommits.org/es/v1.0.0/), en español o inglés, en imperativo y sin punto final.

```
feat(ventas): permite fiar el resto de una venta
fix(caja): el vuelto en bolívares no redondeaba por moneda
docs: explica cómo recuperar la contraseña del dueño
```

Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`. Un `!` o `BREAKING CHANGE:` marca un cambio que rompe compatibilidad (por ejemplo, de la API).

**Firma (DCO):** en vez de un CLA usamos el [Developer Certificate of Origin](https://developercertificate.org/): al firmar certificas que tienes derecho a aportar ese código bajo la licencia del proyecto. Firma cada commit con `-s`:

```sh
git commit -s -m "fix(caja): corrige el redondeo del vuelto"
```

Eso agrega la línea `Signed-off-by: Tu Nombre <tu@correo>`. Si lo olvidaste: `git commit --amend -s` o, para varios, `git rebase --signoff main`. El CI lo comprueba.

**Pull requests:**

- Una idea por PR, y pequeño: se revisa mejor y se mezcla antes.
- Parte de `main`, en una rama con nombre descriptivo (`feat/cotizaciones`, `fix/redondeo-vuelto`).
- Completa la plantilla del PR. Si hay cambios visibles, adjunta capturas (escritorio y celular).
- El CI debe estar en verde. Si falla algo que no entiendes, pregunta en el PR.
- Se mezcla con *squash* y el título del PR queda como mensaje del commit: que siga Conventional Commits.
- Anota los cambios que vea el usuario en [CHANGELOG.md](CHANGELOG.md), bajo «Sin publicar».

## Documentación

- Lo que ve quien usa el sistema va en español sencillo, sin jerga técnica, y con los pasos exactos.
- Si cambias una variable de entorno, un comando o una pantalla, actualiza el [README](README.md) o la página de `docs/` correspondiente en el mismo PR.
- Si cambias el rumbo o terminas una parte de la hoja de ruta, actualiza [PLAN.md](PLAN.md).

## Licencia

Al contribuir aceptas que tu aporte se publique bajo la [licencia MIT](LICENSE) del proyecto.
