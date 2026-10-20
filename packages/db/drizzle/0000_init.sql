CREATE TABLE `product` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`tracks_stock` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "product_service_no_stock" CHECK("product"."kind" = 'good' or "product"."tracks_stock" = 0)
);
--> statement-breakpoint
CREATE TABLE `variant` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`barcode` text,
	`name` text NOT NULL,
	`price_minor` integer NOT NULL,
	`price_currency` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`price_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "variant_price_nonneg" CHECK("variant"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variant_sku_unique` ON `variant` (`sku`);--> statement-breakpoint
CREATE UNIQUE INDEX `variant_barcode_unique` ON `variant` (`barcode`);--> statement-breakpoint
CREATE TABLE `business` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`reference_currency` text NOT NULL,
	`legal_currency` text NOT NULL,
	`timezone` text DEFAULT 'America/Caracas' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`reference_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`legal_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `currency` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`symbol` text NOT NULL,
	`decimals` integer NOT NULL,
	CONSTRAINT "currency_decimals_range" CHECK("currency"."decimals" between 0 and 8)
);
--> statement-breakpoint
CREATE TABLE `exchange_rate` (
	`id` text PRIMARY KEY NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`effective_at` integer NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`base`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quote`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "exchange_rate_distinct" CHECK("exchange_rate"."base" <> "exchange_rate"."quote")
);
--> statement-breakpoint
CREATE INDEX `exchange_rate_lookup` ON `exchange_rate` (`base`,`quote`,`effective_at`);--> statement-breakpoint
CREATE TABLE `location` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `business`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `terminal` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminal_code_unique` ON `terminal` (`code`);--> statement-breakpoint
CREATE TABLE `document` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`number` text NOT NULL,
	`terminal_id` text NOT NULL,
	`location_id` text NOT NULL,
	`currency` text NOT NULL,
	`legal_currency` text NOT NULL,
	`rate_base` text,
	`rate_quote` text,
	`rate_value` text,
	`total_minor` integer NOT NULL,
	`total_legal_minor` integer NOT NULL,
	`reverses_document_id` text,
	`note` text,
	`created_by` text,
	`posted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`terminal_id`) REFERENCES `terminal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`legal_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reverses_document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_rate_all_or_none" CHECK(("document"."rate_base" is null) = ("document"."rate_quote" is null) and ("document"."rate_quote" is null) = ("document"."rate_value" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_number_unique` ON `document` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_reverses_unique` ON `document` (`reverses_document_id`);--> statement-breakpoint
CREATE INDEX `document_posted_at` ON `document` (`posted_at`);--> statement-breakpoint
CREATE INDEX `document_type_posted_at` ON `document` (`type`,`posted_at`);--> statement-breakpoint
CREATE TABLE `document_line` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`variant_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`line_total_minor` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_line_qty_nonzero" CHECK("document_line"."qty_milli" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_line_order` ON `document_line` (`document_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `document_sequence` (
	`terminal_id` text NOT NULL,
	`type` text NOT NULL,
	`last_number` integer NOT NULL,
	PRIMARY KEY(`terminal_id`, `type`),
	FOREIGN KEY (`terminal_id`) REFERENCES `terminal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payment` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`payment_method_id` text NOT NULL,
	`account_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`rate_base` text,
	`rate_quote` text,
	`rate_value` text,
	`reference` text,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_method`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_amount_nonzero" CHECK("payment"."amount_minor" <> 0),
	CONSTRAINT "payment_rate_all_or_none" CHECK(("payment"."rate_base" is null) = ("payment"."rate_quote" is null) and ("payment"."rate_quote" is null) = ("payment"."rate_value" is null))
);
--> statement-breakpoint
CREATE INDEX `payment_document` ON `payment` (`document_id`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payment_method` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text NOT NULL,
	`requires_reference` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account_balance` (
	`account_id` text PRIMARY KEY NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account_move` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`account_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "account_move_amount_nonzero" CHECK("account_move"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE INDEX `account_move_account` ON `account_move` (`account_id`);--> statement-breakpoint
CREATE INDEX `account_move_document` ON `account_move` (`document_id`);--> statement-breakpoint
CREATE TABLE `stock_balance` (
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	PRIMARY KEY(`variant_id`, `location_id`),
	FOREIGN KEY (`variant_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stock_move` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`document_line_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_line_id`) REFERENCES `document_line`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_move_qty_nonzero" CHECK("stock_move"."qty_milli" <> 0)
);
--> statement-breakpoint
CREATE INDEX `stock_move_item` ON `stock_move` (`variant_id`,`location_id`);--> statement-breakpoint
CREATE INDEX `stock_move_document` ON `stock_move` (`document_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_pending` ON `outbox` (`delivered_at`,`created_at`);