ALTER TABLE `document` ADD `discount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `discount_legal_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document_line` ADD `discount_minor` integer DEFAULT 0 NOT NULL;