import { normalizeText } from "../normalize";
import { FeedError, fetchJson } from "./http";

// A candidate carries the ids a round needs to resolve a fresh preview: the
// preview URL itself is signed and expires, so it is never stored.
export interface Candidate {
  title: string;
  artist: string;
  cover: string | null;
  link: string | null;
  isrc?: string;
  deezerId?: number;
}

export interface Preview {
  url: string;
  link: string | null;
  cover: string | null;
}

// Deezer answers quota overruns with HTTP 200 and
// {"error":{"type":"Exception","code":4}}; the same body shape carries real
// misses like code 800 for an unknown ISRC, which must stay skippable.
export class QuotaError extends Error {}

async function deezerGet(url: string): Promise<unknown> {
  const body = (await fetchJson(url)) as { error?: { code?: number } };
  if (body?.error?.code === 4) throw new QuotaError(url);
  return body;
}

interface DeezerTrack {
  id?: number;
  title?: string;
  preview?: string;
  link?: string;
  artist?: { name?: string };
  album?: { cover_medium?: string };
}

function deezerCandidate(track: DeezerTrack): Candidate | null {
  if (
    typeof track.id !== "number" ||
    typeof track.title !== "string" ||
    typeof track.artist?.name !== "string"
  )
    return null;
  return {
    title: track.title,
    artist: track.artist.name,
    cover: track.album?.cover_medium ?? null,
    link: track.link ?? null,
    deezerId: track.id,
  };
}

async function deezerList(url: string): Promise<Candidate[]> {
  const body = (await deezerGet(url)) as { data?: DeezerTrack[] };
  return (body.data ?? [])
    .map(deezerCandidate)
    .filter((track): track is Candidate => track !== null);
}

export function deezerChart(genreId: string) {
  return deezerList(`https://api.deezer.com/chart/${genreId}/tracks?limit=50`);
}

export function deezerPlaylist(playlistId: string) {
  return deezerList(
    `https://api.deezer.com/playlist/${playlistId}/tracks?limit=100`,
  );
}

export function deezerArtistTop(artistId: number) {
  return deezerList(`https://api.deezer.com/artist/${artistId}/top?limit=100`);
}

interface DeezerArtist {
  id?: number;
  name?: string;
  nb_fan?: number;
  picture_medium?: string;
}

// Only Deezer's no-data error (code 800) means the artist does not exist.
// Any other error body — code 700 is a busy service — or a failed fetch is a
// failed lookup, which the caller keeps as the "Artist N" fallback instead
// of turning a real artist into a 404.
export async function deezerArtist(artistId: number) {
  const url = `https://api.deezer.com/artist/${artistId}`;
  const body = (await deezerGet(url)) as DeezerArtist & {
    error?: { code?: number };
  };
  if (body.error?.code === 800) return null;
  if (typeof body.name !== "string" || body.name === "")
    throw new FeedError("artist lookup failed", url);
  return { id: artistId, name: body.name };
}

export interface ArtistHit {
  id: number;
  name: string;
  fans: number;
  picture: string | null;
}

// Deezer's own order leads with minor duplicates, so the hits are ranked by
// fan count instead.
export async function deezerSearchArtists(query: string): Promise<ArtistHit[]> {
  const body = (await deezerGet(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(query)}`,
  )) as { data?: DeezerArtist[] };
  return (body.data ?? [])
    .filter(
      (artist): artist is DeezerArtist & { id: number; name: string } =>
        typeof artist.id === "number" && typeof artist.name === "string",
    )
    .map((artist) => ({
      id: artist.id,
      name: artist.name,
      fans: artist.nb_fan ?? 0,
      picture: artist.picture_medium ?? null,
    }))
    .sort((a, b) => b.fans - a.fans);
}

interface AppleFeedEntry {
  id?: string;
  name?: string;
  artistName?: string;
  url?: string;
  artworkUrl100?: string;
}

export async function appleChart(country: string): Promise<Candidate[]> {
  const body = (await fetchJson(
    `https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/50/songs.json`,
  )) as { feed?: { results?: AppleFeedEntry[] } };
  return (body.feed?.results ?? [])
    .filter(
      (
        entry,
      ): entry is Required<Pick<AppleFeedEntry, "name" | "artistName">> &
        AppleFeedEntry =>
        typeof entry.name === "string" && typeof entry.artistName === "string",
    )
    .map((entry) => ({
      title: entry.name!,
      artist: entry.artistName!,
      cover: entry.artworkUrl100 ?? null,
      link: entry.url ?? null,
    }));
}

export async function deezerPreview(deezerId: number): Promise<Preview | null> {
  const track = (await deezerGet(
    `https://api.deezer.com/track/${deezerId}`,
  )) as DeezerTrack;
  return typeof track.preview === "string" && track.preview
    ? {
        url: track.preview,
        link: track.link ?? null,
        cover: track.album?.cover_medium ?? null,
      }
    : null;
}

function artistMatches(found: string | undefined, wanted: string) {
  return (
    typeof found === "string" && normalizeText(found) === normalizeText(wanted)
  );
}

// Free-text search returns the wrong track often enough that a hit counts only
// when its artist matches the wanted one.
export async function deezerSearchPreview(
  artist: string,
  title: string,
): Promise<Preview | null> {
  const body = (await deezerGet(
    `https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=5`,
  )) as { data?: DeezerTrack[] };
  const hit = (body.data ?? []).find(
    (track) =>
      typeof track.preview === "string" &&
      track.preview &&
      artistMatches(track.artist?.name, artist),
  );
  return hit
    ? {
        url: hit.preview!,
        link: hit.link ?? null,
        cover: hit.album?.cover_medium ?? null,
      }
    : null;
}

// Deezer's ISRC lookup answers {"error":{"code":800}} for an unknown code.
export async function deezerIsrcPreview(
  isrc: string,
  artist: string,
): Promise<Preview | null> {
  const track = (await deezerGet(
    `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`,
  )) as DeezerTrack;
  return typeof track.preview === "string" &&
    track.preview &&
    artistMatches(track.artist?.name, artist)
    ? {
        url: track.preview,
        link: track.link ?? null,
        cover: track.album?.cover_medium ?? null,
      }
    : null;
}
