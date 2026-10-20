CREATE TABLE `stock_reason` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_reason_name_unique` ON `stock_reason` (`name`);--> statement-breakpoint
ALTER TABLE `document` ADD `stock_reason_id` text REFERENCES stock_reason(id);--> statement-breakpoint
CREATE INDEX `document_stock_reason` ON `document` (`stock_reason_id`);--> statement-breakpoint
ALTER TABLE `document_line` ADD `cost_minor` integer;--> statement-breakpoint
ALTER TABLE `document_line` ADD `cost_currency` text REFERENCES currency(code);--> statement-breakpoint
-- Motivos de fábrica: cada comercio los cambia, quita o agrega desde la aplicación.
INSERT INTO stock_reason (id, name, direction, position, active) VALUES
  ('stk-in-goods', 'Entrada de mercancía', 'in', 1, 1),
  ('stk-in-count', 'Sobrante de conteo', 'in', 2, 1),
  ('stk-in-other', 'Otra entrada', 'in', 3, 1),
  ('stk-out-waste', 'Merma o daño', 'out', 4, 1),
  ('stk-out-expired', 'Vencido', 'out', 5, 1),
  ('stk-out-internal', 'Uso interno', 'out', 6, 1),
  ('stk-out-theft', 'Robo o pérdida', 'out', 7, 1),
  ('stk-out-count', 'Faltante de conteo', 'out', 8, 1),
  ('stk-out-other', 'Otra salida', 'out', 9, 1);
