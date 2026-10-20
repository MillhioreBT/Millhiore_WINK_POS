CREATE TABLE `recurring_expense` (
	`id` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`category_id` text NOT NULL,
	`contact_id` text,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`frequency` text NOT NULL,
	`anchor_day` integer NOT NULL,
	`next_due_day` text NOT NULL,
	`auto` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `expense_category`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_expense_amount_positive" CHECK("recurring_expense"."amount_minor" > 0),
	CONSTRAINT "recurring_expense_anchor_range" CHECK("recurring_expense"."anchor_day" between 1 and 31)
);
--> statement-breakpoint
CREATE INDEX `recurring_expense_due` ON `recurring_expense` (`active`,`next_due_day`);