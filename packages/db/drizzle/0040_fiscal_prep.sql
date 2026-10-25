CREATE TABLE `fiscal_invoice` (
	`document_id` text PRIMARY KEY NOT NULL,
	`invoice_number` text NOT NULL,
	`control_number` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`recorded_at` integer NOT NULL,
	`recorded_by` text,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fiscal_invoice_control_number_unique` ON `fiscal_invoice` (`control_number`);--> statement-breakpoint
ALTER TABLE `document` ADD `customer_name` text;--> statement-breakpoint
ALTER TABLE `document` ADD `customer_tax_id` text;--> statement-breakpoint
ALTER TABLE `document` ADD `customer_address` text;--> statement-breakpoint
ALTER TABLE `document` ADD `invoice_requested` integer DEFAULT false NOT NULL;