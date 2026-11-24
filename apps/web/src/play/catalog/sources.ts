import * as v from "valibot";
import { normalizeText } from "../../listening/normalize";
import { FeedError, fetchJson } from "../../platform/fetch-json";

// A candidate carries the ids a round needs to resolve a fresh preview: a
// Deezer preview URL is signed and expires, so it is never stored. An iTunes
// preview URL is not signed, so a curated iTunes track carries it as
// `preview`. `original` is the title in its own script when `title` is a
// romanized name; a typed answer may use either.
export interface Candidate {
  title: string;
  original?: string;
  // The show and slot a reveal names (rules.ts workLabel).
  work?: string;
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

// Every field Deezer may leave out is nullish, so a body only fails on a
// field of the wrong type.
const deezerBody = <E extends v.ObjectEntries>(entries: E) =>
  v.object({
    ...entries,
    error: v.nullish(v.object({ code: v.nullish(v.number()) })),
  });

// A malformed entry drops out of the list, so one bad track does not cost
// the rest.
const entriesOf = <T>(schema: v.GenericSchema<unknown, T>) =>
  v.nullish(
    v.pipe(
      v.array(v.unknown()),
      v.transform((items) =>
        items.flatMap((item) => {
          const parsed = v.safeParse(schema, item);
          return parsed.success ? [parsed.output] : [];
        }),
      ),
    ),
  );

interface DeezerReply {
  error?: { code?: number | null } | null;
}

async function deezerGet<T extends DeezerReply>(
  url: string,
  schema: v.GenericSchema<unknown, T>,
): Promise<T> {
  const body = await fetchJson(url, schema);
  if (body.error?.code === 4) throw new QuotaError(url);
  return body;
}

const trackEntries = {
  id: v.nullish(v.number()),
  title: v.nullish(v.string()),
  preview: v.nullish(v.string()),
  link: v.nullish(v.string()),
  release_date: v.nullish(v.string()),
  artist: v.nullish(
    v.object({ id: v.nullish(v.number()), name: v.nullish(v.string()) }),
  ),
  album: v.nullish(v.object({ cover_medium: v.nullish(v.string()) })),
  // Only /track/{id} lists contributors; list and search results do not.
  contributors: v.nullish(
    v.array(
      v.object({ name: v.nullish(v.string()), role: v.nullish(v.string()) }),
    ),
  ),
};
const TrackBody = deezerBody(trackEntries);
const TrackList = deezerBody({
  data: entriesOf(v.object(trackEntries)),
});
type DeezerTrack = v.InferOutput<typeof TrackBody>;

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
  const body = await deezerGet(url, TrackList);
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
    const body = await deezerGet(
      `https://api.deezer.com/playlist/${playlistId}/tracks?limit=100&index=${index}`,
      TrackList,
    );
    const page = (body.data ?? []).filter(
      (track): track is DeezerTrack & { id: number } =>
        typeof track.id === "number",
    );
    tracks.push(...page);
    if (page.length < 100) break;
  }
  return tracks;
}

const owner = v.nullish(v.object({ name: v.nullish(v.string()) }));
const PlaylistBody = deezerBody({
  id: v.nullish(v.number()),
  title: v.nullish(v.string()),
  nb_tracks: v.nullish(v.number()),
  creator: owner,
  user: owner,
});

export async function deezerPlaylistInfo(
  playlistId: string,
): Promise<PlaylistInfo | null> {
  const body = await deezerGet(
    `https://api.deezer.com/playlist/${playlistId}`,
    PlaylistBody,
  );
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
  const track = await deezerGet(
    `https://api.deezer.com/track/${deezerId}`,
    TrackBody,
  );
  const year = Number(track.release_date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

export function deezerArtistTop(artistId: number) {
  return deezerList(`https://api.deezer.com/artist/${artistId}/top?limit=100`);
}

const artistEntries = {
  id: v.nullish(v.number()),
  name: v.nullish(v.string()),
  nb_fan: v.nullish(v.number()),
  picture_medium: v.nullish(v.string()),
};
const ArtistBody = deezerBody(artistEntries);
const ArtistList = deezerBody({
  data: entriesOf(v.object(artistEntries)),
});

// Only Deezer's no-data error (code 800) means the artist does not exist.
// Any other error body — code 700 is a busy service — or a failed fetch is a
// failed lookup, which the caller keeps as the "Artist N" fallback instead
// of turning a real artist into a 404.
export async function deezerArtist(artistId: number) {
  const url = `https://api.deezer.com/artist/${artistId}`;
  const body = await deezerGet(url, ArtistBody);
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
  const body = await deezerGet(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(query)}`,
    ArtistList,
  );
  return (body.data ?? [])
    .flatMap(({ id, name, ...artist }) =>
      typeof id === "number" && typeof name === "string"
        ? [{ ...artist, id, name }]
        : [],
    )
    .map((artist) => ({
      id: artist.id,
      name: artist.name,
      fans: artist.nb_fan ?? 0,
      picture: artist.picture_medium ?? null,
    }))
    .sort((a, b) => b.fans - a.fans);
}

const AppleFeed = v.object({
  feed: v.nullish(
    v.object({
      results: entriesOf(
        v.object({
          name: v.nullish(v.string()),
          artistName: v.nullish(v.string()),
          url: v.nullish(v.string()),
          artworkUrl100: v.nullish(v.string()),
        }),
      ),
    }),
  ),
});

export async function appleChart(country: string): Promise<Candidate[]> {
  const body = await fetchJson(
    `https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/50/songs.json`,
    AppleFeed,
  );
  return (body.feed?.results ?? []).flatMap((entry) =>
    typeof entry.name === "string" && typeof entry.artistName === "string"
      ? [
          {
            title: entry.name,
            artist: entry.artistName,
            cover: entry.artworkUrl100 ?? null,
            link: entry.url ?? null,
          },
        ]
      : [],
  );
}

export async function deezerPreview(deezerId: number): Promise<Preview | null> {
  const track = await deezerGet(
    `https://api.deezer.com/track/${deezerId}`,
    TrackBody,
  );
  return typeof track.preview === "string" && track.preview
    ? trackPreview(track)
    : null;
}

function artistMatches(found: string | null | undefined, wanted: string) {
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
  const body = await deezerGet(
    `https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=5`,
    TrackList,
  );
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
  const body = await deezerGet(
    `https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=5`,
    TrackList,
  );
  const hit = (body.data ?? []).find((track) =>
    artistMatches(track.artist?.name, artist),
  );
  return hit?.album?.cover_medium || null;
}

// Deezer gives an artist with no picture a blank image whose path has an
// empty hash (".../images/artist//250x250-..."), which counts as none.
export async function deezerArtistPicture(name: string) {
  const body = await deezerGet(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`,
    ArtistList,
  );
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
  const track = await deezerGet(
    `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`,
    TrackBody,
  );
  return typeof track.preview === "string" &&
    track.preview &&
    artistMatches(track.artist?.name, artist)
    ? trackPreview(track)
    : null;
}
