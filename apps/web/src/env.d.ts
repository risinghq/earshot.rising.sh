declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    ROOMS: DurableObjectNamespace<import("./play/room").Room>;
    MATCHMAKER: DurableObjectNamespace<import("./play/match").Matchmaker>;
    SOLO: DurableObjectNamespace<import("./play/solo-store").SoloGame>;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    SPOTIFY_CLIENT_ID?: string;
    SPOTIFY_CLIENT_SECRET?: string;
    SOURCE_ENCRYPTION_KEY?: string;
  }
}

declare module "virtual:web-migrations" {
  const migrations: Array<{ name: string; queries: string[] }>;
  export default migrations;
}
