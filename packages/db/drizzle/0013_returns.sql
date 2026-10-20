ALTER TABLE `document` ADD `returns_document_id` text REFERENCES document(id);--> statement-breakpoint
CREATE INDEX `document_returns` ON `document` (`returns_document_id`);