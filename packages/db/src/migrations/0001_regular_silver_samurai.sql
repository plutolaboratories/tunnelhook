CREATE TABLE `delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`error` text,
	`duration` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delivery_eventId_idx` ON `delivery` (`event_id`);--> statement-breakpoint
CREATE INDEX `delivery_machineId_idx` ON `delivery` (`machine_id`);--> statement-breakpoint
CREATE TABLE `machine` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`user_id` text NOT NULL,
	`forward_url` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoint`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `machine_endpointId_idx` ON `machine` (`endpoint_id`);--> statement-breakpoint
CREATE INDEX `machine_userId_idx` ON `machine` (`user_id`);