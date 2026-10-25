# Plugins

Un plugin agrega funciones a Millhiore WINK POS sin tocar su código: recibe eventos (cada venta, cada anulación…), llama a la API, guarda sus propios datos, corre tareas cada cierto tiempo y puede traer una pantalla que aparece en el menú.

Se instala en **Ajustes → Integraciones → Plugins → Instalar plugin**, subiendo su `.zip`. Antes de instalarlo se ve qué permisos pide, qué eventos recibe y a qué equipos de internet se conecta. Se apaga o se desinstala desde la misma tarjeta, sin reiniciar el servidor.

El ejemplo completo está en [`examples/plugins/ventas-del-dia`](../examples/plugins/ventas-del-dia).

## Seguridad: qué puede y qué no

- **El código del servidor corre aislado**, en QuickJS compilado a WebAssembly. No ve archivos, ni la base de datos, ni el proceso, ni internet: solo el objeto `millhiore`. Cada llamada tiene tope de memoria (32 MB) y de CPU (2 s seguidos), y una espera máxima de 15 s.
- **La API, con los permisos que pide** (los mismos de una clave de la API: nunca manejar usuarios ni ajustes) y que todavía tenga **quien lo instaló**. Lo que registra queda a nombre de esa persona. No llega a `/api/me`, `/api/sessions`, `/api/users`, `/api/api-keys` ni a otros plugins.
- **Internet, solo por HTTPS y solo a los equipos que declara** en `network`. Las redirecciones no se siguen.
- **Su pantalla corre en un marco aislado** (`sandbox`): no tiene la sesión de la app, ni su almacenamiento, ni puede llamar a ningún servidor (`connect-src 'none'`). Habla con la app solo por mensajes (el SDK). La app hace cada llamada con la sesión de quien la usa, y el servidor le da **lo que pide el plugin y la persona tiene**, nunca más.

Instala solo plugins de quien confíes: con sus permisos, un plugin puede ver y registrar lo que esos permisos dejan.

## El paquete

Un `.zip` con `manifest.json` en la raíz (o dentro de una sola carpeta), hasta 5 MB.

```json
{
  "id": "ventas-del-dia",
  "name": "Ventas del día",
  "version": "1.0.0",
  "description": "Cuenta las ventas desde que se instaló.",
  "author": "Tu nombre",
  "permissions": ["report.view"],
  "events": ["sale.posted"],
  "network": ["api.ejemplo.com"],
  "server": "server.js",
  "page": { "title": "Ventas del día", "entry": "index.html" }
}
```

| Campo | Para qué |
|---|---|
| `id` | Minúsculas, números y guiones (3 a 40). Si se sube otro `.zip` con el mismo `id`, se actualiza. |
| `version` | `1.0.0`. |
| `permissions` | Los permisos de la API que usa: `sale.create`, `inventory.view`, `report.view`, `cost.view`… (todos menos `user.manage` y `settings.manage`). |
| `events` | Los que recibe: `sale.posted`, `document.posted`, `document.voided`, `shift.opened`, `shift.closed`, `rate.updated`, `order.created`. |
| `network` | Los dominios a los que llama con `millhiore.fetch` (sin `https://`). |
| `server` | El código que corre en el servidor (opcional). |
| `page` | Su pantalla en el menú: el título y el archivo HTML (opcional). |

Al menos uno de `server` o `page`.

## El código del servidor

Un archivo JavaScript (sin `import`) que usa el objeto global `millhiore`:

```js
// Cada evento llega con lo mismo que un webhook: en los documentos, el documento completo.
millhiore.on("sale.posted", async (sale) => {
  const n = (await millhiore.storage.get("ventas")) ?? 0
  await millhiore.storage.set("ventas", n + 1)
  millhiore.log(`Venta ${sale.number}`)
})

// Una ruta propia, que su pantalla llama con millhiore.route("GET", "/resumen").
millhiore.route("GET", "/resumen", async (req) => {
  // req: { method, path, query, body, user: { id, name, permissions } }
  const day = await millhiore.api("GET", "/api/reports/day")
  return { status: 200, body: { ventas: day.body.sales.count } }
})

// Una tarea cada 60 minutos (como mínimo, cada minuto).
millhiore.every(60, async () => {
  const r = await millhiore.fetch("https://api.ejemplo.com/hola")
  millhiore.log(r.status, r.body)
})
```

| Función | Qué hace |
|---|---|
| `millhiore.on(evento, fn)` | Recibe el evento. Si `fn` falla, se reintenta al minuto, a los 5, 30 y 120 minutos; después se da por fallido. Cada evento trae su `id` en el `outbox`: úsalo para no procesarlo dos veces. |
| `millhiore.route(método, ruta, fn)` | Responde en `/api/plugins/<id>/run<ruta>`, solo para su pantalla o su propio código. `fn` devuelve `{ status, body }`. Recibe quién la usa (`req.user`), para decidir qué mostrarle. |
| `millhiore.every(minutos, fn)` | Una tarea cada tantos minutos (mientras el servidor esté prendido). |
| `millhiore.api(método, ruta, cuerpo)` | Llama a la API de la app. Devuelve `{ status, body }`. |
| `millhiore.fetch(url, { method, headers, body })` | Llama a internet (solo a `network`). Devuelve `{ status, headers, body }` con el cuerpo como texto (hasta 1 MB). |
| `millhiore.storage.get / set / delete / keys` | Sus propios datos (hasta 1000 claves de 64 KB). Se borran al desinstalarlo. |
| `millhiore.log(...)`, `millhiore.error(...)`, `console.log` | Su registro, que se ve en Ajustes (los últimos 200 mensajes). |

## La pantalla

Un HTML con sus scripts y estilos dentro del paquete. Carga el SDK desde la app:

```html
<script src="/plugins/sdk.js"></script>
<script src="app.js"></script>
```

```js
const info = await millhiore.ready // { pluginId, user: { id, name }, theme: "light" | "dark", business }
const datos = await millhiore.route("GET", "/resumen")
const productos = await millhiore.api("GET", "/api/products")
```

`millhiore.api` y `millhiore.route` devuelven el cuerpo de la respuesta o fallan con un `Error` que trae `status` y `code`. El SDK pone la clase `dark` en `<html>` cuando la app está en modo oscuro.

Los archivos se sirven en `/plugins/<id>/…` con una política de seguridad que solo deja cargar lo del propio paquete: imágenes y fuentes van dentro del `.zip`.

## Probarlo

Comprime la carpeta del plugin (con el `manifest.json` adentro) e instálalo en Ajustes → Integraciones. El registro del plugin (botón «Registro») muestra lo que va haciendo y sus errores; el último error también se ve en la tarjeta.
