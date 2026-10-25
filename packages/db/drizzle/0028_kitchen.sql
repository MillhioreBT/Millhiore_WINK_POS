CREATE TABLE `kitchen_station` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category_ids` text,
	`printer` text,
	`counter_sales` integer DEFAULT true NOT NULL,
	`target_minutes` integer DEFAULT 15 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kitchen_ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`station_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`tab_id` text,
	`document_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	`ready_by` text,
	`printed_at` integer,
	`print_error` text,
	FOREIGN KEY (`station_id`) REFERENCES `kitchen_station`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tab_id`) REFERENCES `tab`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ready_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kitchen_ticket_station` ON `kitchen_ticket` (`station_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `kitchen_ticket_tab` ON `kitchen_ticket` (`tab_id`);--> statement-breakpoint
CREATE TABLE `kitchen_ticket_line` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`tab_line_id` text,
	`name` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`modifiers` text,
	`note` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `kitchen_ticket`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tab_line_id`) REFERENCES `tab_line`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kitchen_ticket_line_ticket` ON `kitchen_ticket_line` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `kitchen_ticket_line_tab` ON `kitchen_ticket_line` (`tab_line_id`);--> statement-breakpoint
-- Ver la pantalla de cocina: dueño y administrador. «Cocina» es un rol de fábrica nuevo que se
-- crea al arrancar.
UPDATE role SET permissions = json_insert(permissions, '$[#]', 'kitchen.view')
WHERE id IN ('owner', 'manager')
  AND NOT EXISTS (SELECT 1 FROM json_each(role.permissions) WHERE value = 'kitchen.view');
