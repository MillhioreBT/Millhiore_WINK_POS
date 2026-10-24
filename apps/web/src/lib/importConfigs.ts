import type { ImportConfig } from "../components/ImportDialog"

/** Columnas de la importación de productos y cómo se pueden llamar en el Excel del comercio. */
export const productImport: ImportConfig = {
  title: "Importar productos",
  description:
    "Desde un Excel o CSV con una fila por producto. Primero se revisa cada fila y después se importan las válidas. La existencia se suma como «Entrada de mercancía».",
  endpoint: "/api/import/products",
  template: {
    file: "plantilla-productos.xlsx",
    sheet: "Productos",
    examples: [
      [
        "Harina PAN 1 kg",
        1.3,
        "USD",
        "",
        "7591002100059",
        "Víveres",
        "Exento",
        1,
        24,
        6,
        "Producto",
      ],
      ["Refresco 2 L", 2.5, "USD", "REF2", "", "Bebidas", "G", 1.8, 12, 4, "Producto"],
      ["Queso blanco kg", 250, "Bs", "", "", "Charcutería", "", "", 3.5, 1, "Producto"],
      ["Recarga telefónica", 1, "USD", "", "", "", "", "", "", "", "Servicio"],
    ],
  },
  fields: [
    {
      key: "name",
      label: "Nombre",
      synonyms: ["producto", "descripcion", "articulo"],
      required: true,
      width: 28,
    },
    {
      key: "price",
      label: "Precio",
      synonyms: ["precio de venta", "pvp", "precio venta", "precio detal"],
      required: true,
      width: 10,
    },
    { key: "currency", label: "Moneda", synonyms: ["divisa"], width: 8 },
    { key: "sku", label: "SKU", synonyms: ["codigo interno", "referencia", "ref"], width: 12 },
    {
      key: "barcode",
      label: "Código de barras",
      synonyms: ["barras", "ean", "codigo", "barcode"],
      width: 18,
    },
    {
      key: "category",
      label: "Categoría",
      synonyms: ["departamento", "rubro", "familia", "grupo"],
      width: 16,
    },
    { key: "tax", label: "IVA", synonyms: ["impuesto", "alicuota"], width: 8 },
    { key: "cost", label: "Costo", synonyms: ["precio de costo", "costo unitario"], width: 10 },
    { key: "stock", label: "Existencia", synonyms: ["stock", "cantidad", "inventario"], width: 11 },
    {
      key: "minStock",
      label: "Existencia mínima",
      synonyms: ["minimo", "stock minimo", "existencia minima"],
      width: 17,
    },
    { key: "kind", label: "Tipo", synonyms: ["producto o servicio"], width: 10 },
  ],
  invalidate: ["products", "categories", "bootstrap", "reports"],
  existingHint:
    "Se reconocen por el SKU o el código de barras. Si no lo marcas, esas filas se omiten.",
}

/** Columnas de la importación de clientes y proveedores. */
export const contactImport: ImportConfig = {
  title: "Importar clientes y proveedores",
  description:
    "Desde un Excel o CSV con una fila por contacto. Primero se revisa cada fila y después se importan las válidas. El saldo pendiente (en la moneda de referencia) queda en Fiado o en Por pagar.",
  endpoint: "/api/import/contacts",
  template: {
    file: "plantilla-contactos.xlsx",
    sheet: "Contactos",
    examples: [
      ["María Pérez", "Cliente", "V-12345678", "0414-1234567", "", "Av. Bolívar", 15, 50, "", 12.5],
      [
        "Distribuidora El Sol",
        "Proveedor",
        "J-12345678-9",
        "0241-5550000",
        "ventas@elsol.com",
        "",
        30,
        "",
        "Entrega los martes",
        "",
      ],
    ],
  },
  fields: [
    {
      key: "name",
      label: "Nombre",
      synonyms: ["razon social", "cliente", "proveedor", "nombre y apellido"],
      required: true,
      width: 26,
    },
    { key: "kind", label: "Tipo", synonyms: ["cliente o proveedor"], width: 11 },
    {
      key: "taxId",
      label: "Cédula o RIF",
      synonyms: ["cedula", "rif", "ci", "documento", "cedula rif"],
      width: 15,
    },
    {
      key: "phone",
      label: "Teléfono",
      synonyms: ["celular", "tlf", "telf", "whatsapp", "movil"],
      width: 14,
    },
    {
      key: "email",
      label: "Correo",
      synonyms: ["email", "e mail", "correo electronico"],
      width: 22,
    },
    { key: "address", label: "Dirección", synonyms: ["domicilio"], width: 24 },
    { key: "creditDays", label: "Días de crédito", synonyms: ["plazo", "dias"], width: 14 },
    { key: "creditLimit", label: "Límite de crédito", synonyms: ["limite", "credito"], width: 16 },
    { key: "notes", label: "Notas", synonyms: ["observaciones", "nota"], width: 24 },
    {
      key: "balance",
      label: "Saldo pendiente",
      synonyms: ["saldo", "deuda", "saldo anterior", "por cobrar", "por pagar"],
      width: 16,
    },
  ],
  invalidate: ["contacts", "receivables", "payables", "documents"],
  existingHint: "Se reconocen por la cédula o el RIF. Si no lo marcas, esas filas se omiten.",
}
