export interface Env {
  DB: D1Database;
  CACHE?: KVNamespace;
  ROOMS: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  SOLO: DurableObjectNamespace<import("./play/solo/store").SoloGame>;
  ADMIN_GITHUB_IDS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SOURCE_ENCRYPTION_KEY?: string;
}
