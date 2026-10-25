CREATE TABLE `dining_area` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dining_table` (
	`id` text PRIMARY KEY NOT NULL,
	`area_id` text NOT NULL,
	`name` text NOT NULL,
	`seats` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`area_id`) REFERENCES `dining_area`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dining_table_area` ON `dining_table` (`area_id`,`position`);--> statement-breakpoint
CREATE TABLE `tab` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`table_id` text,
	`label` text,
	`guests` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`waiter_id` text,
	`note` text,
	`opened_by` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`cancel_reason` text,
	FOREIGN KEY (`table_id`) REFERENCES `dining_table`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`waiter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tab_number_unique` ON `tab` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `tab_open_table` ON `tab` (`table_id`) WHERE "tab"."status" = 'open' and "tab"."table_id" is not null;--> statement-breakpoint
CREATE INDEX `tab_status` ON `tab` (`status`,`opened_at`);--> statement-breakpoint
CREATE TABLE `tab_line` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`name` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`price_minor` integer NOT NULL,
	`price_currency` text NOT NULL,
	`note` text,
	`added_by` text,
	`added_at` integer NOT NULL,
	`voided_at` integer,
	`voided_by` text,
	`void_reason` text,
	`document_id` text,
	FOREIGN KEY (`tab_id`) REFERENCES `tab`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`price_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tab_line_qty" CHECK("tab_line"."qty_milli" > 0 and "tab_line"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `tab_line_tab` ON `tab_line` (`tab_id`,`added_at`);--> statement-breakpoint
CREATE INDEX `tab_line_document` ON `tab_line` (`document_id`);--> statement-breakpoint
-- Atender mesas (abrir cuentas, pedir, mover): los roles de fábrica que venden. El mesonero es un
-- rol de fábrica nuevo que se crea al arrancar.
UPDATE role SET permissions = json_insert(permissions, '$[#]', 'table.serve')
WHERE id IN ('owner', 'manager', 'cashier')
  AND NOT EXISTS (SELECT 1 FROM json_each(role.permissions) WHERE value = 'table.serve');
