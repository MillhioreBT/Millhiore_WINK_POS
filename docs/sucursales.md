# Sucursales con servidor propio

Una sucursal puede vender contra el servidor del local principal (Ajustes → Negocio → Sucursales) o
tener **su propio servidor**: una PC en la sucursal con la app instalada, que vende aunque se corte
internet y se sincroniza sola con el **central** (el servidor del dueño).

## Qué va en cada dirección

**Del central a la sucursal** (cada 30 segundos, solo si cambió):

- el negocio, las sucursales, las ubicaciones y las cajas;
- el catálogo: productos, variantes, categorías, listas de precios, recargos, descuentos, opciones y
  extras, y recetas;
- los impuestos, las cuentas, los métodos de cobro, los motivos de inventario y las categorías de
  gastos;
- los clientes y proveedores;
- los usuarios, sus roles, sus contraseñas y sus PIN, y dónde trabaja cada quien;
- la tasa de cambio de los últimos tres meses;
- los ajustes del negocio (fiscales, de caja, de fiado, de inventario, de seguridad, del recibo, de
  las etiquetas y las funciones encendidas).

**De la sucursal al central:**

- todo lo que se registra en sus cajas: ventas, devoluciones, anulaciones, compras, ajustes,
  traslados, gastos, abonos, producción;
- sus turnos de caja (abiertos y cerrados) con su arqueo;
- los clientes nuevos que se crean allá;
- la bitácora;
- los eventos de ventas y turnos, para que los webhooks, Telegram y los plugins del central se
  enteren.

**Del central a la sucursal, además:** su historia de antes de tener servidor propio (lo vendido en
sus cajas) y la mercancía que otras sucursales le trasladan.

La sucursal ve solo lo suyo. El central lo ve todo: inventario, ventas, turnos e informes de cada
sucursal, igual que si vendieran contra él.

## Cómo se conecta

1. Las dos PC tienen [Tailscale](https://tailscale.com/download) encendido con la misma cuenta
   (Ajustes → Equipos → Acceso remoto). Tailscale cifra la conexión y no hay que abrir puertos.
2. En el central, crea la sucursal (Ajustes → Negocio → Sucursales → «Nueva sucursal») y cierra sus
   turnos abiertos.
3. Toca el botón del servidor junto a la sucursal → «Crear código». El código vale una hora y sirve
   una sola vez; la ventana muestra también la dirección del central.
4. En la PC de la sucursal, instala la app. En el asistente inicial, toca «Unir esta PC como
   sucursal» y escribe la dirección del central y el código.
5. Entra con tu usuario del central.

Desde ese momento, las cajas de esa sucursal venden allá: el central ya no abre turno ni registra
ventas en ellas. Lo que sí puede hacer el central es trasladarle mercancía.

## Qué se cambia dónde

En la sucursal **no** se cambian el catálogo, los precios, los impuestos, los usuarios, las
contraseñas, los PIN, las cuentas, los métodos de cobro, la tasa ni los ajustes del negocio: todo eso
se cambia en el central y llega solo. Si se intenta, la app lo dice («Esta PC es una sucursal: eso
se cambia en el central y llega aquí solo»).

En la sucursal **sí** se vende, se compra, se ajusta y se traslada inventario, se abren y cierran
turnos, se crean clientes y se configuran los equipos de esa PC: la impresora, la balanza, HTTPS,
Tailscale, los respaldos, los webhooks, Telegram, las claves de la API, los plugins y el catálogo en
línea.

## Estado y problemas

En la sucursal, Ajustes → Equipos → «Sucursal …» muestra el central, cuándo se sincronizó por
última vez, cuántos documentos faltan por subir y el último error. «Sincronizar ahora» no espera a
la próxima vuelta.

En el central, la lista de sucursales marca las que tienen servidor propio y cuándo se supo de cada
una por última vez. Desde el mismo botón se puede **desconectar** una sucursal (su clave deja de
servir; lo ya recibido queda) o conectar otra PC, que reemplaza a la anterior.

Si el central restaura un respaldo anterior, toca «Volver a enviar todo» en cada sucursal: sube de
nuevo todo lo suyo, y lo que el central ya tiene no se repite.

Las dos PC tienen que tener **la misma versión de la app**. Si no, la sincronización se detiene con
un aviso hasta que se actualicen las dos.

## Límites

- El fiado de una venta de la sucursal se cobra en esa sucursal o en el central (la sucursal no
  tiene las ventas de las demás).
- Los saldos de las cuentas de dinero que ve la sucursal son solo los de lo que pasó por ella; los
  completos están en el central.
- Las cotizaciones, las cuentas de mesa, la cocina, los pedidos del catálogo en línea y los plugins
  son de cada servidor.
- El máximo de usos de un código de descuento se cuenta en cada servidor.
- Las fotos de los productos no bajan a la sucursal: el catálogo en línea se publica desde el
  central.
- Al cambiar la contraseña de alguien en el central, las sesiones que tenía abiertas en la sucursal
  siguen hasta que se cierren o venzan.
- Si alguien crea al mismo tiempo, en la sucursal y en el central, un cliente con el mismo RIF, el
  de la sucursal queda sin RIF (con el RIF en sus notas) para no perder sus ventas.
