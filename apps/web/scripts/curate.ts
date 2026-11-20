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
// Responses are cached on disk, so a rerun after editing the seeds costs no
// requests for the artists already seen.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ArtistSeed {
  name: string;
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
}

interface Song {
  artist: string;
  title: string;
  streams: number | null;
  rank: number;
}

export interface CuratedTrack {
  id: number;
  title: string;
  artist: string;
  artistId: number;
  cover: string | null;
  year: number;
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
  /\b(live|remix|mix|demo|instrumental|karaoke|acoustic|acústic[oa]|en vivo|unplugged|mtv|session|rehearsal|commentary|interview|sped up|slowed|remake|cover|tv size|tv version|first take|off vocal)\b/i;

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

// The plain query finds what the advanced artist:"" track:"" syntax misses.
// Search leaves out some originals entirely (Oasis, Adele, Coldplay's Clocks),
// so the artist's own top list is the fallback. Of the matching tracks with a preview, the most
// played is the canonical cut.
async function resolveDeezer(song: Song, artistId: number | null) {
  const found = await fetchJson<{ data?: DeezerTrack[] }>(
    `https://api.deezer.com/search?q=${encodeURIComponent(`${song.artist} ${song.title}`)}&limit=25`,
  );
  const match = bestMatch(found.data ?? [], song, artistId);
  if (match !== null) return match;
  // Deezer romanizes Japanese titles (紅蓮華 is "Gurenge"), yet a search in the
  // original script still ranks that track first, so search order decides.
  if (!/\p{Script=Latin}/u.test(song.title))
    return (
      (found.data ?? []).find(
        (track) =>
          track.preview &&
          !isVersion(track.title) &&
          (artistId === null
            ? sameArtist(track.artist.name, song.artist)
            : track.artist.id === artistId),
      ) ?? null
    );
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
      track.preview &&
      !isVersion(track.title) &&
      fold(baseTitle(track.title_short ?? track.title)) === fold(song.title) &&
      (artistId === null
        ? sameArtist(track.artist.name, song.artist)
        : track.artist.id === artistId),
  );
  matches.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  return matches[0] ?? null;
}

interface ItunesSong {
  wrapperType?: string;
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  releaseDate?: string;
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
async function itunesSongYear(
  song: Song,
  store: string,
  decade: number | null = null,
) {
  const found = await fetchJson<{ results: ItunesSong[] }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(`${song.artist} ${song.title}`)}&entity=song&limit=50${store}`,
  );
  const year = yearOf(
    datesByTitle(found.results, song.artist),
    song.title,
    decade,
  );
  if (year !== null) return year;
  const anchor = found.results.find(
    (hit) =>
      hit.trackName &&
      fold(coreTitle(hit.trackName)) === fold(coreTitle(song.title)),
  )?.artistName;
  return anchor
    ? yearOf(datesByTitle(found.results, anchor), song.title, decade)
    : null;
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

interface Picked extends CuratedTrack {
  streams: number | null;
  rank: number;
  yearFrom: string;
  // An editor picked it, so the per-artist cap does not apply.
  listed: boolean;
}

async function listedSongs(
  seed: CategorySeed,
  drop: Set<string>,
  years: Map<string, number>,
  misses: string[],
) {
  const picked: Picked[] = [];
  for (const [key, entries] of Object.entries(seed.songs ?? {})) {
    const decade = key === "any" ? null : Number(key);
    for (const [rank, entry] of entries.entries()) {
      const [artist, raw] = entry.split("|");
      const song: Song = { artist, title: baseTitle(raw), streams: null, rank };
      const songKey = fold(`${artist}|${song.title}`);
      if (drop.has(songKey) || isVersion(raw)) continue;
      const track = await resolveDeezer(song, null);
      if (track === null) {
        misses.push(`${entry}: no Deezer preview`);
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
        id: track.id,
        title: song.title,
        artist: track.artist.name,
        artistId: track.artist.id,
        cover: track.album.cover_medium ?? null,
        year,
        streams: null,
        rank,
        yearFrom: years.has(songKey) ? "seed" : `playlist ${key}`,
        listed: true,
      });
    }
  }
  return picked;
}

async function curateCategory(slug: string, seed: CategorySeed) {
  const drop = new Set((seed.drop ?? []).map((key) => fold(key)));
  const years = new Map(
    Object.entries(seed.years ?? {}).map(([key, year]) => [fold(key), year]),
  );
  const picked: Picked[] = [];
  const misses: string[] = [];
  for (const raw of seed.artists) {
    const artist: ArtistSeed = typeof raw === "string" ? { name: raw } : raw;
    const songs = await artistSongs(artist);
    const dates = await itunesYears(artist, storeQuery(seed));
    const deezerId = artist.deezer ?? null;
    for (const song of songs) {
      const key = fold(`${song.artist}|${song.title}`);
      if (drop.has(key)) continue;
      if (song.streams !== null && song.streams < (seed.minStreams ?? 0))
        continue;
      const track = await resolveDeezer(song, deezerId);
      if (track === null) {
        misses.push(`${song.artist} | ${song.title}: no Deezer preview`);
        continue;
      }
      let year = years.get(key) ?? null;
      let yearFrom = "seed";
      if (year === null) {
        year = yearOf(dates, song.title);
        yearFrom = "itunes artist";
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
        id: track.id,
        title: song.title,
        artist: artist.name,
        artistId: track.artist.id,
        cover: track.album.cover_medium ?? null,
        year,
        streams: song.streams,
        rank: song.rank,
        yearFrom,
        listed: false,
      });
    }
  }
  picked.push(...(await listedSongs(seed, drop, years, misses)));
  const byDecade = new Map<number, Picked[]>();
  for (const decade of seed.decades) byDecade.set(decade, []);
  const perArtist = new Map<string, number>();
  const seenIds = new Set<number>();
  // Songs keep their artist's popularity order, so the cap keeps each
  // artist's biggest songs of that decade.
  const capOf = (name: string) => {
    const raw = seed.artists.find(
      (entry) => typeof entry !== "string" && entry.name === name,
    ) as ArtistSeed | undefined;
    return raw?.cap ?? seed.perArtist;
  };
  // Two cuts of one song share an artist id and a folded title.
  const seenSongs = new Set<string>();
  for (const track of picked) {
    const decade = Math.floor(track.year / 10) * 10;
    const list = byDecade.get(decade);
    const song = `${track.artistId}|${fold(track.title)}`;
    if (!list || seenIds.has(track.id) || seenSongs.has(song)) continue;
    const used = perArtist.get(`${decade}|${track.artistId}`) ?? 0;
    if (!track.listed && used >= capOf(track.artist)) continue;
    perArtist.set(`${decade}|${track.artistId}`, used + 1);
    seenIds.add(track.id);
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
        `${track.year}  ${track.artist} | ${track.title}  ${track.streams === null ? `deezer #${track.rank + 1}` : `${Math.round(track.streams / 1e6)}M`}  (${track.yearFrom})`,
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
        tracks.map(({ id, title, artist, artistId, cover, year }) => ({
          id,
          title,
          artist,
          artistId,
          cover,
          year,
        })),
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
