CREATE TABLE `hallo_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`name` text,
	`room_id` text,
	`root_event_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_activity_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hallo_conv_token` ON `hallo_conversations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `hallo_conv_root` ON `hallo_conversations` (`root_event_id`);--> statement-breakpoint
CREATE TABLE `hallo_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`direction` text NOT NULL,
	`author` text,
	`body` text NOT NULL,
	`event_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `hallo_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hallo_msg_event` ON `hallo_messages` (`event_id`);--> statement-breakpoint
CREATE INDEX `hallo_msg_conv` ON `hallo_messages` (`conversation_id`,`id`);