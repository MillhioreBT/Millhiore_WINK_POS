CREATE TABLE `discount_code` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`kind` text NOT NULL,
	`rate_bp` integer DEFAULT 0 NOT NULL,
	`amount_minor` integer DEFAULT 0 NOT NULL,
	`currency` text,
	`max_uses` integer,
	`valid_from` text,
	`valid_until` text,
	`note` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "discount_code_value" CHECK(("discount_code"."kind" = 'percent' and "discount_code"."rate_bp" between 1 and 10000)
        or ("discount_code"."kind" = 'amount' and "discount_code"."amount_minor" > 0 and "discount_code"."currency" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discount_code_code_unique` ON `discount_code` (`code`);--> statement-breakpoint
ALTER TABLE `document` ADD `discount_code_id` text REFERENCES discount_code(id);