CREATE TABLE `sale_charge` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`rate_bp` integer DEFAULT 0 NOT NULL,
	`amount_minor` integer DEFAULT 0 NOT NULL,
	`currency` text,
	`tax_id` text,
	`auto` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_id`) REFERENCES `tax`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sale_charge_kind" CHECK(("sale_charge"."kind" = 'percent' and "sale_charge"."rate_bp" between 1 and 10000)
        or ("sale_charge"."kind" = 'fixed' and "sale_charge"."amount_minor" >= 0 and "sale_charge"."currency" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sale_charge_name_unique` ON `sale_charge` (`name`);--> statement-breakpoint
CREATE TABLE `document_charge` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`position` integer NOT NULL,
	`charge_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`base_minor` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`amount_legal_minor` integer NOT NULL,
	`tax_id` text,
	`tax_rate_bp` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`charge_id`) REFERENCES `sale_charge`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_id`) REFERENCES `tax`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_charge_order` ON `document_charge` (`document_id`,`position`);--> statement-breakpoint
-- Un recargo cobrado es parte del documento: inmutable como él (se corrige con un reverso).
CREATE TRIGGER document_charge_no_update BEFORE UPDATE ON document_charge
BEGIN SELECT RAISE(ABORT, 'document_charge es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER document_charge_no_delete BEFORE DELETE ON document_charge
BEGIN SELECT RAISE(ABORT, 'document_charge es inmutable: use un documento de reverso'); END;
