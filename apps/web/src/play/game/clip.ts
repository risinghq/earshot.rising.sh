// The clip a round plays. The default is the Deezer preview; a paid "intro"
// round plays the track from its start, served from KV by a deezer clip id.
// The first paid play of a track finds no cached mp3, serves the preview and
// warms the cache in the background; later plays skip antra entirely.
import {
  jobStatus,
  submitJob,
  trackDownload,
  ackTrack,
} from "../../fetch/antra";
import { base64url } from "../../account/auth";
import type { Env } from "../../env";
import { candidatePreview } from "./quiz";
import type { Candidate, Preview } from "../catalog/sources";

export type ClipKind = "preview" | "intro";

export function parseClipKind(value: unknown): ClipKind | null {
  return value === "intro" || value === "preview" ? value : null;
}

export function clipKey(deezerId: number) {
  return `antra:track:${deezerId}`;
}

// A one-byte marker beside the mp3: existence checks read it instead of the
// clip body, which can be megabytes, on every serve of a warm round.
const readyKey = (deezerId: number) => `antra:ready:${deezerId}`;

const isWarm = async (env: Env, deezerId: number) =>
  (await env.CACHE.get(readyKey(deezerId))) !== null;

// The warm claim lives in D1, the one writer every isolate shares: the
// INSERT wins only when the row is absent or stale, so exactly one caller
// schedules the antra job for a cold track. The winner stamps an owner
// token and may delete only that token's row, so a worker that outlived a
// stale claim cannot drop the claim another isolate has since taken.
const claimWarm = async (env: Env, deezerId: number) => {
  const now = Math.floor(Date.now() / 1000);
  const owner = base64url(crypto.getRandomValues(new Uint8Array(9)));
  const result = await env.DB.prepare(
    `INSERT INTO warm_claims (deezer_id, claimed_at, owner)
     VALUES (?1, ?2, ?3)
     ON CONFLICT (deezer_id) DO UPDATE
     SET claimed_at = excluded.claimed_at, owner = excluded.owner
     WHERE warm_claims.claimed_at < ?4`,
  )
    .bind(deezerId, now, owner, now - claimTtlSeconds)
    .run();
  return result.meta.changes > 0 ? owner : null;
};

const releaseWarm = (env: Env, deezerId: number, owner: string) =>
  env.DB.prepare("DELETE FROM warm_claims WHERE deezer_id = ?1 AND owner = ?2")
    .bind(deezerId, owner)
    .run();

export function introSeconds(env: Env) {
  const value = Number(env.INTRO_SECONDS);
  return Number.isInteger(value) && value > 0 ? value : 10;
}

const maxClipBytes = 25 * 1024 * 1024;
const warmPollMs = 2000;
const warmPolls = 60;
const clipTtlSeconds = 86400;
// Longer than the longest warm (60 polls × 2 s plus the download), so a
// healthy job never loses its claim mid-poll.
const claimTtlSeconds = 600;

// The clip route is unguessable rather than signed in: room screens and
// guest phones hold no session, so the URL itself carries proof it was
// served. It signs only the track id, so replays and re-serves match.
async function clipSignature(env: Env, deezerId: number) {
  const raw = env.SOURCE_ENCRYPTION_KEY;
  if (!raw) return null;
  const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`clip:${deezerId}`),
  );
  return base64url(new Uint8Array(sig).slice(0, 12));
}

export async function clipUrl(env: Env, deezerId: number) {
  const k = await clipSignature(env, deezerId);
  if (k === null) return null;
  return `/play/clip/${deezerId}?k=${k}#t=0,${introSeconds(env)}`;
}

// The mp3 the intro rounds play, as bytes already in KV.
export async function serveClip(
  env: Env,
  deezerId: number,
  k: string | undefined,
) {
  const expected = await clipSignature(env, deezerId);
  if (expected === null || k !== expected) return null;
  return env.CACHE.get(clipKey(deezerId), "arrayBuffer");
}

// Deezer track URL -> antra job -> mp3 bytes into KV. Any upstream failure
// throws; callers catch, so a paid round falls back to the preview instead
// of hard-failing on antra.
export async function warmIntro(env: Env, deezerId: number) {
  const key = clipKey(deezerId);
  if (await isWarm(env, deezerId)) return;
  const jobId = await submitJob(
    env,
    `https://www.deezer.com/track/${deezerId}`,
  );
  for (let poll = 0; poll < warmPolls; poll += 1) {
    const status = await jobStatus(env, jobId);
    if (status.error || status.status === "error" || status.status === "failed")
      throw new Error(
        `antra job ${jobId} failed: ${status.error ?? status.status}`,
      );
    if (status.status === "done" || status.done >= 1) {
      const response = await trackDownload(env, jobId, 0);
      if (!response.ok)
        throw new Error(`antra track download ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > maxClipBytes)
        throw new Error(`antra track download ${bytes.byteLength} bytes`);
      await env.CACHE.put(key, bytes, { expirationTtl: clipTtlSeconds });
      await env.CACHE.put(readyKey(deezerId), "1", {
        expirationTtl: clipTtlSeconds,
      });
      await ackTrack(env, jobId, 0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, warmPollMs));
  }
  throw new Error(`antra job ${jobId} did not finish`);
}

// Resolves the clip one seam above candidatePreview. Intro rounds play the
// cached track from 0:00; a cold cache warms in the background and the round
// takes the ordinary preview, so a player never waits on antra.
export async function roundClip(
  env: Env,
  candidate: Candidate,
  clip: ClipKind,
  background: (work: Promise<unknown>) => void,
): Promise<Preview | null> {
  if (clip === "intro" && candidate.deezerId !== undefined) {
    const deezerId = candidate.deezerId;
    if (await isWarm(env, deezerId)) {
      const url = await clipUrl(env, deezerId);
      if (url !== null)
        return { url, link: candidate.link, cover: candidate.cover };
    }
    let owner: string | null = null;
    try {
      owner = await claimWarm(env, deezerId);
    } catch {
      // A claim that cannot be written is not worth a failed round; the
      // preview plays and the next serve tries again.
    }
    if (owner !== null)
      background(
        (async () => {
          try {
            await warmIntro(env, deezerId);
          } catch (error) {
            console.error("intro warm failed", error);
          } finally {
            // The ready marker outlives the claim; a failed warm leaves the
            // track cold so the next serve reclaims it.
            await releaseWarm(env, deezerId, owner).catch(() => undefined);
          }
        })(),
      );
  }
  return candidatePreview(candidate);
}
