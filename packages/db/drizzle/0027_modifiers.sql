CREATE TABLE `modifier` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`price_minor` integer DEFAULT 0 NOT NULL,
	`price_currency` text,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `modifier_group`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`price_currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "modifier_price" CHECK("modifier"."price_minor" >= 0 and ("modifier"."price_minor" = 0 or "modifier"."price_currency" is not null))
);
--> statement-breakpoint
CREATE TABLE `modifier_group` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`min_select` integer DEFAULT 0 NOT NULL,
	`max_select` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "modifier_group_select" CHECK("modifier_group"."min_select" >= 0 and ("modifier_group"."max_select" is null or "modifier_group"."max_select" >= max("modifier_group"."min_select", 1)))
);
--> statement-breakpoint
CREATE TABLE `product_modifier_group` (
	`product_id` text NOT NULL,
	`group_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `group_id`),
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `modifier_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tab_line` ADD `modifiers` text;--> statement-breakpoint
ALTER TABLE `document_line` ADD `modifiers` text;--> statement-breakpoint
ALTER TABLE `document_line` ADD `note` text;