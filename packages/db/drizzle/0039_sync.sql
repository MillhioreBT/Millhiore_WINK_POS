CREATE TABLE `sync_pairing` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`branch_id`) REFERENCES `branch`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_peer` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`paired_at` integer NOT NULL,
	`history_rowid` integer DEFAULT 0 NOT NULL,
	`paired_by` text,
	`last_seen_at` integer,
	`last_push_at` integer,
	`documents_received` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branch`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paired_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_peer_branch_id_unique` ON `sync_peer` (`branch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sync_peer_token_hash_unique` ON `sync_peer` (`token_hash`);--> statement-breakpoint
CREATE TABLE `sync_received` (
	`document_id` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL
);
