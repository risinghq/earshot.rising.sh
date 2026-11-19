import { app, scheduled } from "./app";
import type { Env } from "./types";

export { Matchmaker } from "./play/match";
export { Room } from "./play/room";
export { SoloGame } from "./play/solo-store";

const scheduledHandler: NonNullable<ExportedHandler<Env>["scheduled"]> =
  scheduled;

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;
