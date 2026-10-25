CREATE TABLE `product_image` (
	`product_id` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `product` ADD `description` text;--> statement-breakpoint
ALTER TABLE `product` ADD `in_catalog` integer DEFAULT true NOT NULL;