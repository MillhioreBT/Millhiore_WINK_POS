ALTER TABLE `product` ADD `unit` text DEFAULT 'unit' NOT NULL;--> statement-breakpoint
ALTER TABLE `variant` ADD `plu` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `variant_plu_unique` ON `variant` (`plu`);