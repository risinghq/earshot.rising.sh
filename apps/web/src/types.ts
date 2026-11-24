export type Period = "week" | "month" | "all";

export interface Env {
  DB: D1Database;
  CACHE?: KVNamespace;
  ROOMS: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  SOLO: DurableObjectNamespace<import("./play/solo-store").SoloGame>;
  ADMIN_GITHUB_IDS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SOURCE_ENCRYPTION_KEY?: string;
}

export type SourceRow = typeof import("./db/schema").sources.$inferSelect;

export interface TrackInput {
  kind: string;
  sourceKey: string;
  artist: string;
  title: string;
  mbid?: string;
  isrc?: string;
}

export interface PeriodStats {
  schema: 1;
  user: { name: string };
  period: Period;
  from: number | null;
  to: number;
  plays: number;
  unique_tracks: number;
  unique_artists: number;
  top_tracks: Array<{
    title: string;
    artist: string;
    plays: number;
    image: string | null;
  }>;
  top_artists: Array<{ artist: string; plays: number; image: string | null }>;
  daily: Array<{ day: string; plays: number }>;
  updated_at: number;
}
