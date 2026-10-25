CREATE TABLE `web_order` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`customer_name` text NOT NULL,
	`customer_phone` text NOT NULL,
	`delivery` text NOT NULL,
	`address` text,
	`payment` text,
	`note` text,
	`lines` text NOT NULL,
	`total_reference_minor` integer,
	`total_legal_minor` integer,
	`reference_currency` text NOT NULL,
	`legal_currency` text NOT NULL,
	`price_list_id` text,
	`document_id` text,
	`cancel_reason` text,
	`handled_by` text,
	`handled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handled_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_order_number_unique` ON `web_order` (`number`);--> statement-breakpoint
CREATE INDEX `web_order_status` ON `web_order` (`status`,`created_at`);