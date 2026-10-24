CREATE TABLE `lot` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`code` text,
	`expires_on` text,
	`document_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lot_variant` ON `lot` (`variant_id`,`expires_on`);--> statement-breakpoint
CREATE TABLE `lot_balance` (
	`lot_id` text NOT NULL,
	`location_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	PRIMARY KEY(`lot_id`, `location_id`),
	FOREIGN KEY (`lot_id`) REFERENCES `lot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lot_balance_location` ON `lot_balance` (`location_id`);--> statement-breakpoint
ALTER TABLE `product` ADD `tracks_lots` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_move` ADD `lot_id` text REFERENCES lot(id);--> statement-breakpoint
CREATE INDEX `stock_move_lot` ON `stock_move` (`lot_id`);--> statement-breakpoint
-- Un lote se corrige (código, fecha) pero no se borra: sus movimientos lo nombran.
CREATE TRIGGER lot_no_delete BEFORE DELETE ON lot
BEGIN
  SELECT RAISE(ABORT, 'lot no se borra');
END;
