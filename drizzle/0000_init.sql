CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`booking_id` integer,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `audit_booking` ON `audit_log` (`booking_id`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_slug` text,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`rule` text,
	`until` integer,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`status` text NOT NULL,
	`room_slug` text NOT NULL,
	`purpose` text,
	`kind` text NOT NULL,
	`persons` integer NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`category` text,
	`offer` text,
	`name` text,
	`contact_channel` text NOT NULL,
	`contact_address` text,
	`contact_hash` text,
	`rules_accepted_at` integer,
	`hold_until` integer,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`cancel_reason` text,
	`manage_token_hash` text,
	`verified_at` integer,
	`delete_after` integer,
	`anonymized_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`room_slug`) REFERENCES `rooms`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_public_id` ON `bookings` (`public_id`);--> statement-breakpoint
CREATE INDEX `bookings_status` ON `bookings` (`status`);--> statement-breakpoint
CREATE INDEX `bookings_manage` ON `bookings` (`manage_token_hash`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`capacity` integer NOT NULL,
	`buffer_minutes` integer DEFAULT 30 NOT NULL,
	`auto_approve` integer DEFAULT false NOT NULL,
	`combines` text,
	`bookable` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`booking_id` integer NOT NULL,
	`rule` text NOT NULL,
	`until` integer NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`booking_id` integer NOT NULL,
	`room_slug` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`end_with_buffer` integer NOT NULL,
	`skipped` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slots_room_time` ON `slots` (`room_slug`,`start`,`end_with_buffer`);--> statement-breakpoint
CREATE INDEX `slots_booking` ON `slots` (`booking_id`);--> statement-breakpoint
CREATE TABLE `trusted_contacts` (
	`contact_hash` text PRIMARY KEY NOT NULL,
	`approved_count` integer DEFAULT 0 NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`booking_id` integer NOT NULL,
	`channel` text NOT NULL,
	`code_hash` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`confirmed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `verifications_token` ON `verifications` (`token_hash`);--> statement-breakpoint
CREATE INDEX `verifications_booking` ON `verifications` (`booking_id`);