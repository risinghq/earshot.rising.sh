CREATE TABLE `player_ratings` (
	`player_key` text PRIMARY KEY,
	`skill` real NOT NULL,
	`rounds` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rating_state` (
	`id` integer PRIMARY KEY,
	`last_outcome_id` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE TABLE `track_ratings` (
	`track_key` text PRIMARY KEY,
	`difficulty` real NOT NULL,
	`answers` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `catalog_tracks` ADD `streams` integer;