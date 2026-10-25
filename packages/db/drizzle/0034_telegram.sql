CREATE TABLE `telegram_message` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `telegram_message_pending` ON `telegram_message` (`status`,`next_attempt_at`);