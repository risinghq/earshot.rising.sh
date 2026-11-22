#!/usr/bin/env node
// Builds src/play/curated.json from scripts/curated-seeds.json.
//
//   node scripts/curate.ts [CATEGORY...]
//   node scripts/curate.ts --list "ARTIST"
//
// Popularity is Spotify's all-time stream count from kworb.net; an artist kworb
// does not track falls back to the order of Deezer's /artist/{id}/top. The year
// is the most common iTunes release year of the title, because Deezer dates a
// track by the release it sits on and so returns remasters and compilations.
// A song Deezer has no preview for plays from its iTunes preview, and a title
// in Japanese or Korean script shows the name the US store gives it. Responses
// are cached on disk, so a rerun after editing the seeds costs no requests for
// the artists already seen.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ArtistSeed {
  name: string;
  canonical?: string;
  // An artist name that matches the wrong account somewhere pins its id. false
  // skips kworb, whose name match folds accents: "BoA" finds the band bôa.
  kworb?: string | false;
  deezer?: number;
  itunes?: number;
  // Only these titles, in this order: an anime singer's top songs are not all
  // anime themes.
  only?: string[];
  cap?: number;
}

interface CategorySeed {
  decades: number[];
  perArtist: number;
  // A song kworb counts below this many streams is not one people know.
  minStreams?: number;
  artists: (string | ArtistSeed)[];
  // The iTunes storefront that dates the songs. The US store romanizes
  // Japanese titles and lacks most 1980s anime themes; the JP store has both.
  itunesStore?: string;
  // "Artist|Title" pairs never used.
  drop?: string[];
  // "Artist|Title" to a year, for titles iTunes dates wrong or not at all.
  years?: Record<string, number>;
  // "Artist|Title" from editorial playlists (Spotify's All Out, Anime Hits),
  // keyed by the decade the playlist covers or "any". They are the hits an
  // artist seed misses, and a decade key bounds the year a lookup may give.
  songs?: Record<string, string[]>;
  work?: Record<string, string>;
  themes?: Record<string, string>;
}

interface TrackMetadata {
  works: Map<string, string>;
  themes: Map<string, string>;
}

interface Song {
  artist: string;
  title: string;
  streams: number | null;
  rank: number;
}

// A track plays from Deezer by `id`, or from the stored iTunes `preview` when
// Deezer has no verified cut. `original` is the title in its own script when
// `title` is a romanized or English name.
export interface CuratedTrack {
  id?: number;
  itunesId?: number;
  preview?: string;
  link?: string;
  title: string;
  original?: string;
  artist: string;
  artistId: number | null;
  cover: string | null;
  year: number;
  work?: string;
  theme?: string;
}

const root = new URL("..", import.meta.url).pathname;
const seedsPath = join(root, "scripts/curated-seeds.json");
const outPath = join(root, "src/play/curated.json");
const cacheDir = process.env.CURATE_CACHE ?? join(tmpdir(), "earshot-curate");
const userAgent = "Mozilla/5.0 (compatible; catalog-curation)";
const candidatesPerArtist = 12;
// Deezer's artist top carries no stream count for the floor to test and
// leans toward recent releases, so an artist kworb lacks offers fewer songs.
const fallbackPerArtist = 5;

// Each host's pause between live requests: kworb is a one-person site, Apple
// asks for about 20 a minute, and Deezer allows 50 per 5 seconds.
const pauses: Record<string, number> = {
  "kworb.net": 1500,
  "itunes.apple.com": 3200,
  "api.deezer.com": 150,
};
const lastAt = new Map<string, number>();

async function fetchText(url: string): Promise<string> {
  const file = join(
    cacheDir,
    createHash("sha256").update(url).digest("hex").slice(0, 32),
  );
  const cached = await readFile(file, "utf8").catch(() => null);
  if (cached !== null) return cached;
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt += 1) {
    const wait = (lastAt.get(host) ?? 0) + (pauses[host] ?? 1000) - Date.now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    lastAt.set(host, Date.now());
    // A dropped connection fails fetch itself; it gets the throttle's retries.
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent },
    }).catch((error: unknown) => {
      if (attempt < 4) return null;
      throw error;
    });
    const body = response === null ? "" : await response.text();
    const throttled =
      response === null ||
      response.status === 429 ||
      response.status === 403 ||
      body.includes('"code":4,');
    if (throttled && attempt < 4) {
      await new Promise((done) => setTimeout(done, 30_000 * (attempt + 1)));
      continue;
    }
    if (response === null || (!response.ok && response.status !== 404))
      throw new Error(`${response?.status} from ${url}`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, body);
    return body;
  }
}

const fetchJson = async <T>(url: string) =>
  JSON.parse(await fetchText(url)) as T;

export function fold(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

const versionWords =
  /\b(live|remix|mix|demo|instrumental|karaoke|acoustic|acústic[oa]|en vivo|unplugged|mtv|session|rehearsal|commentary|interview|sped up|slowed|remake|cover|tv size|tv version|first take|off[ -]vocal)\b/i;

// Strips what a service appends to the song's own name: " - Remastered 2011",
// "(feat. X)", "[2015 Remaster]".
export function baseTitle(title: string) {
  return title
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s*[([](?:feat|ft|with|from|remaster|\d{4}).*?[)\]]/gi, "")
    .replace(/\s*[([][^)\]]*remaster[^)\]]*[)\]]/gi, "")
    .trim();
}

export function isVersion(title: string) {
  return versionWords.test(title);
}

const decode = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

let kworbIndex: Map<string, string> | null = null;

async function kworbId(name: string) {
  if (kworbIndex === null) {
    const html = await fetchText("https://kworb.net/spotify/artists.html");
    kworbIndex = new Map();
    for (const [, id, artist] of html.matchAll(
      /artist\/([A-Za-z0-9]+)_songs\.html">([^<]+)<\/a>/g,
    ))
      if (!kworbIndex.has(fold(decode(artist))))
        kworbIndex.set(fold(decode(artist)), id);
  }
  return kworbIndex.get(fold(name)) ?? null;
}

// Rows marked "* " credit the artist as a feature or on someone else's
// recording, so only the artist's own songs remain.
async function kworbSongs(id: string, artist: string): Promise<Song[]> {
  const html = await fetchText(
    `https://kworb.net/spotify/artist/${id}_songs.html`,
  );
  const songs: Song[] = [];
  const seen = new Set<string>();
  for (const [, star, title, streams] of html.matchAll(
    /<td class="text"><div>(\* )?<a href="https:\/\/open\.spotify\.com\/track\/[^"]+"[^>]*>([^<]+)<\/a><\/div><\/td><td>([\d,]+)<\/td>/g,
  )) {
    const name = decode(title);
    if (star || isVersion(name)) continue;
    const base = baseTitle(name);
    if (seen.has(fold(base))) continue;
    seen.add(fold(base));
    songs.push({
      artist,
      title: base,
      streams: Number(streams.replaceAll(",", "")),
      rank: songs.length,
    });
  }
  return songs;
}

interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  preview?: string;
  rank?: number;
  duration?: number;
  artist: { id: number; name: string };
  album: { cover_medium?: string };
}

async function deezerArtistId(seed: ArtistSeed) {
  if (seed.deezer) return seed.deezer;
  const found = await fetchJson<{
    data?: { id: number; name: string; nb_fan?: number }[];
  }>(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(seed.name)}&limit=10`,
  );
  // Several acts share a name ("Adele" names four); the one with most fans is
  // the one people mean.
  const named = (found.data ?? []).filter(
    (hit) => fold(hit.name) === fold(seed.name),
  );
  named.sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0));
  return named[0]?.id ?? null;
}

async function deezerTopSongs(seed: ArtistSeed): Promise<Song[]> {
  const id = await deezerArtistId(seed);
  if (id === null) return [];
  const top = await fetchJson<{ data?: DeezerTrack[] }>(
    `https://api.deezer.com/artist/${id}/top?limit=50`,
  );
  const seen = new Set<string>();
  const songs: Song[] = [];
  for (const track of top.data ?? []) {
    const base = baseTitle(track.title_short ?? track.title);
    if (isVersion(track.title) || seen.has(fold(base))) continue;
    seen.add(fold(base));
    songs.push({
      artist: seed.name,
      title: base,
      streams: null,
      rank: songs.length,
    });
  }
  return songs;
}

const sameArtist = (a: string, b: string) => {
  const x = fold(a);
  const y = fold(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
};

const deezerSearch = async (query: string) =>
  (
    await fetchJson<{ data?: DeezerTrack[] }>(
      `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=25`,
    )
  ).data ?? [];

const byArtist =
  (song: Song, artistId: number | null) => (track: DeezerTrack) =>
    Boolean(track.preview) &&
    !isVersion(track.title) &&
    (artistId === null
      ? sameArtist(track.artist.name, song.artist)
      : track.artist.id === artistId);

// The plain query finds what the advanced artist:"" track:"" syntax misses.
// Search leaves out some originals entirely (Oasis, Adele, Coldplay's Clocks),
// so the artist's own top list is the fallback. Of the matching tracks with a
// preview, the most played is the canonical cut.
async function deezerByTitle(song: Song, artistId: number | null) {
  const match = bestMatch(
    await deezerSearch(`${song.artist} ${song.title}`),
    song,
    artistId,
  );
  if (match !== null) return match;
  const topId = artistId ?? (await deezerArtistId({ name: song.artist }));
  if (topId === null) return null;
  const top = await fetchJson<{ data?: DeezerTrack[] }>(
    `https://api.deezer.com/artist/${topId}/top?limit=100`,
  );
  return bestMatch(top.data ?? [], song, topId);
}

function bestMatch(tracks: DeezerTrack[], song: Song, artistId: number | null) {
  const matches = tracks.filter(
    (track) =>
      byArtist(song, artistId)(track) &&
      fold(baseTitle(track.title_short ?? track.title)) === fold(song.title),
  );
  matches.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  return matches[0] ?? null;
}

// Deezer gives seconds and iTunes milliseconds. One recording on both services
// differs by under a second; another cut (TV size, a remaster) differs more.
const durationSlackMs = 1500;

function byDuration(
  tracks: DeezerTrack[],
  song: Song,
  artistId: number | null,
  millis: number,
) {
  const gap = (track: DeezerTrack) =>
    Math.abs((track.duration ?? 0) * 1000 - millis);
  const close = tracks
    .filter(byArtist(song, artistId))
    .filter((track) => gap(track) <= durationSlackMs);
  close.sort((a, b) => gap(a) - gap(b));
  return close[0] ?? null;
}

interface ItunesSong {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  releaseDate?: string;
  previewUrl?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
  trackViewUrl?: string;
}

// A query suffix, empty for the default US store so its cached URLs still hit.
const storeQuery = (seed: CategorySeed) =>
  seed.itunesStore ? `&country=${seed.itunesStore}` : "";

async function itunesArtistId(seed: ArtistSeed, store: string) {
  if (seed.itunes) return seed.itunes;
  const found = await fetchJson<{
    results: { artistId: number; artistName: string }[];
  }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(seed.name)}&entity=musicArtist&limit=10${store}`,
  );
  return (
    found.results.find((hit) => fold(hit.artistName) === fold(seed.name))
      ?.artistId ?? null
  );
}

// The most common year wins and a tie goes to the earlier one: a hit sits on
// its album, its single and a few compilations, and the original release
// outnumbers each reissue.
export function originalYear(dates: string[]) {
  const counts = new Map<number, number>();
  for (const date of dates) {
    const year = Number(date.slice(0, 4));
    if (year > 1900) counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [year, count] of counts)
    if (
      best === null ||
      count > counts.get(best)! ||
      (count === counts.get(best) && year < best)
    )
      best = year;
  return best;
}

const compilationWords =
  /\b(greatest|hits|best|collection|essential|anthology|gold|definitive|ultimate|platinum|singles|cross road|decade|retrospective|very|icon|classics?|number ones|ballads|love songs|lo mejor|grandes|éxitos|exitos|historia|antología|antologia)\b/i;

// A compilation track often carries a made-up date (Bon Jovi's Cross Road
// dates Bed of Roses 1983), so it is filed under its own key and only counts
// when no studio release has the title.
function datesByTitle(songs: ItunesSong[], artist: string) {
  const dates = new Map<string, string[]>();
  for (const song of songs) {
    if (!song.trackName || !song.releaseDate || !song.artistName) continue;
    if (!sameArtist(song.artistName, artist)) continue;
    if (isVersion(`${song.trackName} ${song.collectionName ?? ""}`)) continue;
    const compilation = compilationWords.test(song.collectionName ?? "");
    for (const title of [
      fold(baseTitle(song.trackName)),
      `^${fold(coreTitle(song.trackName))}`,
    ]) {
      const key = compilation ? `~${title}` : title;
      dates.set(key, [...(dates.get(key) ?? []), song.releaseDate]);
    }
  }
  return dates;
}

// kworb and iTunes bracket different parts of a title: "Sunflower" against
// "Sunflower (Spider-Man: Into the Spider-Verse)". Matching on what is left
// outside every bracket is the fallback.
const coreTitle = (title: string) =>
  baseTitle(title).replace(/\s*[([][^)\]]*[)\]]/g, "");

function yearOf(
  dates: Map<string, string[]>,
  title: string,
  decade: number | null = null,
) {
  const inDecade = (list: string[]) =>
    decade === null
      ? list
      : list.filter(
          (date) => Math.floor(Number(date.slice(0, 4)) / 10) * 10 === decade,
        );
  for (const key of [fold(title), `^${fold(coreTitle(title))}`]) {
    const year =
      originalYear(inDecade(dates.get(key) ?? [])) ??
      originalYear(inDecade(dates.get(`~${key}`) ?? []));
    if (year !== null) return year;
  }
  return null;
}

async function itunesYears(seed: ArtistSeed, store: string) {
  const id = await itunesArtistId(seed, store);
  if (id === null) return new Map<string, string[]>();
  const found = await fetchJson<{ results: ItunesSong[] }>(
    `https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200${store}`,
  );
  return datesByTitle(found.results, seed.name);
}

// A store can name the artist in another script (the JP store's 杏里 for Anri).
// The search term carries the artist, so the first title match names the
// artist as that store spells it.
const itunesSearch = async (song: Song, store: string) =>
  (
    await fetchJson<{ results: ItunesSong[] }>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(`${song.artist} ${song.title}`)}&entity=song&limit=50${store}`,
    )
  ).results;

const sameCore = (hit: ItunesSong, title: string) =>
  Boolean(hit.trackName) &&
  fold(coreTitle(hit.trackName!)) === fold(coreTitle(title));

const storeArtist = (results: ItunesSong[], song: Song) =>
  results.find((hit) => sameCore(hit, song.title))?.artistName ?? null;

async function itunesSongYear(
  song: Song,
  store: string,
  decade: number | null = null,
) {
  const results = await itunesSearch(song, store);
  const year = yearOf(datesByTitle(results, song.artist), song.title, decade);
  if (year !== null) return year;
  const anchor = storeArtist(results, song);
  return anchor
    ? yearOf(datesByTitle(results, anchor), song.title, decade)
    : null;
}

// The song's own recording in the store: its title, by the artist as either
// spelling names it, not a live or karaoke cut, and an original album ahead of
// a compilation.
async function itunesTrack(song: Song, store: string) {
  const results = await itunesSearch(song, store);
  const anchor = storeArtist(results, song);
  const hits = results.filter(
    (hit) =>
      hit.kind === "song" &&
      hit.previewUrl &&
      hit.trackId &&
      sameCore(hit, song.title) &&
      !isVersion(`${hit.trackName} ${hit.collectionName ?? ""}`) &&
      hit.artistName &&
      (sameArtist(hit.artistName, song.artist) || hit.artistName === anchor),
  );
  return (
    hits.find((hit) => !compilationWords.test(hit.collectionName ?? "")) ??
    hits[0] ??
    null
  );
}

const nativeScript =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// The US store names a Japanese release in English or romaji (唱 is "Show"),
// and its lookup takes the JP store's track id.
async function latinName(hit: ItunesSong, store: string) {
  let name = hit.trackName ?? "";
  if (store !== "") {
    const found = await fetchJson<{ results: ItunesSong[] }>(
      `https://itunes.apple.com/lookup?id=${hit.trackId}&country=US`,
    );
    name = found.results[0]?.trackName ?? "";
  }
  const title = coreTitle(name);
  return title !== "" && !nativeScript.test(title) ? title : null;
}

interface Resolved {
  deezer: DeezerTrack | null;
  itunes: ItunesSong | null;
  title: string;
  original: string | null;
  how: string;
}

// A title in Latin script matches Deezer by name. A title in Japanese or
// Korean script does not, since Deezer may file it under a romanized name, so
// the iTunes recording anchors it: Deezer's track must carry the native name,
// the US store's name, or the same length. Without a match the iTunes preview
// plays.
async function resolveSong(
  song: Song,
  artistId: number | null,
  store: string,
): Promise<Resolved | null> {
  if (!nativeScript.test(song.title)) {
    const deezer = await deezerByTitle(song, artistId);
    if (deezer !== null)
      return {
        deezer,
        itunes: null,
        title: song.title,
        original: null,
        how: "title",
      };
    const itunes = await itunesTrack(song, store);
    return itunes === null
      ? null
      : {
          deezer: null,
          itunes,
          title: song.title,
          original: null,
          how: "itunes",
        };
  }
  const itunes = await itunesTrack(song, store);
  const latin = itunes === null ? null : await latinName(itunes, store);
  const found = await deezerSearch(`${song.artist} ${song.title}`);
  let deezer = bestMatch(found, song, artistId);
  let how = "native title";
  if (deezer === null && latin !== null) {
    const named = { ...song, title: latin };
    deezer = bestMatch(
      [...found, ...(await deezerSearch(`${song.artist} ${latin}`))],
      named,
      artistId,
    );
    how = "us title";
  }
  if (deezer === null && itunes?.trackTimeMillis) {
    deezer = byDuration(found, song, artistId, itunes.trackTimeMillis);
    how = "length";
  }
  if (deezer === null && itunes === null) return null;
  const deezerName =
    deezer === null ? null : coreTitle(deezer.title_short ?? deezer.title);
  const title =
    deezerName !== null && !nativeScript.test(deezerName)
      ? deezerName
      : (latin ?? song.title);
  return {
    deezer,
    itunes: deezer === null ? itunes : null,
    title,
    original: title === song.title ? null : song.title,
    how: deezer === null ? "itunes" : how,
  };
}

async function artistSongs(seed: ArtistSeed) {
  const id =
    seed.kworb === false ? null : (seed.kworb ?? (await kworbId(seed.name)));
  const songs = id
    ? await kworbSongs(id, seed.name)
    : await deezerTopSongs(seed);
  if (!seed.only)
    return songs.slice(0, id ? candidatesPerArtist : fallbackPerArtist);
  return seed.only.map(
    (title, rank) =>
      songs.find((song) => fold(song.title) === fold(title)) ?? {
        artist: seed.name,
        title,
        streams: null,
        rank,
      },
  );
}

// Two cuts of one song share the title outside its brackets: "Fly Me to the
// Moon (Rei #5 Version)" is "Fly Me to the Moon". Elsewhere they also share
// the artist's name, since an iTunes-only cut has no Deezer artist id. In a
// category of songs from works (anime, soundtracks) one song comes credited
// to its singer, a cover, a duet partner or a romanized name, so the title
// alone is the key; two songs that share a title would share the answer.
type Cut = { artist: string; title: string };

const cutKey = (byTitle: boolean) => (track: Cut) =>
  byTitle
    ? fold(coreTitle(track.title))
    : `${fold(track.artist)}|${fold(coreTitle(track.title))}`;

// A bracketed "Version" is not dropped outright, since "(Taylor's Version)"
// may be the only cut, but it loses to a plain cut of the same song.
const versionCut = (title: string) =>
  isVersion(title) ||
  /[([][^)\]]*\b(?:version|ver\.?|radio edit|re-?recorded)[)\]\s]/i.test(title);

// Every cut of a song moves to the place of its first cut, so popularity
// order holds, with plain cuts ahead of versions. The pick loop takes the
// first cut that fits a decade and a cap; the others are its fallbacks.
function plainFirst<T extends Cut>(
  tracks: T[],
  songKey: (track: Cut) => string,
): T[] {
  const cuts = new Map<string, T[]>();
  for (const track of tracks) {
    const key = songKey(track);
    const group = cuts.get(key);
    if (group) group.push(track);
    else cuts.set(key, [track]);
  }
  return [...cuts.values()].flatMap((group) => [
    ...group.filter((track) => !versionCut(track.title)),
    ...group.filter((track) => versionCut(track.title)),
  ]);
}

interface Picked extends CuratedTrack {
  streams: number | null;
  rank: number;
  yearFrom: string;
  how: string;
  // An editor picked it, so the per-artist cap does not apply.
  listed: boolean;
}

// The seed names the artist when Deezer has no cut, and Deezer's artist id
// still groups the song with the artist's other tracks for the cap.
async function trackFields(
  resolved: Resolved,
  artist: string,
  artistId: number | null,
): Promise<CuratedTrack & { how: string }> {
  const { deezer, itunes, title, original, how } = resolved;
  const named = { title, ...(original === null ? {} : { original }) };
  if (deezer !== null)
    return {
      id: deezer.id,
      ...named,
      artist,
      artistId: deezer.artist.id,
      cover: deezer.album.cover_medium ?? null,
      year: 0,
      how,
    };
  return {
    itunesId: itunes!.trackId!,
    preview: itunes!.previewUrl!,
    link: (itunes!.trackViewUrl ?? "").replace(/&uo=\d+$/, ""),
    ...named,
    artist,
    artistId: artistId ?? (await deezerArtistId({ name: artist })),
    cover: itunes!.artworkUrl100?.replace(/100x100bb/, "250x250bb") ?? null,
    year: 0,
    how,
  };
}

async function listedSongs(
  seed: CategorySeed,
  drop: Set<string>,
  years: Map<string, number>,
  misses: string[],
  metadata: TrackMetadata,
) {
  const picked: Picked[] = [];
  for (const [key, entries] of Object.entries(seed.songs ?? {})) {
    const decade = key === "any" ? null : Number(key);
    for (const [rank, entry] of entries.entries()) {
      const [artist, raw] = entry.split("|");
      const song: Song = { artist, title: baseTitle(raw), streams: null, rank };
      const songKey = fold(`${artist}|${song.title}`);
      if (drop.has(songKey) || isVersion(raw)) continue;
      const resolved = await resolveSong(song, null, storeQuery(seed));
      if (resolved === null) {
        misses.push(`${entry}: no preview`);
        continue;
      }
      const year =
        years.get(songKey) ??
        (await itunesSongYear(song, storeQuery(seed), decade));
      if (year === null) {
        misses.push(
          `${entry}: no year${decade === null ? "" : ` in the ${decade}s`}`,
        );
        continue;
      }
      picked.push({
        ...(await trackFields(
          resolved,
          canonicalArtist(seed, artist, resolved.deezer?.artist.name),
          null,
        )),
        year,
        ...(metadata.works.get(songKey)
          ? { work: metadata.works.get(songKey) }
          : {}),
        ...(metadata.themes.get(songKey)
          ? { theme: metadata.themes.get(songKey) }
          : {}),
        streams: null,
        rank,
        yearFrom: years.has(songKey) ? "seed" : `playlist ${key}`,
        listed: true,
      });
    }
  }
  return picked;
}

function trackMetadata(seed: CategorySeed): TrackMetadata {
  return {
    works: new Map(
      Object.entries(seed.work ?? {}).map(([key, value]) => [fold(key), value]),
    ),
    themes: new Map(
      Object.entries(seed.themes ?? {}).map(([key, value]) => [
        fold(key),
        value,
      ]),
    ),
  };
}

function canonicalArtist(
  seed: CategorySeed,
  name: string,
  resolvedName?: string,
) {
  const artist = seed.artists
    .map((raw) => (typeof raw === "string" ? { name: raw } : raw))
    .find((entry) => sameArtist(entry.name, name));
  return artist?.canonical ?? resolvedName ?? name;
}

async function curateCategory(slug: string, seed: CategorySeed) {
  const drop = new Set((seed.drop ?? []).map((key) => fold(key)));
  const years = new Map(
    Object.entries(seed.years ?? {}).map(([key, year]) => [fold(key), year]),
  );
  const picked: Picked[] = [];
  const misses: string[] = [];
  const metadata = trackMetadata(seed);
  for (const raw of seed.artists) {
    const artist: ArtistSeed = typeof raw === "string" ? { name: raw } : raw;
    const songs = await artistSongs(artist);
    const dates = await itunesYears(artist, storeQuery(seed));
    // kworb titles follow Spotify, which romanizes Japanese names as the US
    // store does, so a JP-store seed dates those titles from the US catalog.
    let latinDates: Map<string, string[]> | null = null;
    const deezerId = artist.deezer ?? null;
    for (const song of songs) {
      const key = fold(`${song.artist}|${song.title}`);
      if (drop.has(key)) continue;
      if (song.streams !== null && song.streams < (seed.minStreams ?? 0))
        continue;
      const resolved = await resolveSong(song, deezerId, storeQuery(seed));
      if (resolved === null) {
        misses.push(`${song.artist} | ${song.title}: no preview`);
        continue;
      }
      let year = years.get(key) ?? null;
      let yearFrom = "seed";
      if (year === null) {
        year = yearOf(dates, song.title);
        yearFrom = "itunes artist";
      }
      if (year === null && seed.itunesStore !== undefined) {
        latinDates ??= await itunesYears(artist, "");
        year = yearOf(latinDates, song.title);
        yearFrom = "itunes us artist";
      }
      if (year === null) {
        year = await itunesSongYear(song, storeQuery(seed));
        yearFrom = "itunes search";
      }
      if (year === null) {
        misses.push(`${song.artist} | ${song.title}: no year`);
        continue;
      }
      picked.push({
        ...(await trackFields(
          resolved,
          artist.canonical ?? artist.name,
          deezerId,
        )),
        ...(metadata.works.get(key) ? { work: metadata.works.get(key) } : {}),
        ...(metadata.themes.get(key)
          ? { theme: metadata.themes.get(key) }
          : {}),
        year,
        streams: song.streams,
        rank: song.rank,
        yearFrom,
        listed: false,
      });
    }
  }
  picked.push(...(await listedSongs(seed, drop, years, misses, metadata)));
  const byDecade = new Map<number, Picked[]>();
  for (const decade of seed.decades) byDecade.set(decade, []);
  const perArtist = new Map<string, number>();
  const seenIds = new Set<string>();
  // Songs keep their artist's popularity order, so the cap keeps each
  // artist's biggest songs of that decade.
  const capOf = (name: string) => {
    const raw = seed.artists.find(
      (entry) => typeof entry !== "string" && entry.name === name,
    ) as ArtistSeed | undefined;
    return raw?.cap ?? seed.perArtist;
  };
  const seenSongs = new Set<string>();
  const songKey = cutKey(seed.work !== undefined);
  for (const track of plainFirst(picked, songKey)) {
    const decade = Math.floor(track.year / 10) * 10;
    const list = byDecade.get(decade);
    const who = track.artistId ?? fold(track.artist);
    const id = track.id ? `dz:${track.id}` : `it:${track.itunesId}`;
    const song = songKey(track);
    if (!list || seenIds.has(id) || seenSongs.has(song)) continue;
    const used = perArtist.get(`${decade}|${who}`) ?? 0;
    if (!track.listed && used >= capOf(track.artist)) continue;
    perArtist.set(`${decade}|${who}`, used + 1);
    seenIds.add(id);
    seenSongs.add(song);
    list.push(track);
  }
  return { byDecade, misses };
}

function printList(
  slug: string,
  byDecade: Map<number, Picked[]>,
  misses: string[],
) {
  for (const [decade, tracks] of byDecade) {
    console.log(`\n## ${slug} ${decade}s: ${tracks.length}`);
    for (const track of tracks)
      console.log(
        `${track.year}  ${track.artist} | ${track.title}${track.original ? ` [${track.original}]` : ""}  ${track.streams === null ? `deezer #${track.rank + 1}` : `${Math.round(track.streams / 1e6)}M`}  (${track.yearFrom}; ${track.how})`,
      );
  }
  if (misses.length > 0)
    console.log(`\n${slug} misses:\n  ${misses.join("\n  ")}`);
}

async function listArtist(name: string) {
  const seed = { name };
  const songs = await artistSongs({ ...seed });
  const dates = await itunesYears(seed, "");
  for (const song of songs.slice(0, 40))
    console.log(
      `${yearOf(dates, song.title) ?? "????"}  ${song.title}  ${song.streams === null ? "-" : `${Math.round(song.streams / 1e6)}M`}`,
    );
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list") return listArtist(args[1] ?? "");
  const seeds = JSON.parse(await readFile(seedsPath, "utf8")) as Record<
    string,
    CategorySeed
  >;
  const previous = JSON.parse(
    await readFile(outPath, "utf8").catch(() => "{}"),
  ) as Record<string, Record<string, CuratedTrack[]>>;
  const slugs = args.length > 0 ? args : Object.keys(seeds);
  for (const slug of slugs) {
    if (!seeds[slug]) throw new Error(`no seeds for ${slug}`);
    const { byDecade, misses } = await curateCategory(slug, seeds[slug]);
    printList(slug, byDecade, misses);
    previous[slug] = Object.fromEntries(
      [...byDecade].map(([decade, tracks]) => [
        String(decade),
        tracks.map(
          ({ streams, rank, yearFrom, how, listed, ...track }) => track,
        ),
      ]),
    );
  }
  const ordered = Object.fromEntries(
    Object.keys(seeds)
      .filter((slug) => previous[slug])
      .map((slug) => [slug, previous[slug]]),
  );
  await writeFile(outPath, `${JSON.stringify(ordered, null, 1)}\n`);
}

await main();
