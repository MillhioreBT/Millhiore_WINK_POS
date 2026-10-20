-- Cuentas por pagar: las compras y los gastos pueden quedar a deber y se pagan con un documento
-- `PAYMENT_OUT` que reparte su total entre las facturas (la tabla `allocation` ya lo permite: su
-- columna `sale_document_id` es la venta que paga un abono, o la compra o gasto que paga un pago).
-- Los roles de fábrica ya creados reciben el permiso nuevo: dueño y administrador.
UPDATE role SET permissions = json_insert(permissions, '$[#]', 'payable.manage')
WHERE id IN ('owner', 'manager')
  AND NOT EXISTS (SELECT 1 FROM json_each(role.permissions) WHERE value = 'payable.manage');
