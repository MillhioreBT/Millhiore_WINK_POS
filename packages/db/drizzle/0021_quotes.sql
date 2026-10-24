CREATE TABLE `quote` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`contact_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`valid_until` integer NOT NULL,
	`discount_kind` text,
	`discount_value` integer,
	`discount_currency` text,
	`charges` text,
	`total_ref_minor` integer,
	`total_legal_minor` integer NOT NULL,
	`rate_value` text,
	`note` text,
	`document_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discount_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "quote_discount" CHECK(("quote"."discount_kind" is null and "quote"."discount_value" is null)
        or ("quote"."discount_kind" is not null and "quote"."discount_value" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quote_number_unique` ON `quote` (`number`);--> statement-breakpoint
CREATE INDEX `quote_status` ON `quote` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `quote_contact` ON `quote` (`contact_id`);--> statement-breakpoint
CREATE TABLE `quote_line` (
	`id` text PRIMARY KEY NOT NULL,
	`quote_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`variant_id` text NOT NULL,
	`name` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`price_minor` integer NOT NULL,
	`price_currency` text NOT NULL,
	`discount_kind` text,
	`discount_value` integer,
	`discount_currency` text,
	FOREIGN KEY (`quote_id`) REFERENCES `quote`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`price_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discount_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "quote_line_qty" CHECK("quote_line"."qty_milli" > 0 and "quote_line"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quote_line_order` ON `quote_line` (`quote_id`,`line_no`);