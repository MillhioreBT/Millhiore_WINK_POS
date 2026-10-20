CREATE TABLE `allocation` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_document_id` text NOT NULL,
	`sale_document_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`payment_document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allocation_amount_nonzero" CHECK("allocation"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE INDEX `allocation_payment` ON `allocation` (`payment_document_id`);--> statement-breakpoint
CREATE INDEX `allocation_sale` ON `allocation` (`sale_document_id`);--> statement-breakpoint
ALTER TABLE `contact` ADD `credit_days` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contact` ADD `credit_limit_minor` integer;--> statement-breakpoint
ALTER TABLE `document` ADD `credit_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `credit_currency` text REFERENCES currency(code);--> statement-breakpoint
ALTER TABLE `document` ADD `credit_legal_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `due_at` integer;
--> statement-breakpoint
CREATE TRIGGER allocation_no_update BEFORE UPDATE ON allocation
BEGIN SELECT RAISE(ABORT, 'allocation es inmutable: anule el abono con un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER allocation_no_delete BEFORE DELETE ON allocation
BEGIN SELECT RAISE(ABORT, 'allocation es inmutable: anule el abono con un documento de reverso'); END;
--> statement-breakpoint
-- Los roles de fábrica ya creados reciben los permisos nuevos: dueño y administrador (todo) y
-- cajero (fiar y cobrar abonos). Quien los haya quitado a mano no los recupera: solo se agregan
-- si el rol sigue siendo el de fábrica.
UPDATE role SET permissions = json_insert(permissions, '$[#]', 'sale.credit')
WHERE id IN ('owner', 'manager', 'cashier')
  AND NOT EXISTS (SELECT 1 FROM json_each(role.permissions) WHERE value = 'sale.credit');
--> statement-breakpoint
UPDATE role SET permissions = json_insert(permissions, '$[#]', 'payment.receive')
WHERE id IN ('owner', 'manager', 'cashier')
  AND NOT EXISTS (SELECT 1 FROM json_each(role.permissions) WHERE value = 'payment.receive');
