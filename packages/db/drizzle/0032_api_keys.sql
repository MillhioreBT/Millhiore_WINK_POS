CREATE TABLE `api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`secret_hash` text NOT NULL,
	`permissions` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_secret_hash_unique` ON `api_key` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `api_key_user` ON `api_key` (`user_id`);