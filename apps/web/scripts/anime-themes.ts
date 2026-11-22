#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const seedPath = join(root, "scripts/curated-seeds.json");
const cacheDir =
  process.env.CURATE_CACHE ??
  join(process.env.HOME ?? ".", ".cache", "earshot-curate");
const userAgent = "Mozilla/5.0 (compatible; catalog-curation)";
const lastRequestByHost = new Map<string, number>();

type AniListMedia = {
  idMal: number | null;
  title: { english: string | null; romaji: string };
};

type Seed = {
  songs?: Record<string, string[]>;
  work?: Record<string, string>;
  themes?: Record<string, string>;
};

const aniListQuery = `query ($year: Int!) {
  Page(perPage: 15) {
    media(seasonYear: $year, type: ANIME, sort: POPULARITY_DESC) {
      idMal
      title { english romaji }
    }
  }
}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url: string, init?: RequestInit) {
  const cacheKey = createHash("sha256")
    .update(url + JSON.stringify(init ?? {}))
    .digest("hex");
  const cachePath = join(
    cacheDir,
    `anime-themes-${cacheKey.slice(0, 32)}.json`,
  );
  const cached = await readFile(cachePath, "utf8").catch(() => null);
  if (cached !== null) return cached;
  const host = new URL(url).host;
  const pause = host === "myanimelist.net" ? 3000 : 667;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const previous = lastRequestByHost.get(host) ?? 0;
    const wait = pause - (Date.now() - previous);
    if (wait > 0) await sleep(wait);
    lastRequestByHost.set(host, Date.now());
    // MyAnimeList sometimes holds a connection open without answering; a
    // timeout turns that into a retry instead of a hung run.
    const response = await fetch(url, {
      ...init,
      headers: { "User-Agent": userAgent, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    }).catch((error: unknown) => {
      console.error(`attempt ${attempt + 1} failed: ${url}: ${error}`);
      return null;
    });
    if (response === null) {
      if (attempt === 4) throw new Error(`no answer from ${url}`);
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    const body = await response.text();
    if (response.ok) {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, body);
      return body;
    }
    // A 429 means the host has blocked us; more requests extend the block.
    if (response.status < 500)
      throw new Error(`${response.status} from ${url}`);
    if (attempt === 4) throw new Error(`${response.status} from ${url}`);
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error(`request failed: ${url}`);
}

async function anilist(year: number) {
  const body = await request("https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: aniListQuery, variables: { year } }),
  });
  return (JSON.parse(body).data.Page.media as AniListMedia[]).filter(
    (media) => media.idMal !== null,
  );
}

function decode(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseTheme(line: string, kind: "OP" | "ED", index: number) {
  const numbered = line.match(
    /^\s*\d+\s*:\s*["“](.*?)["”]\s+by\s+(.+?)(?:\s*\([^)]*\))?\s*$/i,
  );
  const unnumbered = line.match(
    /^\s*["“](.*?)["”]\s+by\s+(.+?)(?:\s*\([^)]*\))?\s*$/i,
  );
  const match = numbered ?? unnumbered;
  if (!match) return null;
  const title = match[1].trim();
  const artist = match[2].trim().replace(/[.。]$/, "");
  if (!title || !artist) return null;
  return { artist, title, theme: `${kind}${index}` };
}

function parseMalThemes(html: string) {
  const themes: Array<{
    artist: string;
    title: string;
    theme: string;
  }> = [];
  for (const [, heading, section] of html.matchAll(
    /<h2>(Opening|Ending) Theme<\/h2>([\s\S]*?)(?=<h2>|$)/g,
  )) {
    const kind = heading === "Opening" ? "OP" : "ED";
    // A row with music links wraps the title in an <a> whose
    // javascript: href quotes the title too, so the title is read from the
    // row's text with the tags removed.
    for (const match of section.matchAll(
      /<span class="theme-song-index">\s*(\d+):<\/span>([\s\S]*?)<span class="theme-song-artist">\s*by\s+([^<]+)<\/span>/g,
    )) {
      const title = decode(match[2].replace(/<[^>]*>/g, "")).match(
        /"([^"]+)"/,
      )?.[1];
      if (title === undefined) continue;
      const parsed = parseTheme(
        `${match[1]}: "${title}" by ${decode(match[3])}`,
        kind,
        Number(match[1]),
      );
      if (parsed) themes.push(parsed);
    }
  }
  return themes;
}

async function main() {
  const seedFile = JSON.parse(await readFile(seedPath, "utf8")) as Record<
    string,
    Seed
  >;
  const seed = seedFile.anime;
  if (!seed) throw new Error("anime seed missing");
  // The crawl owns `work`, `themes` and the songs it listed, each of which has
  // a theme; a run replaces them, so a parser fix also removes what the old
  // parser wrote. Editorial songs have no theme and stay.
  const crawled = new Set(Object.keys(seed.themes ?? {}));
  const songs: Record<string, string[]> = Object.fromEntries(
    Object.entries(seed.songs ?? {}).map(([decade, list]) => [
      decade,
      list.filter((key) => !crawled.has(key)),
    ]),
  );
  const work: Record<string, string> = {};
  const themes: Record<string, string> = {};
  const shows: Record<string, string[]> = {};
  let found = 0;
  const accepted: Array<{
    year: number;
    show: string;
    theme: string;
    artist: string;
    title: string;
  }> = [];
  for (let year = 1985; year <= 2025; year += 1) {
    const media = await anilist(year);
    shows[year] = media.map(
      (entry) => entry.title.english || entry.title.romaji,
    );
    for (const show of media) {
      if (show.idMal === null) continue;
      const body = await request(`https://myanimelist.net/anime/${show.idMal}`);
      for (const parsed of parseMalThemes(body)) {
        found += 1;
        const key = `${parsed.artist}|${parsed.title}`;
        const decade = Math.floor(year / 10) * 10;
        const decadeSongs = (songs[decade] ??= []);
        if (
          !decadeSongs.some(
            (entry) => entry.toLowerCase() === key.toLowerCase(),
          )
        )
          decadeSongs.push(key);
        work[key] ??= show.title.english || show.title.romaji;
        themes[key] ??= parsed.theme;
        accepted.push({ year, show: work[key], ...parsed });
      }
    }
  }
  seed.songs = songs;
  seed.work = work;
  seed.themes = themes;
  await writeFile(seedPath, `${JSON.stringify(seedFile, null, 2)}\n`);
  console.log(JSON.stringify({ shows, themesFound: found, accepted }, null, 2));
}

await main();
