CREATE TABLE `contact` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`tax_id` text,
	`phone` text,
	`email` text,
	`address` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_tax_id` ON `contact` (`tax_id`) WHERE "contact"."tax_id" is not null;--> statement-breakpoint
CREATE INDEX `contact_name` ON `contact` (`name`);--> statement-breakpoint
ALTER TABLE `variant` ADD `cost_minor` integer;--> statement-breakpoint
ALTER TABLE `variant` ADD `cost_currency` text REFERENCES currency(code);--> statement-breakpoint
ALTER TABLE `document` ADD `contact_id` text REFERENCES contact(id);--> statement-breakpoint
ALTER TABLE `document` ADD `external_ref` text;--> statement-breakpoint
CREATE INDEX `document_contact` ON `document` (`contact_id`);