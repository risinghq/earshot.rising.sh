#!/usr/bin/env node
// Counts the songs that fan-made YouTube mixes of a category share, as
// evidence of what listeners play beyond each artist's top tracks.
//
//   node scripts/count-mixes.ts CATEGORY "QUERY" ["QUERY" ...] [--mixes N] [--write]
//
// Each query searches YouTube through yt-dlp. A video counts as a mix when it
// runs at least 30 minutes and lists at least 10 songs in its chapters or in
// timestamped description lines. Mixes write a line as "Title - Artist",
// "artist-title" or "Artist | Title", so a line is not split: its text goes to
// Deezer search, and the hit counts only when its artist and title both appear
// in the line. A song found in 2 or more mixes is printed with its sources;
// --write adds it to the category seed's `songs.any`, where curate.ts dates it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const seedPath = join(root, "scripts/curated-seeds.json");
const cacheDir = join(
  process.env.CURATE_CACHE ??
    join(process.env.HOME ?? ".", ".cache", "earshot-curate"),
  "mixes",
);
const userAgent = "Mozilla/5.0 (compatible; catalog-curation)";
const searchHits = 40;
const minSeconds = 1800;
const minLines = 10;

interface Video {
  id: string;
  title?: string;
  duration?: number;
  webpage_url?: string;
  description?: string;
  chapters?: Array<{ title: string }> | null;
}

interface DeezerHit {
  title?: string;
  title_short?: string;
  artist?: { name?: string };
}

async function cached(name: string, load: () => Promise<string | null>) {
  const path = join(
    cacheDir,
    createHash("sha256").update(name).digest("hex").slice(0, 32),
  );
  const hit = await readFile(path, "utf8").catch(() => null);
  if (hit !== null) return hit;
  const body = await load();
  if (body === null) return null;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, body);
  return body;
}

function ytdlp(args: string[]) {
  const result = spawnSync(
    "yt-dlp",
    ["--no-update", "--user-agent", userAgent, ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
  );
  return result.status === 0 ? result.stdout : null;
}

async function search(query: string) {
  const body = await cached(`search:${searchHits}:${query}`, async () =>
    ytdlp([
      "--flat-playlist",
      "--print",
      "%(id)s %(duration)s",
      `ytsearch${searchHits}:${query}`,
    ]),
  );
  return (body ?? "")
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([id, seconds]) => id && Number(seconds) >= minSeconds)
    .map(([id]) => id);
}

async function video(id: string): Promise<Video | null> {
  const body = await cached(`video:${id}`, async () =>
    ytdlp([
      "--skip-download",
      "--dump-json",
      `https://www.youtube.com/watch?v=${id}`,
    ]),
  );
  return body === null ? null : (JSON.parse(body) as Video);
}

const timestamp = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;

// The chapters when the video has 10 or more, else the description lines that
// carry a timestamp.
function trackLines(entry: Video) {
  const chapters = (entry.chapters ?? []).map((chapter) => chapter.title);
  if (chapters.length >= minLines) return chapters;
  return (entry.description ?? "")
    .split("\n")
    .filter((line) => timestamp.test(line));
}

function clean(line: string) {
  return line
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(
      /[([][^)\]]*(?:official|audio|mv|m\/v|lyrics?|video)[^)\]]*[)\]]/gi,
      " ",
    )
    .replace(/[^\p{L}\p{N}'&.!?() -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

let lastDeezer = 0;
async function deezer(query: string): Promise<DeezerHit[]> {
  const body = await cached(`deezer:${query}`, async () => {
    const wait = 150 - (Date.now() - lastDeezer);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastDeezer = Date.now();
    const response = await fetch(
      `https://api.deezer.com/search?limit=5&q=${encodeURIComponent(query)}`,
      {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(20_000),
      },
    ).catch(() => null);
    if (!response?.ok) return null;
    const text = await response.text();
    return text.includes('"error"') ? null : text;
  });
  return body === null ? [] : ((JSON.parse(body).data ?? []) as DeezerHit[]);
}

// The first hit whose artist and title both appear in the mix's line. A title
// part in brackets ("Gurenge (紅蓮華)") may be missing from the line.
async function identify(line: string) {
  const text = clean(line);
  if (text.length < 3) return null;
  const folded = fold(text);
  for (const hit of await deezer(text)) {
    const artist = hit.artist?.name;
    const title = hit.title_short ?? hit.title;
    if (!artist || !title) continue;
    const bare = fold(title.replace(/\s*[([][^)\]]*[)\]]/g, ""));
    if (
      bare.length > 0 &&
      folded.includes(fold(artist)) &&
      folded.includes(bare)
    )
      return `${artist}|${title}`;
  }
  return null;
}

function option(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

async function main() {
  const args = process.argv.slice(2);
  const wanted = option("--mixes", 10);
  const write = args.includes("--write");
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--mixes",
  );
  const [category, ...queries] = positional;
  if (!category || queries.length === 0)
    throw new Error(
      'usage: node scripts/count-mixes.ts CATEGORY "QUERY"... [--mixes N] [--write]',
    );
  const mixes: Array<{
    url: string;
    title: string;
    lines: number;
    found: number;
  }> = [];
  const counts = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const query of queries) {
    for (const id of await search(query)) {
      if (mixes.length >= wanted) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = await video(id);
      if (entry === null) continue;
      const lines = trackLines(entry);
      if (lines.length < minLines) continue;
      const url = `https://www.youtube.com/watch?v=${id}`;
      const songs = new Set<string>();
      for (const line of lines) {
        const song = await identify(line);
        if (song !== null) songs.add(song);
      }
      for (const song of songs)
        counts.set(song, (counts.get(song) ?? new Set()).add(url));
      mixes.push({
        url,
        title: entry.title ?? "",
        lines: lines.length,
        found: songs.size,
      });
      console.error(
        `${mixes.length}/${wanted} ${url} ${songs.size}/${lines.length} ${entry.title}`,
      );
    }
  }
  const shared = [...counts.entries()]
    .filter(([, urls]) => urls.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .map(([song, urls]) => ({ song, mixes: urls.size, sources: [...urls] }));
  let added: string[] = [];
  if (write) {
    const seeds = JSON.parse(await readFile(seedPath, "utf8"));
    const seed = seeds[category];
    if (!seed) throw new Error(`no seed named ${category}`);
    seed.songs ??= {};
    const known = new Set(
      Object.values(seed.songs as Record<string, string[]>)
        .flat()
        .map((song) => fold(song)),
    );
    added = shared
      .map((entry) => entry.song)
      .filter((song) => !known.has(fold(song)));
    seed.songs.any = [...(seed.songs.any ?? []), ...added];
    await writeFile(seedPath, `${JSON.stringify(seeds, null, 2)}\n`);
  }
  console.log(JSON.stringify({ category, mixes, shared, added }, null, 2));
}

await main();
