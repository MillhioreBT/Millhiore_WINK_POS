CREATE TABLE `tax` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	CONSTRAINT "tax_rate_matches_kind" CHECK("tax"."rate_bp" between 0 and 10000 and (("tax"."kind" = 'taxed') = ("tax"."rate_bp" > 0)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_code_unique` ON `tax` (`code`);--> statement-breakpoint
CREATE TABLE `document_surcharge` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`position` integer NOT NULL,
	`surcharge_id` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`base_minor` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`base_legal_minor` integer NOT NULL,
	`amount_legal_minor` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`surcharge_id`) REFERENCES `surcharge`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_surcharge_order` ON `document_surcharge` (`document_id`,`position`);--> statement-breakpoint
CREATE TABLE `document_tax` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`position` integer NOT NULL,
	`tax_id` text,
	`kind` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`base_minor` integer NOT NULL,
	`tax_minor` integer NOT NULL,
	`base_legal_minor` integer NOT NULL,
	`tax_legal_minor` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_id`) REFERENCES `tax`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_tax_order` ON `document_tax` (`document_id`,`position`);--> statement-breakpoint
CREATE TABLE `surcharge` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	CONSTRAINT "surcharge_rate_range" CHECK("surcharge"."rate_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `surcharge_code_unique` ON `surcharge` (`code`);--> statement-breakpoint
ALTER TABLE `product` ADD `tax_id` text REFERENCES tax(id);--> statement-breakpoint
ALTER TABLE `document` ADD `prices_include_tax` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `surcharge_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `surcharge_legal_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document_line` ADD `tax_id` text REFERENCES tax(id);--> statement-breakpoint
ALTER TABLE `document_line` ADD `tax_rate_bp` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment` ADD `surcharge_id` text REFERENCES surcharge(id);--> statement-breakpoint
ALTER TABLE `payment` ADD `surcharge_rate_bp` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_method` ADD `surcharge_id` text REFERENCES surcharge(id);
--> statement-breakpoint
-- Los documentos anteriores no tenían impuestos: su total entero queda como un grupo no sujeto.
INSERT INTO `document_tax` (`id`, `document_id`, `position`, `tax_id`, `kind`, `rate_bp`, `base_minor`, `tax_minor`, `base_legal_minor`, `tax_legal_minor`)
SELECT lower(hex(randomblob(16))), `id`, 1, NULL, 'not_subject', 0, `total_minor`, 0, `total_legal_minor`, 0
FROM `document` WHERE `type` <> 'ADJUSTMENT';
--> statement-breakpoint
CREATE TRIGGER document_tax_no_update BEFORE UPDATE ON document_tax
BEGIN SELECT RAISE(ABORT, 'document_tax es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER document_tax_no_delete BEFORE DELETE ON document_tax
BEGIN SELECT RAISE(ABORT, 'document_tax es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER document_surcharge_no_update BEFORE UPDATE ON document_surcharge
BEGIN SELECT RAISE(ABORT, 'document_surcharge es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER document_surcharge_no_delete BEFORE DELETE ON document_surcharge
BEGIN SELECT RAISE(ABORT, 'document_surcharge es inmutable: use un documento de reverso'); END;