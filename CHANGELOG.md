# Historial de cambios

Todos los cambios importantes de Millhiore WINK POS se anotan aquí. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usará [Versionado Semántico](https://semver.org/lang/es/) desde la primera versión publicada.

## [Sin publicar]

Todavía no hay una versión publicada. El proyecto está en desarrollo: las fases 1 (MVP para bodega o tienda) y 2 (paridad de gestión) están completas en el código, y la fase 3 (ropa y restaurante) también. El detalle, con lo hecho y lo que falta, está en [PLAN.md](PLAN.md#avance-al-24-de-octubre-de-2026).

### Agregado

- Caja con pagos mixtos en dólares y bolívares, vuelto en otra moneda o método, descuentos, IVA, IGTF y ventas en espera.
- Turnos con arqueo por billete, ingresos y retiros de efectivo.
- Productos, categorías, compras, ajustes de existencia con motivo y existencia mínima.
- Fiado con abonos, días de crédito, límite de deuda y recordatorio por WhatsApp.
- Devolución parcial de ventas y anulación con documento de reverso.
- Gastos (también recurrentes), cuentas por pagar con antigüedad de saldos, cuentas y transferencias, y comisión por método de pago.
- Informes de resultados, ventas (también por categoría), inventario, finanzas y libro de ventas y compras con IVA, comparados con el período anterior, con exportación a Excel e impresión o PDF, y cierre del mes para WhatsApp.
- Cotizaciones, listas de precios, recargos de venta (delivery, servicio) y cambio masivo de precios.
- Importación de productos, clientes y proveedores desde Excel o CSV, con vista previa fila por fila y saldos iniciales.
- Deudas anotadas a mano en Fiado y Por pagar (saldos de antes y préstamos).
- Funciones que cada comercio enciende o apaga según su tipo de negocio, y guía «para arrancar» en Inicio.
- Varias ubicaciones (tienda, depósito, cocina) y varias cajas, cada una con su turno y su gaveta; compras y ajustes por ubicación y traslados entre ubicaciones.
- Lotes con fecha de vencimiento: salida automática del que vence primero, pantalla de vencimientos con avisos y baja de lo vencido.
- Escaneo de códigos con la cámara del celular (caja, productos, compras, traslados) y conteo físico desde el celular.
- Códigos de descuento (porcentaje o monto, usos máximos y vigencia) que aplica cualquier cajero.
- Devoluciones a proveedores, con reembolso o descontadas de lo que se le debe.
- Exposición cambiaria de las cuentas en bolívares.
- Tallas, colores u otras características (hasta tres), cada combinación con su código, su precio y su existencia, con cuadrícula en la caja y en las compras.
- Etiquetas con código de barras (EAN o Code 128) en rollo o en hojas adhesivas carta y A4.
- Salas y mesas con cuentas abiertas: pedido con indicaciones, pasar o juntar mesas, precuenta y cobro total, por productos o a partes iguales; rol de mesonero.
- Opciones y extras al vender (término, tamaño, queso extra con su precio) e indicaciones para la cocina, en la caja y en las mesas.
- Comandas a cocina: estaciones (cocina, barra) por categoría, cada una con su impresora térmica o en la pantalla de cocina con tiempos de espera; rol de cocina.
- Recetas con merma: al vender un plato se descuentan sus ingredientes del inventario y la venta toma su costo real.
- Producción por tandas (salsas, panes, tortas): gasta los ingredientes de la receta, suma lo producido con su lote y le deja el costo de la receta.
- Propina al cobrar (en % o monto, en Bs o divisas), para un mesonero o para el equipo, fuera de la venta, con su total en el cierre del turno y un informe por mesonero.
- Tasa del BCV automática, con fuentes de respaldo, carga manual e historial.
- Usuarios con roles, PIN de cajero, sesiones activas y bitácora.
- Respaldos automáticos y manuales, con descarga y restauración.
- Impresión térmica ESC/POS de 58 y 80 mm y gaveta de dinero.
- App de escritorio con instalador para Windows (Tauri 2).
- API REST documentada con OpenAPI en `/api/docs`.
- Archivos de comunidad: guía para contribuir, código de conducta, política de seguridad y plantillas de issues y pull requests.

### Seguridad

- Se exige Bun 1.4.4 o más nuevo: las versiones anteriores tienen fallos corregidos en octubre de 2026 (descompresión Brotli, certificados raíz comprometidos, HTTP/3). El instalador no se compila con un Bun vulnerable y el servidor avisa al arrancar.
