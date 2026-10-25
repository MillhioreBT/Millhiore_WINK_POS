ALTER TABLE `document` ADD `tip_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `tip_legal_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `tip_user_id` text;