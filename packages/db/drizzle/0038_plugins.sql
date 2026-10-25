CREATE TABLE `plugin` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`manifest` text NOT NULL,
	`archive` blob NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`installed_by` text NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_error` text,
	`last_error_at` integer,
	FOREIGN KEY (`installed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plugin_event` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_event_due` ON `plugin_event` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `plugin_kv` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
