declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    ROOMS: DurableObjectNamespace<import("./play/room/room").Room>;
    MATCHMAKER: DurableObjectNamespace<import("./play/match/match").Matchmaker>;
    SOLO: DurableObjectNamespace<import("./play/solo/store").SoloGame>;
    ADMIN_GITHUB_IDS?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    SPOTIFY_CLIENT_ID?: string;
    SPOTIFY_CLIENT_SECRET?: string;
    SOURCE_ENCRYPTION_KEY?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_PRICE_ID?: string;
    STRIPE_PAYMENT_LINK?: string;
    INTRO_SECONDS?: string;
    ANTRA_BASE?: string;
    ANTRA_USERNAME?: string;
    ANTRA_PASSWORD?: string;
  }
}

declare module "virtual:web-migrations" {
  const migrations: Array<{ name: string; queries: string[] }>;
  export default migrations;
}
