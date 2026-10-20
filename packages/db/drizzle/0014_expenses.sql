CREATE TABLE `expense_category` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_category_name_unique` ON `expense_category` (`name`);--> statement-breakpoint
ALTER TABLE `document` ADD `expense_category_id` text REFERENCES expense_category(id);--> statement-breakpoint
CREATE INDEX `document_expense_category` ON `document` (`expense_category_id`);
--> statement-breakpoint
-- Categorías de gasto de fábrica: cada comercio las cambia, quita o agrega desde la aplicación.
INSERT INTO expense_category (id, name, position, active) VALUES
  ('exp-alquiler', 'Alquiler', 1, 1),
  ('exp-servicios', 'Servicios (luz, agua, internet, teléfono)', 2, 1),
  ('exp-sueldos', 'Sueldos y comisiones', 3, 1),
  ('exp-transporte', 'Transporte y fletes', 4, 1),
  ('exp-mantenimiento', 'Mantenimiento y reparaciones', 5, 1),
  ('exp-impuestos', 'Impuestos y tasas', 6, 1),
  ('exp-publicidad', 'Publicidad', 7, 1),
  ('exp-limpieza', 'Papelería y limpieza', 8, 1),
  ('exp-otros', 'Otros gastos', 9, 1);
--> statement-breakpoint
-- Los roles de fábrica ya creados reciben el permiso nuevo: dueño y administrador.
UPDATE role SET permissions = json_insert(permissions, '$[#]', 'expense.create')
WHERE id IN ('owner', 'manager')
  AND NOT EXISTS (SELECT 1 FROM json_each(role.permissions) WHERE value = 'expense.create');
