CREATE TABLE `calendar_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`show_public` integer DEFAULT false NOT NULL,
	`block_rooms` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_fetched_at` integer,
	`last_error` text,
	`event_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `external_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`uid` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`title` text NOT NULL,
	`location` text,
	FOREIGN KEY (`subscription_id`) REFERENCES `calendar_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_events_time` ON `external_events` (`start`,`end`);--> statement-breakpoint
CREATE INDEX `external_events_sub` ON `external_events` (`subscription_id`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `location_keywords` text;--> statement-breakpoint
UPDATE `rooms` SET `location_keywords` = '["viertelsaal"]' WHERE `slug` = 'viertelsaal';--> statement-breakpoint
UPDATE `rooms` SET `location_keywords` = '["viertelküche"]' WHERE `slug` = 'viertelkueche';--> statement-breakpoint
INSERT INTO `rooms` (`slug`, `name`, `capacity`, `buffer_minutes`, `bookable`, `sort_order`, `location_keywords`)
	SELECT 'werkstatt', 'Werkstatt', 10, 0, 0, 4, '["werkstatt"]'
	WHERE EXISTS (SELECT 1 FROM `rooms`) AND NOT EXISTS (SELECT 1 FROM `rooms` WHERE `slug` = 'werkstatt');--> statement-breakpoint
INSERT INTO `calendar_subscriptions` (`label`, `url`, `show_public`, `block_rooms`, `created_by`)
	VALUES ('Öffentliche Termine (Nextcloud)', 'https://wir.treibhausdonaufeld.at/remote.php/dav/public-calendars/3SW6YqDgBtcf4aa2?export', 1, 1, 'System');
