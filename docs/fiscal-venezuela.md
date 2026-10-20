# IVA e IGTF en Millhiore WINK POS

Cómo calcula el sistema los impuestos de una venta en Venezuela, qué reglas siguió y qué falta validar con un contador. Investigado el 14-oct-2026. Ninguna fuente consultada es la Gaceta Oficial: son firmas tributarias y guías comerciales, citadas al final.

## Lo que dice la normativa (según las fuentes)

**IVA**
- Alícuota general 16 %, reducida 8 % y general más adicional de 15 % para bienes y servicios de lujo (31 %). Los bienes exentos o exonerados van al 0 %.
- En abril de 2026 circuló un supuesto aumento al 25 %. Era falso: cambiar la alícuota exige reformar la ley, y el SENIAT lo desmintió.
- Si la operación es en divisas, la base se convierte a bolívares con la tasa del BCV. El IVA se calcula sobre la base en bolívares, y la factura muestra el monto en divisas, la tasa y el equivalente en Bs.

**IGTF**
- 3 % sobre los pagos en divisas o criptoactivos que no pasan por la banca nacional, como efectivo en dólares, Zelle o USDT. Los pagos en bolívares no lo llevan: efectivo, pago móvil, punto de venta y transferencias.
- Lo cobran solo los **sujetos pasivos especiales**, designados agentes de percepción por la Providencia SNAT/2022/000013 (G.O. 42.339). Un contribuyente ordinario no lo cobra.
- Se percibe el mismo día del pago y no forma parte de la base del IVA. La factura lo muestra aparte, después del total.
- En un pago mixto solo grava la parte pagada en divisas.

**Facturación**
- En agosto de 2026, la Providencia SNAT/2026/00084 (G.O. 43.435) derogó la que exigía software de facturación homologado (SNAT/2024/000121). Todavía no hay un régimen que la reemplace.
- La obligación de emitir factura sigue vigente. El recibo de este sistema **no es una factura fiscal**: eso le toca al adaptador fiscal de la fase 5.

## Cómo lo modela el sistema

Todo es configurable, nada está fijo en el código (PLAN.md §16).

| Pieza | Dónde | Por defecto |
|---|---|---|
| Alícuotas de IVA | tabla `tax`; `PATCH /api/taxes/{id}` | G 16 %, R 8 %, A 31 %, E exento |
| IVA de cada producto | `product.tax_id` | si falta, el impuesto por defecto (`iva-general`) |
| Condición fiscal | `PUT /api/settings/fiscal` → `taxpayer` | `ordinary` (cobra IVA, no IGTF) |
| Precios con IVA incluido | `pricesIncludeTax` | sí en ventas (precio de vitrina); no en compras |
| IGTF | tabla `surcharge`, ligado a cada método de cobro | 3 %; se activa solo si el negocio es `special` |

El documento guarda la alícuota que aplicó cada línea y el desglose por alícuota (`document_tax`) y por recargo (`document_surcharge`), todos inmutables. Si mañana cambia una alícuota, las ventas ya hechas no cambian.

### Reglas de cálculo

1. **IVA por alícuota, no por línea**, como el libro de ventas.
   - Con precio incluido, la base sale de dividir: 11,60 → 10,00 + 1,60. El total nunca se mueve un céntimo.
   - Sin precio incluido, el IVA sale de multiplicar.
   - Redondeo: mitad hacia arriba, a céntimos.
2. **IVA en bolívares calculado en bolívares.** Se convierte el monto de cada alícuota y se vuelve a separar en Bs; no se convierte el IVA ya redondeado en dólares. A 879 Bs/$, un céntimo de dólar son casi 9 Bs: convertir el IVA ya redondeado descuadraría la factura.
3. **Base del IGTF** = la parte del total cubierta con pagos en divisas.
   - Los pagos en bolívares cubren primero, así el cliente paga el mínimo.
   - El vuelto no cambia la base. Si paga 20,45 $ una cuenta de 15,00 $ + 0,45 $ de IGTF y recibe el cambio en Bs, el IGTF es sobre 15,00 $.
   - El IGTF no se cobra sobre sí mismo.
4. **La base del IGTF incluye el IVA** cuando el cliente paga el total en divisas. Gálac lo calcula así (116 → 3,48); otros lo calculan sin IVA. No hay aclaración oficial.
5. Las compras no llevan IGTF: lo percibe quien vende. Quien no cobra IVA (`taxpayer: none`) vende sin impuesto, pero sus compras sí lo traen.

## Pendiente de validar con un contador

- Base del IGTF con o sin IVA (regla 4). Si cambia, hace falta una opción más.
- Retenciones de IVA (75 % o 100 %) e ISLR que practican los sujetos pasivos especiales en sus compras. Aún no están modeladas y entran con cuentas por pagar.
- Exenciones vigentes por producto. El sistema trae "Exento", pero cada negocio decide qué productos lo llevan.
- Requisitos de la factura fiscal y del libro de ventas (fase 5), según el régimen que sustituya a la SNAT/2024/000121.

## Fuentes

- Gálac, *Reforma del IGTF: algunos casos prácticos*: <https://galac.com/galac-blog/reforma-del-igtf-algunos-casos-practicos/>
- Forvis Mazars, *Designación de los SPE como agentes de percepción del IGTF*: <https://www.forvismazars.com/ve/es/insights/forvis-mazars-insights/designacion-de-los-spe>
- Bodegazo, *IVA e IGTF en Venezuela* (jun. 2026): <https://bodegazo.com/blog/iva-igtf-facturacion-venezuela>
- Alegra, *Cómo facturar en divisas en Venezuela* (jun. 2026): <https://blog.alegra.com/venezuela/como-facturar-en-divisas-en-venezuela-tasa-bcv/>
- Descifrado, *Seniat desmiente ajuste de 25 % al IVA* (may. 2026): <https://www.descifrado.com/2026/05/02/seniat-desmiente-ajuste-de-25-al-iva-para-financiar-defensa-legal-de-nicolas-maduro/>
- IVA Calculator, *Tasas de IVA en Venezuela: 8 %, 16 % y 31 %*: <https://ivacalculator.com/venezuela/tasas-iva-8-16-31/>
- Finanzas Digital, *Seniat deroga norma sobre proveedores de sistemas fiscales* (ago. 2026): <https://finanzasdigital.com/seniat-deroga-norma-sobre-proveedores-de-sistemas-fiscales/>
- Gescosoftware, *Providencia SNAT/2026/00084*: <https://www.gescosoftware.com/conoce-los-detalles-de-la-nueva-providencia-snat-2026-00084-en-venezuela/>
