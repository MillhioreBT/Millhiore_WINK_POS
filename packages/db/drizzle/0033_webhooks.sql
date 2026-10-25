CREATE TABLE `webhook` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhook`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhook_delivery_pending` ON `webhook_delivery` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_delivery_webhook` ON `webhook_delivery` (`webhook_id`,`created_at`);