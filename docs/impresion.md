# Impresoras de recibos y gaveta

Se configura en **Ajustes → Impresora**. Hay cuatro modos:

| Modo | Para qué impresora | Imprime desde el celular | Abre la gaveta |
|---|---|---|---|
| Desde el navegador | Cualquiera instalada en la PC (térmica, de tinta, láser) | Solo con una impresora instalada en el celular | No |
| Térmica con red | Térmicas con puerto de red o Wi-Fi (puerto 9100) | Sí | Sí |
| Térmica USB en Windows | Térmica USB en la PC donde corre el servidor, compartida en Windows | Sí | Sí |
| Térmica USB en Linux | Térmica USB en el servidor Linux (`/dev/usb/lp0`) | Sí | Sí |

En los tres modos térmicos, el servidor envía el recibo en ESC/POS, el lenguaje que entienden Epson, Bixolon y la mayoría de las genéricas «POS-58» y «POS-80». Por eso funciona desde cualquier equipo de la red, sin diálogos de impresión. La gaveta va conectada a la impresora (cable RJ11) y se abre con un pulso al imprimir el recibo de una venta cobrada en efectivo. También se abre con el botón **Gaveta** de la caja.

## Térmica con red

1. Imprime la hoja de autoprueba de la impresora (suele ser mantener pulsado FEED al encenderla) para ver su IP.
2. En Ajustes → Impresora elige «Impresora térmica con red», escribe la IP y deja el puerto 9100.
3. Pulsa **Imprimir prueba** y luego **Guardar**.

Conviene fijar esa IP en el router (reserva DHCP) para que no cambie.

## Térmica USB en Windows

1. Instala el controlador de la impresora y comprueba que imprime una página de prueba de Windows.
2. Configuración → Bluetooth y dispositivos → Impresoras → tu térmica → Propiedades de impresora → **Compartir**. Marca «Compartir esta impresora» y ponle un nombre corto sin espacios, por ejemplo `POS80`.
3. En Ajustes → Impresora elige «Impresora térmica USB en la PC del servidor (Windows)» y escribe `POS80`. Deja «Equipo» vacío si la impresora está en la misma PC del servidor.
4. **Imprimir prueba** y **Guardar**.

## Desde el navegador

Se abre el diálogo de impresión: elige la impresora y el tamaño de papel. Para imprimir directo, sin diálogo:

- abre Chrome en la caja con la opción `--kiosk-printing` (en el acceso directo, después de `chrome.exe`);
- deja la térmica como impresora predeterminada de Windows.

## Si los acentos salen mal

Se usa la página de códigos PC850, que traen casi todas las térmicas. Si alguna imprime símbolos raros en lugar de «á» o «ñ», busca en su manual cómo activar PC850 o CP850. Normalmente se hace con la utilidad del fabricante o manteniendo un botón al encenderla.
