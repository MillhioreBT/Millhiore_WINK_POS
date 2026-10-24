CREATE TABLE `price_list` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adjust_bp` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	CONSTRAINT "price_list_adjust_range" CHECK("price_list"."adjust_bp" between -9900 and 1000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_list_name_unique` ON `price_list` (`name`);--> statement-breakpoint
CREATE TABLE `price_list_price` (
	`price_list_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`price_minor` integer NOT NULL,
	`price_currency` text NOT NULL,
	PRIMARY KEY(`price_list_id`, `variant_id`),
	FOREIGN KEY (`price_list_id`) REFERENCES `price_list`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`price_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "price_list_price_nonneg" CHECK("price_list_price"."price_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE `contact` ADD `price_list_id` text REFERENCES price_list(id);