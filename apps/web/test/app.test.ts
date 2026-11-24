import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStats } from "../src/aggregate";
import { app } from "../src/app";
import { database } from "../src/db";
import {
  resolvePageTracks,
  storeListens,
  trackCandidates,
  type ExistingTrack,
} from "../src/matching";
import { normalizeText, trackKey } from "../src/normalize";
import { readPage, speculates } from "./html";

const now = Math.floor(Date.now() / 1000);

async function seedUser(
  source: Partial<{
    cursor: number | null;
    backfill_before: number | null;
  }> = {},
) {
  await env.DB.prepare(
    "INSERT INTO users (github_id, name, created_at) VALUES (1, 'alice', ?1)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind, account, cursor, backfill_before, next_pull_at)
       VALUES (10, 1, 'spotify', 'alice-sp', ?1, ?2, ?3)`,
  )
    .bind(source.cursor ?? null, source.backfill_before ?? null, now)
    .run();
}

async function count(table: string) {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>();
  return result?.count ?? 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalisation", () => {
  it.each([
    ["Beyoncé", "beyonce"],
    ["Weird Fishes/ Arpeggi - Remastered", "weirdfishesarpeggi"],
    ["Radiohead - Topic", "radiohead"],
    ["Song (Official Video)", "song"],
    ["Song - Explicit", "song"],
    ["Song - Stereo", "song"],
    ["Mono", "mono"],
    ["Stereo", "stereo"],
    ["Live Version", "liveversion"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeText(input, input.includes("Topic"))).toBe(expected);
  });

  it("builds the artist and title key with the contract separator", () => {
    expect(trackKey("Radiohead", "Weird Fishes/ Arpeggi")).toBe(
      "radiohead\u001fweirdfishesarpeggi",
    );
  });
});

describe("ListenBrainz ingestion", () => {
  it.each([
    {
      name: "reuses an MBID track created earlier on the page",
      inputs: [
        {
          kind: "listenbrainz",
          sourceKey: "created-a",
          artist: "Created Artist",
          title: "Created Song",
          mbid: "created-mbid",
          listenedAt: now - 100,
          userId: 1,
          sourceId: 10,
        },
        {
          kind: "listenbrainz",
          sourceKey: "created-b",
          artist: "Created Artist",
          title: "Changed Song",
          mbid: "created-mbid",
          listenedAt: now - 200,
          userId: 1,
          sourceId: 10,
        },
      ],
    },
  ])("$name", ({ inputs }) => {
    const result = resolvePageTracks(inputs, new Map(), []);

    expect(result.newTracks).toHaveLength(1);
    expect(result.listens.map((listen) => listen.trackKey)).toEqual([
      result.newTracks[0]?.key,
      result.newTracks[0]?.key,
    ]);
  });

  it("uses indexed track lookups for page candidates", async () => {
    await seedUser();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('unrelated', 'Unrelated') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM numbers WHERE n < 200
      )
      INSERT INTO tracks (key, artist_id, title, mbid, isrc)
      SELECT 'unrelated' || n || char(31) || 'track', ?1,
        'Track ' || n, 'unrelated-mbid-' || n, 'unrelated-isrc-' || n
      FROM numbers`,
    )
      .bind(artist?.id)
      .run();

    const query = trackCandidates(database(env.DB), [
      { normalizedKey: "page\u001ftrack", mbid: "page-mbid", isrc: null },
    ]).toSQL();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.params)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);

    expect(details.some((detail) => /SCAN tracks/i.test(detail))).toBe(false);
    expect(
      details.some((detail) =>
        /USING (?:COVERING )?INDEX (?:sqlite_autoindex_tracks_1|tracks_mbid|tracks_isrc)/i.test(
          detail,
        ),
      ),
    ).toBe(true);
  });

  it("walks alias, MBID, and key matches in order", () => {
    const aliasTrack: ExistingTrack = {
      id: 1,
      key: "aliasartist\u001faliassong",
      mbid: null,
      isrc: null,
      artistKey: "aliasartist",
      titleKey: "aliassong",
    };
    const mbidTrack: ExistingTrack = {
      id: 2,
      key: "mbidartist\u001fmbidsong",
      mbid: "mbid-1",
      isrc: null,
      artistKey: "mbidartist",
      titleKey: "mbidsong",
    };
    const keyTrack: ExistingTrack = {
      id: 3,
      key: "keyartist\u001fkeysong",
      mbid: null,
      isrc: null,
      artistKey: "keyartist",
      titleKey: "keysong",
    };
    const result = resolvePageTracks(
      [
        {
          kind: "listenbrainz",
          sourceKey: "alias-source",
          artist: "Changed Artist",
          title: "Changed Title",
          listenedAt: now - 100,
          userId: 1,
          sourceId: 10,
        },
        {
          kind: "listenbrainz",
          sourceKey: "mbid-source",
          artist: "Mbid Artist",
          title: "Mbid Song",
          mbid: "mbid-1",
          listenedAt: now - 200,
          userId: 1,
          sourceId: 10,
        },
        {
          kind: "listenbrainz",
          sourceKey: "key-source",
          artist: "Key Artist",
          title: "Key Song",
          listenedAt: now - 300,
          userId: 1,
          sourceId: 10,
        },
      ],
      new Map([["alias-source", aliasTrack]]),
      [aliasTrack, mbidTrack, keyTrack],
    );

    expect(result.newTracks).toHaveLength(0);
    expect(result.listens.map((listen) => listen.trackKey)).toEqual([
      aliasTrack.key,
      mbidTrack.key,
      keyTrack.key,
    ]);
  });

  it("stores plays for alias, MBID, and key matches", async () => {
    await seedUser();
    const aliasArtist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('aliasartist', 'Alias Artist') RETURNING id",
    ).first<{ id: number }>();
    const aliasTrack = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('aliasartist\u001falias song', ?1, 'Alias Song') RETURNING id",
    )
      .bind(aliasArtist?.id)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO track_aliases (kind, source_key, track_id) VALUES ('listenbrainz', 'alias-source', ?1)",
    )
      .bind(aliasTrack?.id)
      .run();
    const mbidArtist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('mbidartist', 'Mbid Artist') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title, mbid) VALUES ('mbidartist\u001fmbid song', ?1, 'Mbid Song', 'mbid-1')",
    )
      .bind(mbidArtist?.id)
      .run();
    const keyArtist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('keyartist', 'Key Artist') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('keyartist\u001fkey song', ?1, 'Key Song')",
    )
      .bind(keyArtist?.id)
      .run();

    expect(
      await storeListens(
        database(env.DB),
        [
          {
            kind: "listenbrainz",
            sourceKey: "alias-source",
            artist: "Changed Artist",
            title: "Changed Title",
            listenedAt: now - 400,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "mbid-source",
            artist: "Mbid Artist",
            title: "Mbid Song",
            mbid: "mbid-1",
            listenedAt: now - 500,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "key-source",
            artist: "Key Artist",
            title: "Key Song",
            listenedAt: now - 600,
            userId: 1,
            sourceId: 10,
          },
        ],
        "listenbrainz",
      ),
    ).toBe(3);
    expect(await count("plays")).toBe(3);
  });

  it("deduplicates page tracks and reuses a known alias", async () => {
    await seedUser();
    const knownInput = {
      kind: "listenbrainz",
      sourceKey: "known-source",
      artist: "Known Artist",
      title: "Known Song",
      mbid: "rec-1",
      listenedAt: now - 300,
      userId: 1,
      sourceId: 10,
    };
    expect(
      await storeListens(database(env.DB), [knownInput], "listenbrainz"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT mbid FROM artists WHERE key = 'knownartist'",
      ).first<{ mbid: string | null }>(),
    ).toEqual({ mbid: null });
    expect(
      await env.DB.prepare(
        "SELECT mbid FROM tracks WHERE key = 'knownartist\u001fknownsong'",
      ).first<{ mbid: string | null }>(),
    ).toEqual({ mbid: "rec-1" });
    const knownTrack = await env.DB.prepare(
      "SELECT track_id FROM track_aliases WHERE kind = 'listenbrainz' AND source_key = 'known-source'",
    ).first<{ track_id: number }>();

    expect(
      await storeListens(
        database(env.DB),
        [
          {
            kind: "listenbrainz",
            sourceKey: "recording-shared-a",
            artist: "Artist One",
            title: "Shared Song",
            mbid: "shared-mbid",
            listenedAt: now - 100,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "recording-shared-b",
            artist: "Artist Two",
            title: "Shared Song",
            mbid: "shared-mbid",
            listenedAt: now - 200,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "recording-shared-a",
            artist: "Artist Three",
            title: "Different Song",
            mbid: "shared-mbid",
            listenedAt: now - 250,
            userId: 1,
            sourceId: 10,
          },
          { ...knownInput, listenedAt: now - 400, artist: "Changed Artist" },
        ],
        "listenbrainz",
      ),
    ).toBe(4);

    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tracks WHERE mbid = 'shared-mbid'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const aliases = await env.DB.prepare(
      `SELECT source_key, track_id FROM track_aliases
       WHERE kind = 'listenbrainz'
         AND source_key IN ('recording-shared-a', 'recording-shared-b')
       ORDER BY source_key`,
    ).all<{ source_key: string; track_id: number }>();
    expect(aliases.results).toHaveLength(2);
    expect(aliases.results[0]?.track_id).toBe(aliases.results[1]?.track_id);
    expect(aliases.results[0]?.track_id).not.toBe(knownTrack?.track_id);
    expect(
      await env.DB.prepare(
        "SELECT track_id FROM track_aliases WHERE kind = 'listenbrainz' AND source_key = 'known-source'",
      ).first<{ track_id: number }>(),
    ).toEqual(knownTrack);
  });

  it("resolves every page listen to an existing representative track", async () => {
    await seedUser();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('x', 'X') RETURNING id",
    ).first<{ id: number }>();
    const track = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('x\u001ft', ?1, 'T') RETURNING id",
    )
      .bind(artist?.id)
      .first<{ id: number }>();
    const inputs = [
      {
        kind: "listenbrainz",
        sourceKey: "recording-m-a",
        artist: "X",
        title: "T",
        mbid: "m",
        listenedAt: now - 100,
        userId: 1,
        sourceId: 10,
      },
      {
        kind: "listenbrainz",
        sourceKey: "recording-m-b",
        artist: "X feat Y",
        title: "T",
        mbid: "m",
        listenedAt: now - 200,
        userId: 1,
        sourceId: 10,
      },
      {
        kind: "listenbrainz",
        sourceKey: "recording-m-c",
        artist: "X and Y",
        title: "T",
        mbid: "m",
        listenedAt: now - 300,
        userId: 1,
        sourceId: 10,
      },
    ];

    expect(await storeListens(database(env.DB), inputs, "listenbrainz")).toBe(
      3,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM tracks").first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
    expect(await count("plays")).toBe(3);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM plays
         WHERE track_id = ?1`,
      )
        .bind(track?.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 3 });
  });

  it("removes a play from totals when it becomes a duplicate", async () => {
    await seedUser();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('artist', 'Artist') RETURNING id",
    ).first<{ id: number }>();
    const track = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('artist\\u001ftrack', ?1, 'Track') RETURNING id",
    )
      .bind(artist?.id)
      .first<{ id: number }>();
    const dayStart = Math.floor(now / 86400) * 86400;
    const play = (playedAt: number) =>
      env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, track_id) VALUES (1, ?1, 10, ?2)",
      ).bind(playedAt, track?.id);
    await play(dayStart + 3600).run();
    await play(dayStart + 7200).run();
    const rollup = (table: string) =>
      env.DB.prepare(`SELECT plays FROM ${table}`).first<{ plays: number }>();
    expect(await count("track_totals")).toBe(1);
    expect(await count("daily_totals")).toBe(1);
    expect(await count("artist_totals")).toBe(1);
    expect(await rollup("daily_totals")).toEqual({ plays: 2 });
    expect(await rollup("artist_totals")).toEqual({ plays: 2 });

    const undup = (playedAt: number) =>
      env.DB.prepare(
        "UPDATE plays SET dup = 1 WHERE user_id = 1 AND played_at = ?1 AND source_id = 10",
      ).bind(playedAt);
    await undup(dayStart + 3600).run();
    expect(await count("track_totals")).toBe(1);
    expect(await count("daily_totals")).toBe(1);
    expect(await count("artist_totals")).toBe(1);
    expect(await rollup("daily_totals")).toEqual({ plays: 1 });
    expect(await rollup("artist_totals")).toEqual({ plays: 1 });

    await undup(dayStart + 7200).run();
    expect(await count("track_totals")).toBe(0);
    expect(await count("daily_totals")).toBe(0);
    expect(await count("artist_totals")).toBe(0);
  });
});

describe("profile API", () => {
  it("returns each period and keeps hidden users private", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, is_public, created_at) VALUES (2, 'hidden', 0, ?1)",
    )
      .bind(now)
      .run();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('artist', 'Artist') RETURNING id",
    ).first<{ id: number }>();
    const track = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES (?1, ?2, 'Track') RETURNING id",
    )
      .bind(`artist\u001ftrack`, artist?.id)
      .first<{ id: number }>();
    for (const playedAt of [now - 60, now - 8 * 86400, now - 31 * 86400]) {
      await env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, track_id) VALUES (1, ?1, 10, ?2)",
      )
        .bind(playedAt, track?.id)
        .run();
    }
    for (const period of ["week", "month", "all"]) {
      const response = await SELF.fetch(
        `https://music.rising.sh/u/alice.json?period=${period}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json<any>();
      expect(body.schema).toBe(1);
      expect(body.period).toBe(period);
      expect(body.plays).toBe(
        period === "week" ? 1 : period === "month" ? 2 : 3,
      );
      if (period === "week")
        expect(response.headers.get("Content-Security-Policy")).toBe(
          "default-src 'none'; style-src 'unsafe-inline'",
        );
    }
    expect(
      (await SELF.fetch("https://music.rising.sh/u/hidden.json")).status,
    ).toBe(404);
    expect(
      (await SELF.fetch("https://music.rising.sh/u/unknown.json")).status,
    ).toBe(404);
  });

  it("renders the profile page with its sources and update time", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind) VALUES (11, 1, 'ytmusic')",
    ).run();
    const response = await SELF.fetch("https://earshot.rising.sh/u/alice");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<h1 class="profile-name">alice</h1>');
    expect(html).toContain('<span class="source-pill">Spotify</span>');
    expect(html).toContain('<span class="source-pill">YouTube Music</span>');
    expect(html).toMatch(
      /Updated\s*<time datetime="[^"]+">\d{1,2} \w{3} \d{4}, \d\d:\d\d UTC/,
    );
    expect(html).toContain('aria-current="page"');
  });

  it("leads each period choice to a page holding the region it replaces", async () => {
    await seedUser();
    const site = "https://earshot.rising.sh";
    for (const start of ["/u/alice?period=week", "/play/board"]) {
      const page = await readPage(
        await (await SELF.fetch(site + start)).text(),
        site + start,
      );
      const choices = page.links.filter((link) => link.swap !== null);
      expect(choices.length, start).toBeGreaterThan(1);
      for (const choice of choices) {
        const next = await readPage(
          await (await SELF.fetch(choice.href)).text(),
          choice.href,
        );
        // The swapped-in region exists, and it marks the choice as current.
        expect(next.ids, choice.href).toContain(choice.swap);
        expect(
          next.links.some(
            (link) =>
              link.swap !== null && link.href === choice.href && link.current,
          ),
          choice.href,
        ).toBe(true);
      }
    }
  });

  it("speculates only links whose GET leaves the database as it was", async () => {
    await seedUser();
    const session = `sess_alice_${"s".repeat(30)}`;
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session)),
    );
    await env.DB.prepare(
      "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, 1, ?2)",
    )
      .bind(hash, now + 86400)
      .run();
    const site = "https://earshot.rising.sh";
    const get = (url: string, signedIn: boolean) =>
      SELF.fetch(url, {
        headers: signedIn ? { cookie: `__Host-session=${session}` } : {},
        redirect: "manual",
      });
    const dump = async () => {
      const { results: tables } = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      ).all<{ name: string }>();
      const rows: Record<string, unknown[]> = {};
      for (const { name } of tables)
        rows[name] = (
          await env.DB.prepare(`SELECT * FROM "${name}"`).all()
        ).results;
      return rows;
    };

    // A visitor signed out sees the sign-in links, a member the account ones.
    const visits = [
      {
        signedIn: true,
        paths: [
          "/",
          "/u/alice",
          "/play/board",
          "/groups",
          "/friends",
          "/settings",
        ],
      },
      { signedIn: false, paths: ["/", "/sign-in", "/u/alice", "/play/board"] },
    ];
    const speculated = new Map<string, boolean>();
    for (const { signedIn, paths } of visits)
      for (const path of paths) {
        const page = await readPage(
          await (await get(site + path, signedIn)).text(),
          site + path,
        );
        const rules = page.speculation!;
        for (const link of page.links) {
          if (new URL(link.href).origin !== site) continue;
          if (
            [...rules.prefetch!, ...rules.prerender!].some((rule) =>
              speculates(rule.where, link),
            )
          )
            speculated.set(
              `${signedIn ? "member" : "visitor"} ${link.href}`,
              signedIn,
            );
        }
      }
    expect([...speculated.keys()]).toContain(`member ${site}/u/alice`);
    for (const [key, signedIn] of speculated) {
      const url = key.slice(key.indexOf(" ") + 1);
      const before = await dump();
      const response = await get(url, signedIn);
      expect(response.headers.get("set-cookie"), key).toBeNull();
      expect(await dump(), key).toEqual(before);
    }
  });

  it("pins the snapshot JSON for a fixed set of plays", async () => {
    const pinnedNow = 1_700_000_000;
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO artists (id, key, name) VALUES (1, 'artista', 'Artist A'), (2, 'artistb', 'Artist B')",
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, key, artist_id, title) VALUES
       (1, 'artistasongone', 1, 'Song One'),
       (2, 'artistasongtwo', 1, 'Song Two'),
       (3, 'artistbsongthree', 2, 'Song Three')`,
    ).run();
    const play = (playedAt: number, trackId: number, dup = 0) =>
      env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, track_id, dup) VALUES (1, ?1, 10, ?2, ?3)",
      ).bind(playedAt, trackId, dup);
    await play(pinnedNow - 3600, 1).run();
    await play(pinnedNow - 86400, 1).run();
    await play(pinnedNow - 3 * 86400, 2).run();
    await play(pinnedNow - 10 * 86400, 3).run();
    await play(pinnedNow - 40 * 86400, 2).run();
    await play(pinnedNow - 7200, 1, 1).run();

    const track = (title: string, artist: string, plays: number) => ({
      title,
      artist,
      plays,
      image: null,
    });
    const artist = (name: string, plays: number) => ({
      artist: name,
      plays,
      image: null,
    });
    const daily = (day: string, plays: number) => ({ day, plays });
    const base = {
      schema: 1,
      user: { name: "alice" },
      to: pinnedNow,
      updated_at: pinnedNow,
    } as const;

    expect(
      await getStats(database(env.DB), 1, "alice", "week", pinnedNow),
    ).toEqual({
      ...base,
      period: "week",
      from: pinnedNow - 7 * 86400,
      plays: 3,
      unique_tracks: 2,
      unique_artists: 1,
      top_tracks: [
        track("Song One", "Artist A", 2),
        track("Song Two", "Artist A", 1),
      ],
      top_artists: [artist("Artist A", 3)],
      daily: [
        daily("2023-11-11", 1),
        daily("2023-11-13", 1),
        daily("2023-11-14", 1),
      ],
    });
    expect(
      await getStats(database(env.DB), 1, "alice", "month", pinnedNow),
    ).toEqual({
      ...base,
      period: "month",
      from: pinnedNow - 30 * 86400,
      plays: 4,
      unique_tracks: 3,
      unique_artists: 2,
      top_tracks: [
        track("Song One", "Artist A", 2),
        track("Song Two", "Artist A", 1),
        track("Song Three", "Artist B", 1),
      ],
      top_artists: [artist("Artist A", 3), artist("Artist B", 1)],
      daily: [
        daily("2023-11-04", 1),
        daily("2023-11-11", 1),
        daily("2023-11-13", 1),
        daily("2023-11-14", 1),
      ],
    });
    expect(
      await getStats(database(env.DB), 1, "alice", "all", pinnedNow),
    ).toEqual({
      ...base,
      period: "all",
      from: null,
      plays: 5,
      unique_tracks: 3,
      unique_artists: 2,
      top_tracks: [
        track("Song One", "Artist A", 2),
        track("Song Two", "Artist A", 2),
        track("Song Three", "Artist B", 1),
      ],
      top_artists: [artist("Artist A", 4), artist("Artist B", 1)],
      daily: [
        daily("2023-10-05", 1),
        daily("2023-11-04", 1),
        daily("2023-11-11", 1),
        daily("2023-11-13", 1),
        daily("2023-11-14", 1),
      ],
    });
  });

  it("serves a snapshot when KV reads fail", async () => {
    await seedUser();
    const cache = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace;
    const response = await app.fetch(
      new Request("https://music.rising.sh/u/alice.json"),
      { DB: env.DB, CACHE: cache },
    );

    expect(response.status).toBe(200);
    expect(cache.get).toHaveBeenCalledOnce();
  });
});
