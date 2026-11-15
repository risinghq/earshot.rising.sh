import { app, scheduled } from "./app";
import type { Env } from "./types";

export { Room } from "./play/room";

const scheduledHandler: NonNullable<ExportedHandler<Env>["scheduled"]> =
  scheduled;

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;
