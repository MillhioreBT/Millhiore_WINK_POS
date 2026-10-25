CREATE TABLE `user_branch` (
	`user_id` text NOT NULL,
	`branch_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `branch_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `branch` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`phone` text,
	`price_list_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_name_unique` ON `branch` (`name`);--> statement-breakpoint
ALTER TABLE `location` ADD `branch_id` text REFERENCES branch(id);--> statement-breakpoint
-- La sucursal de siempre: todo lo que ya existía queda en ella.
INSERT INTO `branch` (`id`, `name`, `active`, `created_at`) SELECT 'main', 'Principal', 1, `created_at` FROM `business` LIMIT 1;--> statement-breakpoint
UPDATE `location` SET `branch_id` = 'main' WHERE `branch_id` IS NULL AND EXISTS (SELECT 1 FROM `branch` WHERE `id` = 'main');
