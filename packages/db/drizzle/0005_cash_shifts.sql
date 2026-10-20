CREATE TABLE `cash_shift` (
	`id` text PRIMARY KEY NOT NULL,
	`terminal_id` text NOT NULL,
	`status` text NOT NULL,
	`opened_by` text,
	`opened_at` integer NOT NULL,
	`opening_note` text,
	`closed_by` text,
	`closed_at` integer,
	`closing_note` text,
	FOREIGN KEY (`terminal_id`) REFERENCES `terminal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cash_shift_closed_fields" CHECK(("cash_shift"."status" = 'closed') = ("cash_shift"."closed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_shift_one_open` ON `cash_shift` (`terminal_id`) WHERE "cash_shift"."status" = 'open';--> statement-breakpoint
CREATE INDEX `cash_shift_opened_at` ON `cash_shift` (`opened_at`);--> statement-breakpoint
CREATE TABLE `cash_shift_account` (
	`shift_id` text NOT NULL,
	`account_id` text NOT NULL,
	`opening_expected_minor` integer NOT NULL,
	`opening_counted_minor` integer NOT NULL,
	`closing_expected_minor` integer,
	`closing_counted_minor` integer,
	`closing_denominations` text,
	`opening_adjustment_id` text,
	`closing_adjustment_id` text,
	PRIMARY KEY(`shift_id`, `account_id`),
	FOREIGN KEY (`shift_id`) REFERENCES `cash_shift`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `document` ADD `shift_id` text REFERENCES cash_shift(id);--> statement-breakpoint
CREATE INDEX `document_shift` ON `document` (`shift_id`);
--> statement-breakpoint
-- Un turno cerrado (y su arqueo) no se edita ni se borra: la diferencia ya quedó asentada.
CREATE TRIGGER cash_shift_closed_no_update BEFORE UPDATE ON cash_shift WHEN OLD.status = 'closed'
BEGIN SELECT RAISE(ABORT, 'cash_shift cerrado es inmutable'); END;
--> statement-breakpoint
CREATE TRIGGER cash_shift_no_delete BEFORE DELETE ON cash_shift
BEGIN SELECT RAISE(ABORT, 'cash_shift es inmutable'); END;
--> statement-breakpoint
CREATE TRIGGER cash_shift_account_closed_no_update BEFORE UPDATE ON cash_shift_account
WHEN (SELECT status FROM cash_shift WHERE id = OLD.shift_id) = 'closed'
BEGIN SELECT RAISE(ABORT, 'cash_shift_account de un turno cerrado es inmutable'); END;
--> statement-breakpoint
CREATE TRIGGER cash_shift_account_no_delete BEFORE DELETE ON cash_shift_account
BEGIN SELECT RAISE(ABORT, 'cash_shift_account es inmutable'); END;