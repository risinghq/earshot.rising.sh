import { normalizeText } from "../normalize";
import { FeedError, fetchJson } from "./http";

// A candidate carries the ids a round needs to resolve a fresh preview: a
// Deezer preview URL is signed and expires, so it is never stored. An iTunes
// preview URL is not signed, so a curated iTunes track carries it as
// `preview`. `original` is the title in its own script when `title` is a
// romanized name; a typed answer may use either.
export interface Candidate {
  title: string;
  original?: string;
  artist: string;
  cover: string | null;
  link: string | null;
  isrc?: string;
  deezerId?: number;
  itunesId?: number;
  preview?: string;
  year?: number;
  decade?: number;
  // The catalog category the track was drawn from; set only by pools that mix
  // categories, so a round can credit the outcome to the right one.
  category?: string;
}

export interface Preview {
  url: string;
  link: string | null;
  cover: string | null;
  // Every artist the track credits ("Lady Gaga & Bruno Mars"), set only when
  // there is more than one. Pools and the choices keep the lead artist alone.
  credit?: string;
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
  release_date?: string;
  artist?: { id?: number; name?: string };
  album?: { cover_medium?: string };
  // Only /track/{id} lists contributors; list and search results do not.
  contributors?: { name?: string; role?: string }[];
}

const creditShown = 3;

// The main artists first, then the featured ones. Past three names the rest
// count as "+N", so a cast credit stays on one line.
export function creditLine(track: DeezerTrack): string | undefined {
  const credited = [...(track.contributors ?? [])].sort(
    (a, b) => Number(a.role !== "Main") - Number(b.role !== "Main"),
  );
  const names = [
    ...new Set(
      credited
        .map((contributor) => contributor.name?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  if (names.length < 2) return undefined;
  if (names.length > creditShown)
    return `${names.slice(0, creditShown).join(", ")} +${names.length - creditShown}`;
  return `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
}

function trackPreview(track: DeezerTrack): Preview {
  const credit = creditLine(track);
  return {
    url: track.preview!,
    link: track.link ?? null,
    cover: track.album?.cover_medium ?? null,
    ...(credit ? { credit } : {}),
  };
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

export interface PlaylistInfo {
  id: number;
  title: string;
  owner: string;
  tracks: number;
}

// The playlist pages its tracks 100 at a time through `index`; a response
// shorter than the page size is the last page.
export async function deezerPlaylistTracks(playlistId: string) {
  const tracks: (DeezerTrack & { id: number })[] = [];
  for (let index = 0; index < 1000; index += 100) {
    const body = (await deezerGet(
      `https://api.deezer.com/playlist/${playlistId}/tracks?limit=100&index=${index}`,
    )) as { data?: DeezerTrack[] };
    const page = (body.data ?? []).filter(
      (track): track is DeezerTrack & { id: number } =>
        typeof track.id === "number",
    );
    tracks.push(...page);
    if (page.length < 100) break;
  }
  return tracks;
}

export async function deezerPlaylistInfo(
  playlistId: string,
): Promise<PlaylistInfo | null> {
  const body = (await deezerGet(
    `https://api.deezer.com/playlist/${playlistId}`,
  )) as {
    id?: number;
    title?: string;
    nb_tracks?: number;
    creator?: { name?: string };
    user?: { name?: string };
    error?: { code?: number };
  };
  if (body.error?.code === 800) return null;
  if (typeof body.title !== "string" || typeof body.nb_tracks !== "number")
    throw new FeedError("playlist lookup failed", playlistId);
  return {
    id: body.id ?? Number(playlistId),
    title: body.title,
    owner: body.creator?.name ?? body.user?.name ?? "",
    tracks: body.nb_tracks,
  };
}

export async function deezerTrackYear(deezerId: number) {
  const track = (await deezerGet(
    `https://api.deezer.com/track/${deezerId}`,
  )) as DeezerTrack;
  const year = Number(track.release_date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
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
  return {
    id: artistId,
    name: body.name,
    picture: body.picture_medium || null,
    fans: body.nb_fan ?? 0,
  };
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
    ? trackPreview(track)
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

// The album cover of the first hit by the wanted artist, preview or not.
export async function deezerTrackCover(artist: string, title: string) {
  const body = (await deezerGet(
    `https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=5`,
  )) as { data?: DeezerTrack[] };
  const hit = (body.data ?? []).find((track) =>
    artistMatches(track.artist?.name, artist),
  );
  return hit?.album?.cover_medium || null;
}

// Deezer gives an artist with no picture a blank image whose path has an
// empty hash (".../images/artist//250x250-..."), which counts as none.
export async function deezerArtistPicture(name: string) {
  const body = (await deezerGet(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`,
  )) as { data?: DeezerArtist[] };
  const hit = (body.data ?? []).find((artist) =>
    artistMatches(artist.name, name),
  );
  const picture = hit?.picture_medium;
  return picture && !picture.includes("/artist//") ? picture : null;
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
    ? trackPreview(track)
    : null;
}
