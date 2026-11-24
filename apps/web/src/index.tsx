import { app } from "./app";
import type { Env } from "./env";
import { pullDueSources } from "./listening/cron";
import { warmChartCache } from "./play/catalog/catalog";
import { refreshCatalog } from "./play/catalog/refresh";
import { fillImages } from "./profile/images";

export { Matchmaker } from "./play/match/match";
export { Room } from "./play/room/room";
export { SoloGame } from "./play/solo/store";

const scheduled: ExportedHandlerScheduledHandler<Env> = async (_, env) => {
  await pullDueSources(env);
  await refreshCatalog(env);
  await warmChartCache(env);
  await fillImages(env);
};

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
