ALTER TABLE `payment` ADD `commission_rate_bp` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment` ADD `commission_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_method` ADD `commission_bp` integer DEFAULT 0 NOT NULL;