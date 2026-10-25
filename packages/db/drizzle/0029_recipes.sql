CREATE TABLE `recipe_item` (
	`product_id` text NOT NULL,
	`ingredient_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`waste_bp` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `ingredient_id`),
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ingredient_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recipe_item_qty" CHECK("recipe_item"."qty_milli" > 0 and "recipe_item"."waste_bp" between 0 and 10000)
);
