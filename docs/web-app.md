# Web app

This document is the design of the hosted music-stats service. The command-line
program that [Architecture](architecture.md) describes stays as it is, except
where [the crate section](#the-rust-crate) says otherwise.

The service gives each person a public listening profile at `/u/NAME`, a JSON
API at `/u/NAME.json` and an SVG card at `/u/NAME.svg` for a README, each with a
weekly, a monthly and an all-time view. Its value is history. The YouTube Music
history page holds about 200 plays and Spotify's recently-played endpoint holds
50, so the service stores every play it sees and the history grows with time.

```text
Spotify ─────── Cron Trigger pulls ─────────────────┐
                                                    ▼
YouTube Music ── user's GitHub Action ── POST ──▶ Worker ──▶ D1 (plays)
             └─ Cron Trigger pulls ────────────▶   │          KV (snapshots)
Phone ── Pano Scrobbler ── POST ──────────────────▶  │
                                                   ▼
                         /u/NAME    /u/NAME.json    /u/NAME.svg
```

The site is Earshot, at `https://earshot.rising.sh`. A subdomain of the
`rising.sh` zone fits the other projects on that zone, and a Worker
[custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
creates the DNS record and the certificate itself. Nothing speaks against it:
the session cookie is a `__Host-` cookie, which browsers keep to one host, so no
sibling subdomain can read it. The user-made SVG and JSON share the origin with
the dashboard, so they carry the headers in [Public surface](#public-surface).

The earlier `https://music.rising.sh` address stays a custom domain on the same
Worker. On it, a GET or HEAD for a page answers `301` to the same path and query
on `earshot.rising.sh`. Machine traffic is served as before, with no redirect:
the API under `/api/`, the scrobbler routes under `/1/`, the sign-in routes
under `/auth/`, the profile JSON and card under `/u/`, and every request that
asks for a WebSocket upgrade. One middleware holds the rule and its path list.

## 1. Layout and languages

One repository. The root `Cargo.toml` is a virtual Cargo workspace over
`crates/*`, and each directory under `apps/` is a deployed app. The published
crate is [`crates/music-stats/`](../crates/music-stats/Cargo.toml). Its
`include` list names `src/**` and `Cargo.toml`, and Cargo adds `readme.md` and
`LICENSE`, so `apps/web/` never enters the published crate.

```text
crates/music-stats/     the Rust crate: Cargo.toml, src/, tests/
apps/web/
  wrangler.jsonc        Worker, D1, KV, cron, custom domain, assets
  migrations/           D1 migrations, applied with wrangler
  drizzle.config.ts     where drizzle-kit reads the schema and writes migrations
  client/               browser scripts, stylesheets and fonts, built by Vite
  public/               files served under a fixed name: favicon, _headers
  src/                  the Worker, in TypeScript, one folder per feature
    index.tsx           the Worker's entry: fetch, the cron and the Durable Objects
    app.tsx             mounts each feature's routes
    bindings.d.ts       the bindings and secrets the Worker reads
    env.ts              names them Env for imports
    account/            sign-in, sessions, the sign-in page and settings
    listening/          sources and plays: upload, ListenBrainz API, Spotify,
                        YouTube Music, matching, duplicates and the pull cron
    profile/            the public profile page, its stats, card and images
    social/             friends, groups and the group blend
    play/               the game; routes.tsx mounts it under /play
      catalog/          categories, feeds, the track pool, eras, For you
      game/             rules, rounds, outcomes and results every mode shares
      hub/ solo/ room/ match/ board/ artist/
                        one folder per screen or mode, each with its page
    admin/              the admin pages
    platform/           the database, secrets, JSON fetch and host redirect
    ui/                 the shared Hono JSX components
  test/                 vitest tests that run in workerd; client/ holds the
                        browser components' own tests
```

A feature folder owns its routes, pages and data. A module imports another
feature's module directly; `platform/` and `ui/` import no feature but
`account/auth` (the session user the shell shows).

The Worker is TypeScript, for these reasons:

- The Worker shares no code with the crate. Each holds its own YouTube page
  parser, the crate in Rust for the GitHub Action path and the Worker in
  TypeScript for the pulled path. The things the Worker owns, such as matching
  and aggregation, exist nowhere in the crate.
- workers-rs adds a wasm build step and a second toolchain to every Worker
  change. TypeScript runs on the platform's own runtime.
- The Worker renders the pages too, so one language covers routing, SQL and
  HTML.

The frontend is the Worker. The profile page is public and has to carry link
preview tags, so the Worker renders it as HTML on the server, with the charts as
inline SVG. The sign-in and settings pages are server-rendered forms. The pages
need no client script, and the built files in `apps/web/dist/` are served by the
Worker's `assets` binding. Cloudflare documents this route in its
[migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
and says Workers offer a broader set of features than Pages. It replaces a
separate Pages project. One deploy then covers the API and the pages, and no
request crosses an origin, so there is no CORS to configure for the dashboard.
The static asset requests are free on Workers, as on Pages.

Libraries: [Hono](https://hono.dev) for routing and its JSX for server HTML,
[Solid](https://solidjs.com) for the room's phone and TV pages, Vite to build
the browser assets, valibot to validate the upload body, every socket message
(`src/play/room/messages.ts`) and every third-party JSON reply
(`src/platform/fetch-json.ts`), vitest with `@cloudflare/vitest-plugin` so the
tests run against real workerd and D1, and msw through `@msw/cloudflare` for the
Worker's outbound requests. `test/network.ts` owns the mock network: a test adds
handlers for the services it reaches, and a request no handler matches fails the
test. Formatting and linting follow the repository: oxfmt and oxlint.

### The component layer

The pages are built from typed Hono JSX components in `src/ui/`: `Page` (the
shell), `Section` (a card), `Stats`, `RankedList`, `PillLink` and `PillButton`,
`Segmented`, `Notice`, `TokenDisplay`, `EmptyState` and `DayBars`. Each
feature's pages compose them, such as `src/profile/page.tsx` and
`src/account/settings.tsx`. `Page` renders the header and footer; each other
component has one job and takes typed props. The game's pages sit in the folder
of their mode: `hub/page`, `solo/page` with `solo/round-page` and
`solo/final-page`, `artist/page`, `board/page`, `match/page`, `room/page` and
`room/screen-page`. Parts that the round, final and room pages share are in
`play/game/parts.tsx`.

Every visual value lives in `client/styles/base.css` as custom properties on
`:root`: the neutral and accent colours in OKLCH, the type scale, the spacing
scale, radii, shadows, easing and durations. Components read the tokens; the
dark theme is a second set of the same names under
`@media (prefers-color-scheme: dark)`, and `prefers-reduced-motion` turns every
transition off. Bricolage Grotesque is self-hosted as a variable woff2 (weight
and optical size) in `client/fonts/` with its OFL licence. The site pages' only
script is `client/site.ts`: it closes the account menu, copies an issued token,
and posts a `data-inline` form over fetch. Its `client/behaviours.ts` keys the
rest on data attributes: `data-confirm` asks before a form posts,
`data-arms="ID"` keeps button ID disabled until the input holds its `data-name`,
`data-local-zone` defaults a select to the browser's zone, `data-fold` and
`data-unfold` fold a long list, `data-setup` points the hub's tiles at the
chosen way to play, and `data-export-all` saves every export page. A swap runs
them again on the region it brings in. Through `client/swap.ts` it follows a
link inside `data-swap="ID"` by fetching the page and swapping in its element
with that id. The profile's periods, the board's periods and the genre chips
swap `#main` this way: the page keeps its header and scroll, the address and
title change, and Back swaps the old view in. A pointer over such a link, a
press, focus or an idle page (for a period control's choices) starts the fetch,
so the click usually finds the page ready. All of these are progressive
enhancement over working markup.

Every site page carries speculation rules (`src/ui/shell.tsx`). Chromium
prefetches a linked page eagerly (a 10 ms hover, or 50 ms on a phone's screen)
and prerenders it on intent (a 200 ms hover or a press), so the next page shows
at once. Only pages whose GET changes nothing are listed: game, room and match
pages, `/auth`, `/admin` and the `.json`/`.svg` exports are not. Safari and
Firefox ignore the rules and load the page on click. Cross-document view
transitions (`@view-transition` in `client/styles/shell.css`) fade between site
pages while the header and the tab bar stay put, except under
`prefers-reduced-motion`.

### Browser assets

`vite build` turns `client/` into `dist/`, and wrangler runs it before `dev` and
`deploy`; `npm test` and `npm run typecheck` run it first too. Vite minifies
every file and names it by its content hash under `/assets/`, so
`public/_headers` marks that path `immutable` for a year: a returning visitor
fetches a file again only after it changed. The Worker reads the hashed names
from the build manifest through `src/ui/assets.tsx`, which renders the `<link>`,
`<script type="module">` and `modulepreload` tags.

The stylesheet is split by the component it styles, one file per area in
`client/styles/`, and a page loads only the groups it uses:

| Group    | Areas                      | Loaded by                      |
| -------- | -------------------------- | ------------------------------ |
| `common` | base tokens, controls      | every page                     |
| `site`   | header, hub, artist, pages | site pages, admin, solo, match |
| `game`   | the round, player, choices | solo, match, room              |
| `admin`  | admin tables               | admin pages                    |
| `room`   | lobby, room round, sheets  | the room's phone page          |
| `screen` | the TV                     | the room's TV page             |

`Page` takes the list as `styles`, defaulting to `common` and `site`, plus
`game` under the game chrome. A rule shared by two groups belongs in
`controls.css`. A group loads after `common`, so a rule that overrides a control
wins without extra specificity.

The server renders every page with Hono JSX. A page that changes while it is
open draws that part in the browser with Solid, in TypeScript under `client/`:
the room's phone page is `client/room/` and its TV page is `client/screen/`,
each entered at `main.tsx`, with the pieces both use in `client/ui/`. Their
components import the room's message types from `src/play/room/protocol.ts` and
the game's rules from `src/play/game/rules.ts`, the same modules the Durable
Object uses, so a change to a message or a rule fails the type check on both
sides. The solo page (`client/solo.ts`), the matchmaker (`client/match.ts`) and
`client/site.ts` stay plain TypeScript over the server's markup: they enhance a
page that already works, and Solid's runtime would add 16 kB gzipped to each
without drawing anything. `client/tsconfig.json` typechecks the browser code
with Solid's JSX, `test/tsconfig.json` adds the test runtime's and Vite's types
to the Worker's, and `npm run typecheck` runs all three projects. Markup only
the server can build, such as the sign-in links, comes in a `<template>` the
components copy from. The components' tests run in happy-dom, a second vitest
project beside the workerd one.

## 2. Data model

All times are Unix seconds in UTC. A table holds only what a query reads.

`apps/web/src/platform/db/schema.ts` declares the schema in
[Drizzle](https://orm.drizzle.team/docs/connect-cloudflare-d1), and queries are
built from it, so a row's type comes from its table. Columns are camelCase in
TypeScript and snake_case in SQL. `src/platform/db/index.ts` holds one query
builder per D1 binding and `batchWrites`, which runs a list of writes in
batches.

`npm run db:generate` diffs the schema against the last migration's snapshot and
writes `migrations/<timestamp>_<name>/migration.sql`. CI runs
`npm run db:check`, which fails when the schema has a change no migration holds.
Drizzle does not model triggers: a trigger goes in an empty migration from
`npx drizzle-kit generate --custom --name <name>`. Migrations 0001 to 0022 are
flat files from before Drizzle, and production recorded them by those names. The
`20261124141330_baseline` folder runs nothing; its snapshot is the schema they
built. `migrations_pattern` in `wrangler.jsonc` applies both shapes in order.

Read each generated migration before committing it. SQLite cannot add a
constraint to an existing table, so drizzle-kit rebuilds the table: it creates
`__new_<table>`, copies the rows, drops the old table and renames the new one.
D1 runs a migration inside a transaction, where `PRAGMA foreign_keys=OFF` has no
effect, and `PRAGMA defer_foreign_keys` does not stop cascades
([D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)).
So that DROP TABLE runs every `ON DELETE CASCADE` that points at the table, and
it drops the table's triggers. Write such a change by hand instead. A constraint
the tables already have needs only the snapshot: keep the generated folder and
replace its SQL with a comment, as `20261124145402_composite_uniques` does.

The SQL below is what those migrations build.

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  hash BLOB PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL
    CHECK (kind IN ('lastfm', 'listenbrainz', 'spotify', 'ytmusic',
                   'spotify_import', 'ytmusic_import')),
  account TEXT,
  secret BLOB,
  cursor INTEGER,
  backfill_before INTEGER,
  next_pull_at INTEGER,
  idle_pulls INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'gap', 'error')),
  error TEXT,
  last_ok_at INTEGER,
  last_page TEXT,
  play_seq INTEGER NOT NULL DEFAULT 0,
  gap_at INTEGER,
  maybe_missing INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  tz TEXT,
  UNIQUE (user_id, kind)
);
CREATE INDEX sources_due ON sources (next_pull_at)
  WHERE next_pull_at IS NOT NULL;

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources (id),
  hash BLOB NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX tokens_source ON tokens (source_id);

CREATE TABLE artists (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mbid TEXT
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  title TEXT NOT NULL,
  mbid TEXT,
  isrc TEXT
);
CREATE INDEX tracks_mbid ON tracks (mbid) WHERE mbid IS NOT NULL;
CREATE INDEX tracks_isrc ON tracks (isrc) WHERE isrc IS NOT NULL;

CREATE TABLE track_aliases (
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  PRIMARY KEY (kind, source_key)
) WITHOUT ROWID;

CREATE TABLE plays (
  user_id INTEGER NOT NULL REFERENCES users (id),
  played_at INTEGER NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources (id),
  ref TEXT NOT NULL DEFAULT '',
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  dup INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, played_at, source_id, ref)
) WITHOUT ROWID;

CREATE TABLE track_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  plays INTEGER NOT NULL,
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
) WITHOUT ROWID;
CREATE INDEX track_totals_top ON track_totals (user_id, plays DESC);

CREATE TABLE daily_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  day INTEGER NOT NULL,
  plays INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;

CREATE TABLE artist_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  plays INTEGER NOT NULL,
  PRIMARY KEY (user_id, artist_id)
) WITHOUT ROWID;
CREATE INDEX artist_totals_top ON artist_totals (user_id, plays DESC);

CREATE TRIGGER plays_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO track_totals (user_id, track_id, plays, last_played_at)
  VALUES (NEW.user_id, NEW.track_id, 1, NEW.played_at)
  ON CONFLICT (user_id, track_id) DO UPDATE SET
    plays = plays + 1,
    last_played_at = max(last_played_at, NEW.played_at);
END;

CREATE TRIGGER plays_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE track_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id AND track_id = NEW.track_id;
  DELETE FROM track_totals
  WHERE user_id = NEW.user_id AND track_id = NEW.track_id AND plays = 0;
END;

CREATE TRIGGER plays_day_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO daily_totals (user_id, day, plays)
  VALUES (NEW.user_id, NEW.played_at / 86400, 1)
  ON CONFLICT (user_id, day) DO UPDATE SET plays = plays + 1;
END;

CREATE TRIGGER plays_day_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE daily_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id AND day = NEW.played_at / 86400;
  DELETE FROM daily_totals
  WHERE user_id = NEW.user_id AND day = NEW.played_at / 86400 AND plays = 0;
END;

CREATE TRIGGER plays_artist_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO artist_totals (user_id, artist_id, plays)
  SELECT NEW.user_id, tracks.artist_id, 1
  FROM tracks WHERE tracks.id = NEW.track_id
  ON CONFLICT (user_id, artist_id) DO UPDATE SET plays = plays + 1;
END;

CREATE TRIGGER plays_artist_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE artist_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id
    AND artist_id = (SELECT artist_id FROM tracks WHERE id = NEW.track_id);
  DELETE FROM artist_totals
  WHERE user_id = NEW.user_id
    AND artist_id = (SELECT artist_id FROM tracks WHERE id = NEW.track_id)
    AND plays = 0;
END;
```

What each part decides:

- **`users`.** The key is GitHub's numeric id, because a login can change.
  `name` is the URL slug. It starts as the GitHub login, lowercase, and the user
  may change it. A name has 1 to 39 characters from `a-z`, `0-9` and `-`, with
  no hyphen at either end, and a reserved list (`api`, `auth`, `settings`, `u`)
  stays unavailable. A name has no dot, so `/u/NAME.json` and `/u/NAME.svg`
  parse at the last dot without doubt. `AUTOINCREMENT` stops an id from coming
  back after a deletion, so a cached snapshot never reaches a new account.
- **`sources`.** A user has at most one source of each kind. `account` is the
  Spotify user id, and is null for YouTube Music. `secret` holds the Spotify
  refresh token or the YouTube Music cookie, encrypted with AES-GCM under the
  `SOURCE_ENCRYPTION_KEY` Worker secret, so a leaked database dump holds no
  usable credential. `cursor` is the newest play ingested. `backfill_before`,
  `gap_before` and `gap_floor` remain from a removed history walk and are
  unused. `next_pull_at` is null for a source that only pushes. `idle_pulls`
  drives the back-off in [Pulled sources](#pulled-sources). `tz` is the IANA
  time zone the YouTube pull resolves "Today" and "Yesterday" in. Three columns
  serve YouTube Music only. `last_page` is the ordered list of `[day, video id]`
  pairs of the last accepted upload, as JSON, and `play_seq` counts the plays
  stored so far. `gap_at` is the time of the last upload that overlapped
  nothing, and `status = 'gap'` marks the source until an upload overlaps again.
  `maybe_missing` is the most plays that repeated songs may have hidden so far.
  Only an upload that changes the page adds to it, and a replay of the stored
  page never does ([Aligning a page](#aligning-a-page-with-the-last-one)).
- **`tokens`.** An upload token belongs to a YouTube Music source, and a
  scrobbler token to a `listenbrainz` source. The database keeps the SHA-256 of
  the token, never the token. A 256-bit random value needs no slow hash. `hint`
  is the last four characters, so the dashboard can tell two tokens apart. A
  token authenticates only the routes of its source's kind.
- **`tracks` and `artists`.** One catalogue shared by all users. It holds no
  personal data, so deleting an account leaves it alone.
  [Song matching](#4-song-matching) says how a row is found.
- **`track_aliases`.** The first time a source's own identity of a track is
  resolved, the answer is pinned here. A later change to the matching rules
  never moves old plays.
- **`plays`.** One row per play and per source. Its primary key is the identity
  of the play, so a repeat is rejected by the database and no code has to
  remember. `WITHOUT ROWID` makes the key the table itself: the same b-tree
  serves the uniqueness check and the range scans by time, and a play costs one
  row written. `dup` is 1 when another source holds the same play
  ([Cross-source duplicates](#cross-source-duplicates)).
- **`track_totals`, `daily_totals`, `artist_totals`.** Per-user counts of each
  track, of each UTC day and of each artist, kept by the triggers on `plays`, so
  the database enforces the invariant `plays = count of rows with dup = 0`. The
  all-time view reads them instead of grouping `plays`: the first rows of
  `track_totals_top` and `artist_totals_top` for the top lists, and
  `daily_totals` for the plays per day. A function that recounts from `plays`
  repairs a table that drifts; the nightly cron checks a sample of users.

### How a play stays unique

The primary key is `(user_id, played_at, source_id, ref)`, written with
`INSERT OR IGNORE`.

- **Spotify** gives each play a timestamp that is the same every time the API
  returns it. `ref` is empty. One source cannot record two plays in the same
  second. The track is not in the key on purpose: a source can correct titles
  after the fact, and a corrected title on a later pull must not become a second
  play. The first title seen wins.
- **YouTube Music** gives a day and no time, and nothing that names one play.
  The crate sends `day` only for plays under a heading that names a day. The
  service stores the play at 12:00 UTC of that day, as the crate already does,
  and sets `ref` to `<video id>#<seq>`, where `seq` comes from
  `sources.play_seq`, a counter that only grows. The key is unique by
  construction, so it cannot reject a replay. The service decides which plays of
  an upload are new by aligning the page with the last accepted page
  ([Aligning a page](#aligning-a-page-with-the-last-one)), and a guard on
  `play_seq` makes a replayed request insert nothing.
- **The phone scrobbler** gives a `listened_at` second and `ref` stays empty,
  like Spotify. A repeated submission of the same listen hits the same primary
  key and `INSERT OR IGNORE` stores it once.

The triggers fire only for a row that is really inserted. A conflict under
`INSERT OR IGNORE` fires nothing, so a replayed play changes no total. The
schema above was run against SQLite 3.53 and against wrangler 4.160.1's local D1
with this sequence: two inserts of one key, then a new key, and the total
read 2. D1 itself must be checked at the first milestone.

## 3. Upload API

Only YouTube Music uses it. The phone scrobbler has its own endpoint
([Phone scrobbler](#phone-scrobbler)) and Spotify is pulled.

```http
POST /api/v1/upload
Authorization: Bearer msu_<43 characters>
Content-Type: application/json

{
  "client": "music-stats/0.4.0",
  "plays": [
    {"day": "2026-11-11", "artist": "Radiohead",
     "title": "Weird Fishes/ Arpeggi", "video_id": "rSvTmvpx0JI"}
  ]
}
```

```json
{
  "received": 200,
  "inserted": 3,
  "duplicate": 197,
  "gap": false,
  "ambiguous": 0
}
```

- **Token.** `msu_` plus 32 random bytes in base64url. The dashboard shows it
  once, when the user creates it. The Worker hashes the header value and looks
  the hash up in `tokens`. A revoked or unknown token gets `401`. A token
  reaches one source of one user and nothing else. The user can create a new
  token and revoke the old one on the settings page.
- **Order.** `plays` lists the page as the crate read it, newest first, and the
  order is part of the contract: the Worker reads it to tell new plays from old
  ones. An empty `plays` changes nothing and gets `200`.
- **Fields.** `day` is a `YYYY-MM-DD` date between 2005-01-01 and tomorrow in
  UTC. `artist` and `title` hold 1 to 512 characters. `video_id` is 1 to 32
  characters from `A-Za-z0-9_-`. Unknown fields are rejected, so a typo does not
  pass silently.
- **Limits.** The body is at most 256 KiB, `plays` at most 1,000 items, and the
  `Content-Type` must be `application/json`. The Worker refuses
  `Content-Encoding`: a full body fits the limit uncompressed, so decompression
  would only add CPU time. The page holds about 200 plays, so a normal body is
  under 40 KiB. The crate sends the newest 1,000 plays of a longer page in one
  request. Several requests would read as several unrelated pages, and the older
  ones would count again.
- **Rate.** One upload per source every 30 seconds. The Worker reads
  `sources.last_ok_at` while it authenticates, so the check costs no extra
  query. A faster request gets `429` with `Retry-After`. A replayed page still
  updates `sources.last_ok_at` and `tokens.last_used_at`, so the limit applies
  to a re-run too. In the reply, `duplicate` is `received` minus `inserted`.
- **Atomic.** A body that fails validation gets `422` with the failing item
  indexes and nothing is stored. A valid body is written in one `db.batch()`,
  which D1 runs as a transaction, so a request lands whole or not at all.
  Duplicate marks run after the store in their own D1 calls, and a failed mark
  is redone by the next store or replay over the same span.
- **Statuses.** `200` for success, even when `inserted` is 0. `401`, `409` (two
  uploads raced, send again), `413`, `415`, `422` and `429` as above. No other
  code is returned for client mistakes.

### Replaying the overlap

The crate keeps no state between runs, because a GitHub runner starts empty.
Each run sends the whole page it reads, and the window overlaps the previous
upload by design. The service owns the cure, and it cannot be a unique key: the
history page names no play, and two plays of one video on one day look the same.
A key built from day, video and a count from the oldest play fails when the
page's oldest plays fall off. Three plays of a song, then a page holding the
last two of them and a new one, would number the new play with a key that
exists. The service instead keeps the last page and aligns the next one with it.

#### Aligning a page with the last one

`P` is `sources.last_page`, the `(day, video id)` pairs of the last accepted
upload, newest first. `N` is the new upload, with the same order. A page grows
at its head and loses plays at its tail, so `N` should begin with new plays and
continue with the head of `P`.

1. **Replay.** `N` equals `P` exactly, pair for pair. The upload is a replay of
   the last one, for example a re-run of the Action before a new play. The
   service stores nothing, answers `inserted` 0 and `ambiguous` 0, and leaves
   `maybe_missing`, `status`, `last_page` and `play_seq` as they are. The check
   compares the stored `last_page` text with the canonical JSON of `N`. It keeps
   no hash, because the page is already in the row the token check reads. Only
   an upload that changes the page goes on to the steps below.
2. **First upload.** `P` is null. Every play of `N` is new, and the status stays
   `active`.
3. **List the candidates.** A position `i` in `N` is a candidate when the rest
   of the page, `N[i..]`, equals the first `len(N) - i` pairs of `P` exactly,
   and `len(N) - i` is at most `len(P)` and at least
   `need = min(2, len(P), len(N))`. This is the shape a real change gives: new
   plays at the head, lost plays at the tail, nothing between. A candidate must
   explain the whole page, so a pair that does not fit rules a position out.
4. **Choose the smallest candidate.** The new plays are `N[0..i)`. When more
   than one position is a candidate, the page proves only the smallest count,
   and the others are possible. The service stores the proven plays, never an
   invented one, and writes the difference between the last and the first
   candidate to the response as `ambiguous` and adds it to
   `sources.maybe_missing`. The dashboard shows "up to N plays of repeated songs
   may be missing" while the sum is above 0. A count that is too low is marked,
   and a count that is too high would hide itself, so the rule leans low.
5. **No candidate.** The history was edited, for example a play deleted from the
   middle. For each `i`, let `m(i)` be the number of leading pairs of `P` that
   `N` repeats from `i`. The largest `m`, if it is at least `need`, gives the
   position, and the new plays are `N[0..i)`. Tied positions are treated like
   several candidates: the smallest `i` is chosen and the spread is `ambiguous`.
6. **No run.** The page shares nothing with `P`, or only one pair, which a
   coincidence can explain. The whole of `N` is new, `status` becomes `gap`, and
   `gap_at` records the time. The dashboard says that plays between the last
   upload and this one may be missing, and the next upload with a run sets the
   status back to `active`. A page stored twice in the worst case, when the true
   run was a single pair, is better than a silent hole.
7. **Store.** The new plays get `seq = play_seq + 1` for the oldest, up to
   `play_seq + i` for the newest, each as `<video id>#<seq>` at 12:00 UTC of its
   day. Then `last_page` becomes `N` and `play_seq` grows by the count.

An example, with letters for `(day, video id)` pairs:

| Upload | Page, newest first | Candidates `i` | New | Stored in total |
| ------ | ------------------ | -------------- | --- | --------------- |
| 1      | `c b a`            | first upload   | 3   | 3               |
| 2      | `x c b`            | 1              | 1   | 4               |
| 3      | `x c b`            | a replay       | 0   | 4               |
| 4      | `q r s`            | none, a `gap`  | 3   | 7               |
| 5      | `t q r`            | 1              | 1   | 8               |

Upload 2 is the case a day-and-count key gets wrong: the page lost its oldest
play, `a`, and gained `x`, and the service stores one play. Upload 3 is a replay
and stores none. Upload 4 is a gap.

Repeated plays are the hard case:

| Upload | Page, newest first | Candidates `i` | New | Stored in total | `ambiguous` | `maybe_missing` |
| ------ | ------------------ | -------------- | --- | --------------- | ----------- | --------------- |
| 1      | `A A B`            | first upload   | 3   | 3               | 0           | 0               |
| 2      | `A A A`            | 1              | 1   | 4               | 0           | 0               |
| 3      | `A A A`            | a replay       | 0   | 4               | 0           | 0               |
| 4      | `A A A A`          | 1 and 2        | 1   | 5               | 1           | 1               |

| Upload | Page, newest first | Candidates `i` | New | Stored in total | `ambiguous` |
| ------ | ------------------ | -------------- | --- | --------------- | ----------- |
| 1      | `A A`              | first upload   | 2   | 2               | 0           |
| 2      | `A A A`            | 1              | 1   | 3               | 0           |

Upload 2 has one candidate. Position 0 would need the third `A` to equal `B`,
and it does not, so the page is `A` plus the two newest of the old page. The
service stores the new `A`, and the count is exact. The second table shows a
previous page `A A` followed by `A A A`: one candidate, position 1, because
position 2 is shorter than `need`. Upload 3 equals the stored page, so it is a
replay: nothing is stored and nothing is marked. Upload 4 changes the page and
is the unresolvable one: a page that repeats one pair all the way down reads the
same with one or two new plays of that pair at its head. The service stores the
proven play and marks one play as possibly missing.

The replay step has a price. A page that repeats one pair all the way down looks
the same after a new play of that pair, and the service reads it as a replay, so
that play is missed without a mark. An upload that changes the page still marks
what it cannot settle.

### Phone scrobbler

An Android scrobbler such as Pano Scrobbler reads the phone's now-playing
sessions and posts each play to a server that speaks the ListenBrainz submission
API. The Worker answers it under `/1`:

```http
POST /1/submit-listens
Authorization: Token msu_<43 characters>
Content-Type: application/json

{
  "listen_type": "single",
  "payload": [
    {"listened_at": 1763123400,
     "track_metadata": {"artist_name": "Radiohead",
                        "track_name": "Weird Fishes/ Arpeggi",
                        "release_name": "In Rainbows"}}
  ]
}
```

```json
{ "status": "ok" }
```

- **Token.** The same `msu_` shape as an upload token, issued on the settings
  page, hashed in `tokens`, tied to a `listenbrainz` source the issue creates on
  first use. `GET /1/validate-token` answers
  `{code: 200, message, valid: true, user_name: <profile name>}` for a good
  token and `401` with `{code, error, valid: false}` otherwise. An upload token
  is not valid here and a scrobbler token is not valid on `/api/v1/upload`: each
  lookup checks the source's `kind`.
- **Types.** `listen_type` is `single`, `import` or `playing_now`. `single` and
  `playing_now` carry exactly one `payload` item, `import` up to 1,000. Each
  item holds `listened_at` (except `playing_now`, which omits it) and
  `track_metadata` with `artist_name`, `track_name` and optional `release_name`
  and `additional_info`; `recording_mbid` and `isrc` from `additional_info` feed
  song matching like Spotify's ids. A play stores at the exact `listened_at`
  second. `playing_now` returns `200` and stores nothing.
- **Limits.** The body is at most 512 KiB and must be `application/json`. A
  payload over 1,000 listens, a text field over 512 characters, or a
  `listened_at` before 2005-01-01 or more than a day ahead is refused with `400`
  and `{code, error}`. There is no rate limit: a scrobbler sends one submission
  per track, many an hour.
- **Pano's routes.** Pano Scrobbler joins the configured server to `1/` plus the
  route name and sends `Authorization: token <key>`. It calls `validate-token`
  once when the account is added and `submit-listens` for every play. Its other
  routes (listen history, now playing, loves, stats) get `404` with
  `{code: 404}` and fail only the feature that asked. A server entered as
  `https://earshot.rising.sh` or `https://earshot.rising.sh/1` both work: the
  routes are registered under `/1/` and `/1/1/`.

Checked by a throwaway simulation of the rule: 620,164 uploads from random
histories of 2 to 4 distinct pairs and pages of 2 to 8 plays, where the new page
overlapped the old one by at least `need` pairs and no play was deleted. The
rule never stored more plays than were played. It stored fewer in 14,731 of
them. In 10,177 the shortfall was at most the `ambiguous` figure it reported. In
the other 4,554 the new page was identical to the old one, so the rule read a
replay and reported nothing. Every upload that changed the page stayed inside
its reported spread.

A replayed request cannot insert twice. The batch holds the inserts, guarded by
`play_seq = <value the Worker read>`, and then an update of the source with the
same guard. A second request that read the same `play_seq` finds it changed,
inserts nothing, and the Worker answers `409`. Rate limiting makes the race
rare, and the guard makes it harmless.

The cost per upload is one read of `sources` (which the token check already
makes) and one write of it, with `last_page` of about 6 KB for 200 plays. The
alignment is two nested loops over at most 1,000 pairs, a few thousand
comparisons for a normal page. Milestone 5 measures its CPU time at 1,000 pairs.

### What a day means

Google builds the headings in the history page ("Today", "Yesterday") for some
time zone, and the page does not say which. A crate that always used UTC would
show a user whose day ends at another hour a play counted on two days across two
runs: first under "Today", then under "Yesterday". The crate therefore takes a
time zone from the setting `MUSIC_STATS_TZ` (an IANA name, default `UTC`), and
[`youtube_json.rs`](../crates/music-stats/src/providers/youtube_json.rs)
resolves "Today" and "Yesterday" in it. A wrong boundary also breaks the
alignment, because the same play would carry two days on two uploads. Milestone
5 measures the boundary: upload hourly for two days and check that no play lands
on two days and that no upload reports a gap. Until that passes, the design
treats a one-day error on YouTube Music plays as possible.

The crate sends only plays that sit under "Today", "Yesterday" or a `YYYY-MM-DD`
heading. The week and month headings cover several days, and the crate gives
those plays an invented date ([Providers](providers.md)). That is good enough
for a top-five list and wrong for a ledger, so they are left out of the upload.
A daily run sees every play under "Today" or "Yesterday" first, so only plays
older than the first upload are lost.

### File imports

The service imports no history files. An earlier version took Spotify's extended
streaming history and Google Takeout's watch history through the settings page.
It was removed on 2026-11-14 because it asked the user to request an export,
wait days, unzip it and upload it, for history that the pulled and pushed
sources cover from their first day. Migration `0005_imports.sql` still lists
`spotify_import` and `ytmusic_import` in the `kind` check of `sources`, and no
code writes them.

## 4. Song matching

The same song arrives as `Weird Fishes/ Arpeggi` from one Spotify play,
`Weird Fishes/ Arpeggi - Remastered` from another, and
`Radiohead - Weird Fishes (Official Video)` from a YouTube music video. The
service needs one `tracks` row for all three.

**Resolution order.** The first hit wins.

1. `track_aliases` for the source's own key: `spotify:<track id>`,
   `ytmusic:<video id>`.
2. A recording MBID, then an ISRC, against `tracks.mbid` and `tracks.isrc`. An
   id match counts only when the artist key or the title key also agrees. Labels
   reuse ISRCs wrongly, and a wrong id must not merge two songs.
3. The normalised key `artist key + U+001F + title key`.
4. Otherwise a new `tracks` row, whose title and artist are the display text of
   the first source that mentioned it. The new alias is stored.

The ids come from the sources that have them. Spotify gives `external_ids.isrc`
([recently played](https://developer.spotify.com/documentation/web-api/reference/get-recently-played)).
The YouTube history page gives a `videoId` in each play's `watchEndpoint`, and a
`musicVideoType`: `MUSIC_VIDEO_TYPE_ATV` for the audio track and other values
for music videos and user uploads. The crate does not read `videoId` today. The
upload change adds it.

**Normalisation.** Applied to the artist and to the title, to build the key and
never to the display text:

1. Unicode NFKC, then lowercase, then remove combining marks (`Beyoncé` becomes
   `beyonce`), and turn typographic quotes and dashes into ASCII.
2. Remove a trailing or bracketed clause that does not change which recording it
   is: `remaster`, `remastered` with or without a year, `mono`, `stereo`,
   `deluxe edition`, `explicit`, `official video`, `official audio`,
   `lyric video`, `visualizer`, and a `feat.`, `ft.` or `featuring` clause.
3. Remove a ` - Topic` suffix from a YouTube artist.
4. Remove everything that is not a Unicode letter or number, and collapse the
   rest. A result with no characters falls back to the trimmed lowercase text.

A clause that names a different recording stays: `live`, `remix`, `acoustic`,
`demo`, `instrumental`, `cover`, `version`. A live take and the studio take are
two songs for a listener.

**The artist is the first credited one,** as the source states it. A Spotify
credit is an array and the first element is used, as the crate already does for
YouTube Music. The service does not split a string on `&` or `,`, because
`Simon & Garfunkel` is one act.

**No fuzzy matching on text alone.** multi-scrobbler scores titles with
Levenshtein and Dice distances
([duplicates](https://docs.multi-scrobbler.app/configuration/duplicates/)), but
it compares a new play with plays that sit at nearly the same time, so time is a
second witness. Text with no second witness merges wrongly more often than it
fixes anything, and a wrong merge corrupts a count that a split only diffuses. A
user-driven "merge these two tracks" is a possible later feature. It rewrites
`track_aliases` and `plays.track_id` in one batch.

### Cross-source duplicates

A user who plays the same track on Spotify and in a YouTube music video can hold
it twice. Two plays from different sources are one play when they have the same
`track_id` and their times are close enough. The window follows
multi-scrobbler's observation that some sources stamp the end of a play and
others the start. Here, the window is
`max(track length, 4 minutes) + 30 seconds`, or 10 minutes when the length is
unknown. The match is one to one: each play pairs with the nearest unpaired play
of the other source. A track on repeat therefore pairs play by play and not all
at once. A YouTube Music play, which has a day only, pairs with a play of
another source on the same UTC day.

The play from the source with the richer evidence stays counted: `spotify`, then
`listenbrainz` (the phone scrobbler) and `lastfm` for rows an old database may
still hold, then `ytmusic`. A phone play has an exact second, so it pairs with a
YouTube Music play of the same track on the same UTC day and the day-stamped row
loses. The loser gets `dup = 1`, and the `plays_uncounted` trigger fixes the
totals. When the better source arrives later, as when a Spotify pull stores a
play that YouTube Music already had, the same rule marks the older row. The code
is one function, `markDuplicates`, tested as a table of cases. It reads the span
once and groups the plays by track in the Worker. Each track's span is then
widened by the pairing window and the YouTube Music day rule. While a widened
span reaches past the covered range, the function reads the missing range below
it and the missing range above it, widens the spans again, and repeats until
every span is covered. Then it pairs.

**Known limit.** A mark is never undone, so a chain of plays that spans more
than 600 s can count differently by the order its sources arrive. Take a track
with YouTube Music plays at noon+300 and noon+900 and a Spotify play at noon. If
the YouTube plays and a third precise source are stored in an order that marks
one before Spotify arrives, the mark stays when Spotify pairs with the other:
the track can count 1 play where one store of all of them counts 2. Lifting the
limit needs a trigger that recounts a play when `dup` goes from 1 to 0.
Migration 0005 adds that trigger, `plays_recounted`, which returns a play's
totals when `dup` goes from 1 to 0; the import removal fires it for the plays it
reopens. What is still missing is a pass that unmarks: `markDuplicates` only
ever sets `dup` to 1, so the mis-ordered chain above keeps its count of 1.

## Pulled sources

A Cron Trigger runs every minute and calls `scheduled()`. It selects the due
sources whose `next_pull_at` has passed, oldest first, through `sources_due`,
and pulls up to `maxSourcesPerPull` (10) of them, one after the other.
[Limits and costs](#6-limits-and-costs) records what a tick costs against the
Workers Paid
[limits](https://developers.cloudflare.com/workers/platform/limits/).

- **Spotify.** `GET /v1/me/player/recently-played?limit=50&after=<cursor>` with
  an access token refreshed from the stored refresh token
  ([recently played](https://developer.spotify.com/documentation/web-api/reference/get-recently-played)).
  It needs the `user-read-recently-played` scope. `after` takes a Unix
  millisecond, so the second-granularity `cursor` is multiplied by 1,000, and a
  play the cursor re-reads is discarded by the `plays` primary key. The endpoint
  returns at most 50 plays and no older history, so a source must be pulled
  before the user has played 50 more tracks. About 3 minutes a track means two
  and a half hours, and the back-off never exceeds 1 hour.
- **YouTube Music.** `GET https://music.youtube.com/history` with the stored
  cookie and a `SAPISIDHASH` authorization header, exactly as the crate's Action
  does. A pull comes due every hour on a fixed interval: the page holds about
  200 plays, roughly ten hours of continuous listening, so an hour leaves a
  tenfold margin and costs 24 fetches a day. The Worker's TypeScript parser
  reads the page the same way the crate does, resolving "Today" and "Yesterday"
  in the source's `tz`, and drops every play that has no day. The page then
  takes the same alignment, storage, gap and duplicate path as an upload, so a
  pull and an upload to the same source never store a play twice. A pull that
  finds the cookie signed out, or a page that no longer parses, sets
  `status = 'error'` with a plain message such as "YouTube signed you out. Paste
  a new cookie." and clears `next_pull_at`, so pulls stop until the user saves a
  new cookie. A network failure or a non-200 answer is transient and retries
  with the usual back-off.
- **Back-off.** A pull that finds plays sets `idle_pulls` to 0 and comes due
  again in 20 minutes. An empty pull adds 1 to `idle_pulls` and sets the delay
  to `15 minutes × 2^idle_pulls`, capped at 60 minutes so the 50-play window is
  never out of reach. A pull the source rate-limits (`429`) waits out the
  `Retry-After` value and keeps its `active` status.
- **Failure.** A pull that fails sets `status = 'error'` with a short `error`
  and retries with the same back-off. The dashboard shows the message. A revoked
  grant (`invalid_grant` from the refresh) sets `error` to a message that tells
  the user to reconnect and clears `next_pull_at`, because a revoked grant never
  recovers on its own.

stats.fm refreshes Spotify about every 100 minutes
([FAQ](https://support.spotistats.app/docs/import/spotify-import)), which is the
same trade of freshness for requests.

### Spotify and the user limit

One shared Spotify app, owned by the operator, serves every user; users do not
bring their own. A new Spotify app starts in development mode. Spotify's pages
today say:

- A development-mode app serves at most **5** users, each added by hand in the
  app's dashboard, and the owner must have Premium. Spotify made the change on
  11 February 2026 for new apps and on 9 March for existing ones
  ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide),
  [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).
- Extended quota lifts the limit, but since 15 May 2025 only an organisation can
  ask for it, and the criteria include a registered business, a launched service
  and 250,000 monthly active users. This project meets none of them.

So the service can connect at most 5 Spotify accounts, first come, first served,
and the operator adds each user's Spotify email in the app's dashboard. The app
stops working for everyone if the owner's Premium subscription lapses, so the
operator's own account holds it.

A `429` from Spotify waits out `Retry-After`; a revoked grant marks the source
`error` until the user reconnects.

## 5. Accounts and deletion

**Sign-in is GitHub or Google OAuth.** GitHub uses an OAuth App with no scopes.
A token with no scope reads public profile data, which is `id` and `login`
([scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)).
GitHub recommends GitHub Apps over OAuth Apps for integrations. This service
only asks who the visitor is and keeps no token, so the permissions model of a
GitHub App buys nothing. Google covers the players and group members who have no
GitHub account. It asks for `openid email profile`, the scopes that need no
Google review. There is no password to run.

- `/sign-in?next=PATH` offers both providers; the header's Sign in links there.
- `/auth/github` and `/auth/google` set a random `state` in a cookie and
  redirect. The callback checks it and exchanges the code. GitHub's token reads
  `GET /user` and is discarded; Google's token response carries an ID token,
  whose `aud` must be this client and `iss` Google. It comes straight from
  Google's token endpoint over TLS, so its signature needs no check.
- A user row holds `github_id` and `github_login`, `google_sub` and
  `google_email`, or both. `github_id` is `NOT NULL` from the first schema, and
  rebuilding `users` in D1 would cascade-delete friends and groups, so an
  account with no GitHub link holds a negative `github_id`. A new Google user's
  profile name comes from the given name, never the address; the address shows
  only on the owner's settings page.
- A callback that finds a signed-in visitor links that provider to their
  account, from **Settings → Account**. It answers 409 when the account at the
  provider already signs in to another profile, or the visitor already has one
  from that provider.
- The session is a random 32-byte value in a `__Host-session` cookie
  (`HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, 30 days). D1 stores its
  SHA-256 in `sessions`, so the server can end a session. A signed cookie could
  not be revoked.
- A form that changes state is a `POST` and the Worker checks that `Origin`
  equals the site origin. `SameSite=Lax` does the rest. The upload endpoint uses
  a bearer token and no cookie, so it has no CSRF exposure.
- Spotify is proven by the OAuth flow, YouTube Music plays arrive pulled with
  the stored cookie or pushed with an upload token and phone plays only with a
  scrobbler token, so no source can be claimed by name. The submit routes are
  token-authenticated API routes, outside the `Origin` check.
- **The YouTube Music cookie grants full access to the user's Google account.**
  The settings form accepts it only over `POST` behind the `Origin` check,
  validates it against the history page, and stores it AES-GCM encrypted in
  `sources.secret`. It is never logged, rendered back into a page, returned in
  JSON or an error message, or stored unencrypted, and a fetch failure message
  never echoes the request headers. Removing the source deletes it, and
  "Disconnect cookie" clears it alone while the plays and an upload token stay.

**Privacy.** A profile is public by default. The settings page has one switch,
`is_public`. A hidden profile answers `404` on all three addresses. The first
sign-in screen states that profiles are public. A hidden member's plays still
feed the playlist of each group they belong to; group members see the member
list by name, and the member can leave any group.

**Deleting data.** The settings page has two actions.

- **Remove a source.** One `db.batch()` deletes that source's `plays`, its
  `tokens` and the `sources` row, then recounts `track_totals`, `daily_totals`
  and `artist_totals` for the user. The Spotify refresh token or YouTube Music
  cookie goes with the row. The user can also revoke the app in their Spotify
  account, or disconnect only the YouTube Music cookie and keep the plays.
- **Delete the account.** The user types their name to confirm. One batch
  deletes `plays`, `track_totals`, `daily_totals`, `artist_totals`, `tokens`,
  `sources`, `sessions` and the `users` row, in that order, so no foreign key
  fails. The friends and groups tables declare `ON DELETE CASCADE`, so the
  `users` delete takes the friendships, requests and memberships with it, and
  the batch ends by deleting any group left with no members. Cached snapshots in
  KV are keyed by the user id, which is never reused, and expire within a day.
- D1 Time Travel keeps restore points for 30 days on Workers Paid
  ([limits](https://developers.cloudflare.com/d1/platform/limits/)). Deleted
  rows leave the restore points with them. The privacy text says so.
- **Export.** `GET /settings/export` answers the user's plays as NDJSON, one
  play per line, in pages of 1,000 rows by key. A full page carries a
  `Link: rel="next"` header whose `?after=` query resumes at the next key, so
  the client downloads page after page and the 50 MB D1 result limit and the CPU
  budget are never near. With JavaScript the settings page's download link
  follows the next links and saves the joined pages as
  `music-stats-NAME.ndjson`; the plain link keeps working for curl, which reads
  the Link header itself.

## Public surface

| Address            | Content                                                     |
| ------------------ | ----------------------------------------------------------- |
| `/u/NAME`          | HTML profile. `?period=week` (default), `month`, `all`.     |
| `/u/NAME.json`     | The same figures as JSON.                                   |
| `/u/NAME.svg`      | The card. `?period=`, `?n=1..10`, `?theme=light` or `dark`. |
| `/`                | The hub: difficulty choice and one tile per category.       |
| `/play`            | Redirects to `/` with its query; a POST starts a game.      |
| `/play/artists`    | Artist search. `?q=` the query, `?with=`&`n=` a blend pick. |
| `/play/artist/IDS` | Start page for `artist-ID` or `artist-IDA-IDB`.             |
| `/play/room/CODE`  | A guess-the-song room for up to 8 players.                  |
| `/play/match/SLUG` | Queue for a random opponent in one category.                |
| `/play/board`      | The points board. `?period=week` (default) or `all`.        |
| `/friends`         | Friends, requests, and your friend link. Sign-in required.  |
| `/friends/add/TKN` | Confirm page of a friend link. Sign-in required.            |
| `/groups`          | Your groups and the new-group form. Sign-in required.       |
| `/groups/ID`       | A group's members and blended playlist. Members only.       |

- **Periods.** `week` is the last 7 days, `month` the last 30 days, both
  rolling, and `all` is everything. A calendar week would be empty on Monday
  morning, and the Gist output already uses a rolling window.
- **Figures.** Plays, unique tracks, unique artists, the top tracks, the top
  artists and the plays per day. `week` and `month` read `plays` with the
  primary key prefix `(user_id, played_at >= …)` and group by track. `all` reads
  the totals tables instead: `track_totals_top` for the top tracks,
  `artist_totals_top` for the top artists, `daily_totals` for the plays per day,
  and `track_totals` and `artist_totals` row counts for the summary figures. The
  plan for the weekly query was checked in SQLite: it searches `plays` by the
  key and groups with one temporary b-tree.
- **JSON.**
  `{"schema": 1, "user": …, "period": …, "from": …, "to": …, "plays": …, "unique_tracks": …, "unique_artists": …, "top_tracks": […], "top_artists": […], "daily": […], "updated_at": …}`.
  It sends `Access-Control-Allow-Origin: *`, because it is public data. Each top
  track and top artist carries `image`: a Deezer album cover or artist picture
  URL, or `null` when none is known yet.
- **Images.** No source sends usable artwork for every play, so the cron looks
  each track and artist up on Deezer by name (`src/profile/images.ts`): a track
  takes the album cover of the first hit by the same artist, an artist the
  picture of the hit with the same name. Each tick looks up six of each, newest
  first, and a miss is tried again after 30 days. The profile and the group
  playlist show the image over the colour tile, which stays when there is none.
- **Snapshots.** The figures of one user and period are cached in KV under
  `snap:<user id>:<period>`, with a TTL of 15 minutes for `week` and `month` and
  6 hours for `all`. A request that finds no snapshot computes it from D1 and
  stores it. A failed KV write never fails the request: the page is rendered
  from the fresh figures. The profile, the JSON and the card read the same
  snapshot, so they agree.
- **Card.** The Worker builds the SVG from the snapshot by string templates. It
  loads no font and no image, since a README viewer would not fetch them: text
  uses the generic `sans-serif` family and the text is cut by display width,
  with East Asian wide characters counting 2, the same rule as
  [Output](output.md). The query values are validated to a fixed set, so the
  number of variants per user is bounded (3 periods × 10 sizes × 2 themes), and
  an unknown value is `400`. Every string from a source is XML-escaped.
- **Headers.** The SVG and the JSON carry
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`,
  `X-Content-Type-Options: nosniff` and `Cache-Control: public, max-age=900`.
  The third-party text in them is never trusted.
- **Link preview.** The profile carries `og:title` and `og:image` that points at
  the card.

## Guess the song

The hub at `/` starts a solo quiz: ten rounds, each a 15-second preview clip.
The player picks a category and a difficulty, the `Mode` in
`src/play/game/quiz.ts`:

- **Easy**, the default, offers four titles, each with its artist.
- **Normal** offers the four titles alone. Its round never carries the artists,
  so the page cannot leak the hint.
- **Hard** asks for the title typed.

Scoring is the same in every mode, and the boards rank them together. A random
match plays Normal. `GET /play` redirects to `/` with its query, so old links
keep their preset; `POST /play` still starts a game. Migration `0015` renames
the stored modes: `choices` became `normal` and `typed` became `hard`.

The clip keeps playing through the reveal, so a player hears the song while
reading its name. Continue stops it in solo; in a room and on the screen it
stops when the next round loads or the game ends.

- **Categories.** The `categories` table lists a slug, a display name, a display
  order, a hidden flag and a feed. Migration `0012` reseeds Pop, Rock, Metal,
  K-pop and Anime plus a new Rock en Español category as playlist-backed feeds,
  keeps Top 50 Japan, Top 50 Peru, Top 50 Global and "From my listening", which
  reads the signed-in player's `track_totals`.
- **Catalog.** A playlist-backed category keeps its track pool in D1 instead of
  fetching a feed per game. `category_sources` lists one or more sources per
  category, `catalog_tracks` holds each track by its track key with its title,
  artist, cover, link and release year plus the admin's answer-title and
  answer-year overrides and a ban timestamp, and `catalog_members` joins tracks
  to the sources they came from. The key is `dz:<id>` for a Deezer track and
  `it:<id>` for a curated track only iTunes previews; `round_outcomes` and
  `track_reports` use the same key. An iTunes track stores its `preview` URL,
  since iTunes preview URLs are not signed. A track whose title is romanized
  keeps the title in its own script as `original_title`: the reveal shows it
  beside the artist, and a typed answer may use either title. A song from a show
  or film also stores the show as `work` and its slot there as `theme` (`OP1`,
  `ED2`). The pool a game draws from is the union of the category's sources
  deduplicated by track key and by normalized answer title per artist, banned
  tracks removed. A source refills once a day and upserts its tracks, so an
  override or a ban survives a refill.
  - A `deezer_playlist` source refetches its playlist, at most two per cron run.
    The run then fills missing years from `/track/{id}`, at most 40 tracks,
    marking tracks without a release date so they are not looked up again.
    Deezer's date is the release the track sits on, often a remaster.
  - A `curated` source has the ref `<list>/<decade>` and reads that list from
    `src/play/catalog/curated.json`, which is bundled into the Worker, so a
    refill costs no request and every due one refills in the same run. A third
    segment is a theme prefix: `anime/1990/op` reads the anime 1990s list and
    keeps only the songs whose `theme` starts with `op`. Its year is the song's
    original release year and replaces a looked-up one.
  - Anime openings and Anime endings play the anime catalog's opening and ending
    themes as their own categories. Each of their sources names the anime decade
    list and the theme prefix (`anime/1990/op`, `anime/1990/ed`), so the songs
    stay in one list and the `theme` field decides which categories hold them.
    Both source every anime decade, so the whole theme plays in the all-decades
    game; the era floor still decides which decades get a chip.
  - Migration `0013` replaces the seeded playlists of Pop, Rock, Metal, K-pop,
    Anime and Rock en Español with one curated source per decade. SQLite cannot
    alter a CHECK, so it rebuilds `category_sources`; dropping the old table
    cascades away every membership, and the playlists the admin added come back
    due and refill on the next runs.
  - Migration `0014` rekeys `catalog_tracks` and `catalog_members` on
    `track_key`, drops the `deezer_id` columns of `round_outcomes` and
    `track_reports`, and marks every curated source due so the new lists load.
  - Migration `0016` adds Hip-hop, Latin and J-pop as curated categories. It
    extends Pop to the 1960s, Rock to the 1960s and 2010s, Metal to the 1970s
    and 2020s, K-pop to the 1990s, Anime to the 1980s and Rock en Español to the
    2010s. J-pop dates its songs from the JP store, like Anime.
- **Curated lists.** `scripts/curate.ts` writes `src/play/catalog/curated.json`
  from `scripts/curated-seeds.json`. A category's seed names its decades, seed
  artists, a per-artist cap per decade, a stream floor, and hand fixes: `drop`
  removes an `Artist|Title`, `years` sets one, and an artist's `only` names its
  songs (anime singers' top songs are not all themes). Popularity is the Spotify
  stream total kworb.net publishes for the top 3000 artists, with Deezer's
  artist top as the fallback. A track keeps its kworb count as `streams`, which
  the refresh stores on `catalog_tracks` as the prior for
  [adaptive difficulty](#adaptive-difficulty); a Deezer-top pick and most anime
  have none.
  - Artist seeds alone miss many hits people know: against Spotify's All Out
    decade playlists the artist-only Pop list shared a quarter to a half of its
    songs. A seed's `songs` therefore lists `Artist|Title` from editorial
    playlists (Spotify's All Out, Rock Classics, Anime Hits by decade,
    Millennium K-Pop), keyed by the decade the playlist covers or `any`. A
    listed song is exempt from the per-artist cap, and its decade key bounds the
    year a lookup may return. Playlists of new releases (Anime Now, K-Pop ON!)
    are left out because they change weekly.
  - The year is the most common release year of the title in the artist's iTunes
    catalog, compilations counted only when nothing else dates it. The title
    matches exactly first, then with every bracketed part removed, because kworb
    and iTunes bracket different parts of a name. The track is the Deezer search
    match with a preview, and the artist's own Deezer top list is the fallback,
    because search leaves some originals out (Oasis, Adele). Of the Deezer
    artists with the seed's name, the one with most fans is taken. An artist
    seed may pin its Deezer, iTunes or kworb id, or set `kworb: false` when
    kworb's accent-folded name match finds another act. A song Deezer cannot
    preview falls back to the artist's iTunes track, stored with its preview URL
    and Apple Music link.
  - A list holds one cut of each song. Two cuts share the folded title outside
    its brackets and the artist's name. A seed with `titleKey` (Anime) keys on
    the title alone, because one theme comes credited to its singer, a cover, a
    duet partner or a romanized name. Soundtracks keep the artist, since many
    scores have a "Main Title". The song keeps its first cut's place in
    popularity order, and a plain cut wins over one marked `Version`, `Ver.`,
    `Radio Edit` or `Rerecorded`. When that cut misses its decade or the
    artist's cap, the next cut is tried.
  - A title in Han, kana or hangul is anchored on the iTunes track first, and
    the US store's name for it (`lookup?id=&country=US`) is its Latin name.
    Deezer romanizes some titles (紅蓮華 is "Gurenge") and translates others, so
    a Deezer track counts only when it is the same artist and has the native
    title, the Latin name, or a length within 1.5 s of the iTunes track, since a
    same-artist search hit alone is often another song. The display title is
    Deezer's when it is Latin, else the Latin name, and the native title is kept
    as `original`. The run prints how each such track matched for review. Anime
    sets `itunesStore: "JP"`: the US store lacks most 1980s themes.
  - Run `node scripts/curate.ts [CATEGORY...]` from `apps/web`, review the
    printed lists, run `mise run fix` (the script writes JSON that
    `oxfmt --check` rejects), and commit the JSON; `--list "ARTIST"` prints one
    artist's ranked songs with their years.
- **Eras.** A track's decade comes from its year, the answer-year override
  first. A category with at least 20 playable tracks in a decade offers that
  decade as a chip under its hub tile; the tile itself starts a game on the
  whole pool, and a chip starts one drawing only from that decade, for solo,
  rooms and random matches alike.
- **Hub tiles.** A tile shows four distinct covers from its pool, or one when
  fewer exist. A playlist category reads its pool, which the era chips need
  anyway; a chart category shows covers only when `play:cat:SLUG` is already in
  KV, so rendering the hub never fetches from Deezer or Apple. The visible
  categories and every tile's covers and eras are kept together in KV under
  `play:hub` for ten minutes, so a visit reads one small entry instead of every
  pool; an admin category edit deletes it, and a run with a failed pool is not
  kept. The code is `src/play/hub/hub.ts`.
- **For you.** The first tile on `/` starts a solo game whose pool is scored per
  player from D1 alone, in `src/play/catalog/foryou.ts`. An affinity per
  (category, decade) comes from the player's `round_outcomes` — rounds played,
  correct rate and answer speed — and, for a signed-in player, from the artists
  of their "From my listening" top tracks, counted where those artists sit in
  `catalog_members`. About seven of the ten rounds are known candidates:
  unbanned catalog tracks from the player's top cells that the player has not
  answered in 30 days. Three are new: tracks that share a source playlist with
  tracks the player answered correctly, ranked by how many they sit beside and
  excluding every answered track. A player with fewer than ten rounds and no
  listening is cold: the pool is the most-played categories' catalogs across all
  eras, and the tile says it learns their taste. The mix is computed per request
  and held in KV for ten minutes under `play:foryou:{playerKey}:{mode}`, since
  the [adaptive draw](#adaptive-difficulty) depends on the mode. Its rounds
  record `round_outcomes` with the track's own source category, so every For you
  game refines the next mix; it is solo only, since a shared game would play one
  person's taste.
- **Artist categories.** The slug `artist-<id>` is one Deezer artist and
  `artist-<idA>-<idB>` is two blended; a blend sorts its ids, so the canonical
  slug is unique — `artist-85-27` redirects to `artist-27-85`, and one slug
  means one board and one cache entry. `getCategory` resolves them at runtime
  with `/artist/{id}` for the display name, so solo games, rooms and random
  matches take them unchanged. The feed is the artist's `/artist/{id}/top`
  tracks, two artists interleaved one for one. That list holds every release of
  a song, so the feed keeps one entry per answer title: the first release with
  no remix, live, instrumental or language-version clause, at the song's first
  rank (`songsOnce` in `src/play/catalog/pool.ts`). The player finds artists
  through the search box on `/`, which answers `/search/artist?q=` hits sorted
  by fan count: the first as a card, the next six as rows, the rest folded. A
  search that finds nothing, or fails, offers six genres instead; only then does
  the page read D1. A malformed slug is a 404; an unknown id or an artist with
  fewer than four distinct titles shows the category-unavailable page. No D1 row
  is written per artist.
- **Artist page.** `/play/artist/IDS` shows each artist's photo and fan count
  (`artistProfile`, kept in KV for a day), the first six songs of the catalog
  the game will play, and one start form. Its Who choice picks the endpoint:
  each of Solo, With friends and Random has its own submit button with a
  `formaction`, and CSS `:has()` shows the one that matches, so the form works
  without a script. Loading the songs fills the catalog cache, so Start reads
  KV. A failed feed hides the songs and keeps the form.
- **Sources.** Feeds come from the Deezer public API (`/chart/{genre}/tracks`,
  `/playlist/{id}/tracks`, `/artist/{id}/top`, `/artist/{id}`, `/search/artist`,
  `/track/{id}`, `/track/isrc:{isrc}` and `/search`) and from Apple's chart feed
  (`rss.marketingtools.apple.com/…/most-played/50/songs.json`) for the country
  charts. A curated iTunes track plays its stored preview. Every other clip
  plays from Deezer: a Deezer feed track resolves by id, an Apple chart track by
  an artist-and-title search accepted only when the normalized artist matches,
  and a "From my listening" track by ISRC first, then the same search. A track
  Deezer does not preview is skipped, and a category whose tracks all fail shows
  its unavailable page. Every call goes through one module with an 8-second
  timeout, and a failed feed fails only that category.
- **Caching.** A fetched track list stays in KV under `play:cat:{slug}` for six
  hours, so a catalog round costs at most one service call — its own preview
  lookup. Deezer preview URLs are signed and expire, so they are resolved when a
  round is served and never stored.
- **State and scoring.** A game lives in its own `SoloGame` Durable Object,
  addressed by `idFromName(id)`: the ordered candidates, the open round's served
  time and the results so far. Each write pushes an alarm one hour out, and the
  alarm deletes the game. A Durable Object write commits locally and a read sees
  it at once; a KV put took about half a second and KV did not promise that a
  read would see it. No D1 write happens per round; the outcome row is written
  after the response, through `waitUntil`. The server times a round from serving
  it to the answer arriving; the client sends only the answer, never a score or
  a time. A right answer scores 1,000 falling linearly to 100 over the 15
  seconds, and a wrong answer, a timeout or an answer to a finished or expired
  game scores 0. Typed answers are compared through `normalizeText`, which folds
  case, accents, punctuation, a "feat." credit and bracketed suffixes, plus a
  small edit distance for typos. The answer never reaches the browser before it
  is guessed.
- **The page.** `client/solo.ts` posts each answer and Continue with an
  `x-solo: 1` header, and the server answers with the next page in the same
  response instead of a 303, so a tap costs one round trip. Without the header,
  or without scripts, the same forms redirect. On a pick the answer locks and
  marks the choice at once, and the verdict then morphs the open question in
  place. While the reveal shows, `/prepare` resolves the next round and returns
  its clip URL and rendered question. The script preloads that clip, and
  Continue shows the prepared question at once while `/next` commits it. The
  server's reply replaces the page only when it differs. The server still judges
  every answer and starts the clock on the playing report.
- **Loudness.** Deezer and Apple previews are mastered up to about 11 dB apart,
  so one game's clips jump in level. The browser decodes each clip for its
  waveform anyway (`client/wave.ts`), and the same pass measures its gated
  loudness. `client/level.ts` owns the player's saved volume and turns each
  clip's loudness into a gain toward -10 dB, clamped to 0.3–3; the element's
  volume is the player's volume times that gain, capped at 1. The solo page, the
  room's phone and the TV all play through it; the TV has no slider and levels
  at full volume. iOS ignores a media element's volume, so there the clips play
  as mastered.
- **Attribution.** Each reveal names the title and artist, shows the cover and
  links to the track on Deezer or Apple Music with the service's name, which
  both services require. A track with a work adds the show and its slot, as
  `Bubblegum Crisis · OP2`.
- **Outcomes.** Every answered round — solo, room or match — writes one
  `round_outcomes` row per answering player through `recordOutcomes`: a player
  key, the track, the category, the mode and game kind, whether the answer was
  right and how long it took, plus the track's decade. The player key is the
  user id when signed in; a signed-out player gets a random id in the httpOnly
  `__Host-play-id` cookie when a game starts, and their anonymous rows move to
  the account on sign-in. Signed-in rows carry `user_id` and cascade with the
  account. Apple-chart tracks have no Deezer id, so rows key the track by the
  normalized artist and title instead.
- **Reports.** A reveal has a "Report this clip" control — wrong song, bad clip,
  wrong title or other — that posts a `track_reports` row. Signed-out players
  report too; reports are capped at ten per hour per player key.
- **Admin.** `/admin` serves catalog operations to the GitHub numeric ids listed
  in the `ADMIN_GITHUB_IDS` variable in `wrangler.jsonc`, comma separated;
  everyone else gets a 404 on every admin route, GET or POST. The pages create
  and reorder categories, hide or show them, add or remove Deezer playlist
  sources (a pasted URL or id is looked up live so its title and track count
  show before saving) and refresh a category on demand; list a category's tracks
  with play counts, correct rate and open reports, with search, a decade filter,
  ban/unban and answer-title and year edits; resolve the report queue; and hide
  a user from the boards and their public profile. Every action is a POST under
  the same Origin check as the rest of the site and writes a row to
  `admin_actions`.

### Rooms

`/play/room/CODE` is the same quiz played together: up to eight people answer
each clip at the same time and the fastest right answer scores the most. The
creator picks the category and the mode on `/play`; the game runs the same 10
rounds of 15 seconds with the same candidates, choices, matching and scoring as
the solo game.

- **The object.** One Durable Object per room, addressed by `idFromName(CODE)`,
  where `CODE` is six characters from an alphabet without `0`, `O`, `1`, `I` or
  `L`. The object holds the whole room: the category and mode, the shuffled
  candidates, the players and their scores, the open round and its clock. The
  creator's browsers keep a per-room token; the one from the room's link marks
  the creator, who alone can start the game or a rematch.
- **Code.** Three layers in `src/play/room/`. `game.ts` holds the rules as plain
  functions over the stored room, the connected players and the time. `host.ts`
  runs a room: it turns socket messages and deadlines into rule calls, saves,
  broadcasts and D1 writes, and reaches the clock, sockets, storage, alarm,
  Deezer and D1 through one `RoomPorts` interface. `room.ts` is the Durable
  Object, which supplies the real ports. The rules and the host are tested
  without the Workers runtime, the host with fake ports; `test/rooms.test.ts`
  keeps what only the runtime shows: the routes, hibernated sockets, eviction,
  the alarm and the rows D1 receives.
- **Connection.** `GET /play/room/CODE/ws` upgrades to a WebSocket accepted with
  the hibernation API, so an idle object can be evicted while its sockets stay
  open. The page is a static shell; `client/room/` renders the phase the object
  broadcasts. A reload or a dropped connection rejoins by sending the stored
  token, which keeps the nickname and the points. Nicknames are 1 to 20
  characters and unique in a room, case-insensitive.
- **Messages.** The client sends `join` (nickname or token), `start` and
  `answer`. The object answers `joined`, `error` (`name`, `taken`, `full`,
  `gone`) and `state`, a snapshot of the phase, the players, the round number
  and, while a round plays, the clip URL and the choices. The signed preview URL
  is resolved when a round is served, sent only to the joined sockets and never
  written to storage; an object reloaded mid-round resolves it again for
  rejoining players.
- **Timing.** The object is authoritative for the clock. It stamps the round
  start when it broadcasts the clip — 1.5 seconds ahead, so every client starts
  together — and scores an answer by the time it arrives, measured from that
  start. A round closes at 15 seconds or as soon as every connected player has
  answered. The reveal shows the title, the artist, the cover, the Deezer link
  and each player's points for six seconds, then the next round starts on its
  own. Round ends, reveal ends and Deezer quota retries all run on the object's
  single alarm. A quota answer holds the same candidate and retries after 2.5
  seconds; the players see a loading state, never a skip.
- **Players.** A player who joined through the WebSocket route while signed in
  carries the session's user id; the route passes it to the object, the client
  never sends one. A guest joins with a nickname and no user id.
- **Cleanup.** Rooms keep no points between games. The last client action sets
  an idle deadline; an hour later the alarm closes any open sockets with code
  1001 — the page shows the room has closed — and deletes the object's storage.
- **The screen.** `/play/room/CODE/screen` is the room on a shared display,
  rendered by `client/screen/`. Its socket sends `watch` instead of `join`: it
  holds no seat, scores nothing, and counts toward nothing a player counts
  toward — not `maxPlayers`, not the seats a match waits for, not the
  everyone-answered early close. While a screen watches, the snapshot sends the
  clip URL to the screen only; the players' snapshots carry `screen: true` and
  no URL, so a phone never plays the clip. The screen's lobby shows the room
  code, the join link and a QR code of it, drawn on the server by
  `src/play/room/qr.ts`. The finish also freezes the category board into the
  room state, so the game-over card and the screen's standings show the same
  `readCategoryBoard` board without another read.

### Matches

"Play someone random" on `/play` posts to `/play/match`, which sends the player
to `/play/match/SLUG`. The page opens a WebSocket to `/play/match/SLUG/ws`,
handled by one global Matchmaker Durable Object (`idFromName("global")`). A
signed-in player's name and user id come from the session the route reads; a
guest sends a nickname in its first message.

- **The queue.** The whole queue is the attachment of each waiting socket, so
  hibernation loses nothing and a closed tab leaves the queue on its own. When a
  second socket waits in the same category, the object fetches the category's
  candidates, creates a Room object with `kind: "match"`, both players seated
  with a join token each, and answers `matched` with the room code and the
  token. The page opens `/play/room/CODE?k=TOKEN`, which joins as the seated
  player. A second player who picks the same nickname is sent back to pick
  another. "From my listening" is never offered: a stranger must not play
  someone's listening history.
- **Code.** `src/play/match/host.ts` runs the queue through `MatchPorts`: the
  sockets, the clock, the category's tracks and opening the room. `match.ts` is
  the Durable Object that supplies them. `test/match-host.test.ts` covers the
  queue with fake ports, including a partner who leaves mid-pair;
  `test/match.test.ts` keeps the route, the session the Worker reads into a
  seat, eviction and the room it opens.
- **No creator.** A match room has no creator: it starts by itself once every
  seated player holds a live socket, and if one never connects the game starts
  with whoever showed up after 90 seconds. There is no rematch button, and
  either player can leave. The game is the same 10 rounds in choices mode.
- **Waiting.** The page shows the search and its elapsed time. After 60 seconds
  it offers to keep waiting or to play solo.

### Points

A finished game writes one row per signed-in player to `game_results`: the user,
the finish time, the category slug, the kind (`solo`, `room` or `match`), the
score, the rank in that game and the number of players connected when the game
started. The row id is the game's identity for that player — `s:GAME:USER` for
solo and `r:GAMEID:USER` for a room or match game — so a finish processed twice
inserts nothing the second time. Guests write nothing, and nothing is written
per round: it is the only D1 write a game adds.

```sql
CREATE TABLE game_results (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  finished_at INTEGER NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('solo', 'room', 'match')),
  score INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  players INTEGER NOT NULL
);
```

`/play/board` ranks the top 50 players by total points, this week (from Monday
00:00 UTC) and all time, with a win count for `match` and `room` games (rank 1).
Only users with `is_public` appear, each name links to `/u/NAME`, and the query
result sits in KV for five minutes under `play:board:PERIOD`.

Each category also has a board: the best score each public player set there in
the last 15 days, top 10, read through the `game_results_category` index added
in migration `0010`. It shows at `/play/board?category=SLUG`, linked from
`/play/board`, on `/play/artist/IDS` and on the game-over page, and sits in KV
for five minutes under `play:catboard:SLUG`.

### Adaptive difficulty

For you and rooms draw songs a player is likely, but not certain, to know.
Category, era and artist solo games and matches keep the plain shuffle. The code
is `src/play/game/rating.ts`.

- **Model.** Each player has a skill and each track a difficulty, in
  `player_ratings` and `track_ratings`. The chance of a right answer is
  `σ(skill − difficulty + modeOffset)`. The offset is +0.5 for easy, 0 for
  normal and −1.2 for hard, because a choice of titles with artists is easier
  than titles alone and typing is harder than both. A mean player meets a mean
  track at 0.61, the hit rate `round_outcomes` showed on 2026-11-24.
- **Prior.** One answer cannot rate a track, and on 2026-11-24 575 of 974
  answered tracks had one, so a track starts from its popularity. Its difficulty
  falls half a logit per standard deviation of log `streams` within the category
  it is drawn from, clamped at 2.5 deviations. A track with no count starts at
  the mean.
- **Update.** `recordOutcomes` moves both ratings by the miss, the result minus
  the predicted chance. The player's step is 0.4. The track's step starts at 0.6
  and halves after eight answers, so a well-answered track settles. A new player
  starts at skill 0.
- **Backfill.** The minutely cron walks `round_outcomes` in id order, 400 rows a
  run, and records its place in `rating_state`. Until it marks itself done,
  `recordOutcomes` leaves the ratings alone and the walk counts the new rows
  too, so no answer is counted twice.
- **Draw.** A track's weight is a Gaussian of its predicted chance around 0.7,
  width 0.2. That target sits above 0.61 so a game feels winnable, and below 1
  so it still tests. The draw is a weighted shuffle (Efraimidis–Spirakis): every
  track can still come up, and a weight decides how early it lands. For you
  weights its known, new and fallback pools for the player. A room weights its
  candidates when the game begins, for the median seated player, and falls back
  to the plain shuffle when D1 fails.
- **Boards.** A room's score still goes to its category board, so a room aimed
  at a weak table can post a score a solo game would not. A room is a social
  game; the category board keeps both kinds.

### Game log

The game log answers how people play without a request, cookie or script of its
own. Migration `0021` adds it, and the server writes it at moments that already
happen:

- **`games`.** One row per game, guests included, written when the game begins:
  kind, room code, category, mode, the seated players, and `origin`. The origin
  is `start` for the lobby's Start, `rematch` for Start after a game, `pick` for
  the host's Up next pick, `match` for a random match, and `solo`.
- **`round_outcomes`.** Each answer also carries `game_id`, the round number,
  and the title and artist the round played. An artist feed's track has no
  catalog row, so the title cannot be read from anywhere else.

These questions read straight from the two tables:

| Question                      | Read                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| Gap between a room's games    | `games` by `room`, ordered by `started_at`                           |
| Games abandoned               | `games` whose `game_id` has fewer than 10 rounds in `round_outcomes` |
| Players who quit mid-game     | distinct `player_key` per round of one `game_id`                     |
| Does Up next replace detours  | share of `origin = 'pick'` and the gap before it                     |
| Hard or broken songs          | correct rate per `track_key`, named by `title`                       |
| A song played twice in a game | `game_id`, `title` with more than one `round`                        |

### Friends and groups

Friendship is mutual and starts in two ways. A user's friend link lives on
`/friends` (`users.friend_link`, a random 24-byte value); a signed-in visitor
who opens `/friends/add/TOKEN` sees the owner's name and confirms with one POST,
which writes both directions of `friendships` at once. Resetting the link
replaces the value and stops the old one. The other way is a request by exact
name into `friend_requests`; the addressee accepts or declines it on `/friends`,
the sender can cancel it, and a user may have at most 20 requests outstanding. A
request to a name that has no public profile gets the same "request sent" answer
as any other, so the form cannot probe for an account.

A group (`friend_groups`, members in `group_members`) is made on `/groups` with
a name. Any member can add more of their own friends, any member can leave, and
a group with no members is deleted. Only the creator can rename. Non-members get
404 on the group page and its POST routes, so a group id reveals nothing.

`/groups/ID` blends the members' top tracks into one playlist of 25. Each
member's candidates are their tracks with the most plays in the last 90 days,
filled from their all-time top tracks when that list is short. Tracks that two
or more people share come first, ordered by how many people share them. The rest
are dealt round-robin, one per person in turn, so a heavy listener cannot fill
the list. A track appears once, and an artist never sits in the previous three
slots when another candidate allows it. A hidden member's plays feed the
playlist like any other's: `is_public` controls the profile page, the board and
nothing else. The blend is cached in KV for 10 minutes under
`group:<id>:<member ids>`, so a membership change builds a fresh playlist.

"Play on YouTube" opens
`https://www.youtube.com/watch_videos?video_ids=ID1,ID2,...`, built from the
`ytmusic` aliases of the blended tracks, at most 50 ids. Measured on 2026-11-14,
the link answers 303 with an anonymous playlist and needs no sign-in. Tracks
with no alias are listed on the page and left out of the link.

## 6. Limits and costs

Numbers are from the Cloudflare pages of November 2026. Every row cites its
page:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/) and
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

| Resource                   | Free                | Paid ($5 a month)                           |
| -------------------------- | ------------------- | ------------------------------------------- |
| Worker requests            | 100,000 a day       | 10 million a month, then $0.30 per million  |
| CPU per HTTP request       | 10 ms               | 30 s default, up to 5 min                   |
| CPU per Cron Trigger       | 10 ms               | 30 s under 1 hour interval                  |
| Subrequests per invocation | 50                  | 10,000                                      |
| Cron Triggers per account  | 5                   | 250                                         |
| D1 queries per invocation  | 50                  | 1,000                                       |
| D1 rows read               | 5 million a day     | 25 billion a month, then $0.001 per million |
| D1 rows written            | 100,000 a day       | 50 million a month, then $1.00 per million  |
| D1 storage                 | 5 GB, 500 MB per DB | 5 GB, then $0.75 per GB-month               |
| KV reads                   | 100,000 a day       | 10 million a month, then $0.50 per million  |
| KV writes                  | 1,000 a day         | 1 million a month, then $5.00 per million   |
| Static asset requests      | free, unlimited     | free, unlimited                             |

The service runs on Workers Paid. The Free column stays for comparison, because
a fork on a free account meets it: a request over a Free daily limit fails until
00:00 UTC, and a pull tick is over the 10 ms of CPU that Free allows.

**What a unit of work costs.**

- A new play on a known track writes 7 rows, measured locally: the play row and
  its `plays_source` index entry, the `daily_totals` upsert, and the
  `track_totals` and `artist_totals` upserts, which D1 bills as two rows each
  because they change an indexed column
  ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)). A play
  whose track is new costs more: a 100-play batch of new tracks wrote about
  1,200 rows locally, 12 a play, because a new track adds its `artists`,
  `tracks` and `track_aliases` rows and their index entries, shared by all
  users. A pull with no new plays writes two rows: the `sources` row and its
  `sources_due` index entry. A play row is an estimated 40 bytes, so 500 MB
  holds on the order of ten million plays.
- A profile, JSON or card request with a warm snapshot reads one `users` row and
  one KV key. A cold one reads the rows of the period: about 350 plays for a
  week of a heavy listener, and about 1,500 for a month. `all` reads the totals
  tables, so a cold `all` snapshot of a 50,000-play history measures about 3 ms
  locally.
- A pull costs one or two subrequests to the source and two or three D1 queries.
- The Worker bundle is 166 KiB, 42 KiB gzip, and evaluating it measures about
  9.7 ms in Node, locally.

**Where Workers Paid runs out,** in the order a growing service meets the
limits. The local figures come from `apps/web/test/bench.test.ts`, which runs a
recorded 150-play Spotify recently-played page
(`apps/web/test/fixtures/spotify-recently-played.json`) through the pull in the
Vitest workerd pool; `PULL_BENCH=1 npx vitest run bench` runs it, and the
default suite skips it. The deployed figures are `wrangler tail` output from
milestone 1 and from the `apps/web/bench/` worker, which splits a pull into one
route per stage.

1. **D1 writes.** 50 million rows a month are included, then $1.00 per million.
   A new play writes about 7 rows on a known track and 12 on a new one, so the
   included rows hold about 4 to 7 million new plays a month. A heavy month
   stores 100,000 new plays a day, about 1,000 users at 100 plays each: about 21
   million write rows plus about 1 million for the pulls that find nothing (2
   rows each) is 22 million rows, so the month costs $5. The Worker still
   handles a D1 daily-limit error, which only Free returns: it records the cap
   in a KV key that expires at the next 00:00 UTC, and ticks check it before
   touching D1.
2. **Cron throughput.** A tick pulls up to `maxSourcesPerPull` (10) sources one
   after the other, so 1,440 ticks make 14,400 pulls a day. A source that finds
   plays is due again in 20 minutes, 72 pulls a day; an idle one backs off to 60
   minutes, 24 a day. That holds about 200 sources that always have new plays,
   or about 600 idle ones; a real mix sits between. Past it, due sources wait in
   `sources_due` order and nothing fails. A 50-play pull measures about 1.7 s of
   wall time on the bench, so ten pulls take about 17 s. Raising the constant
   must keep a tick under the 60 s between ticks, or the next tick selects the
   same sources before their `next_pull_at` moves.
3. **Requests.** 10 million a month are included, then $0.30 per million: about
   four requests a second on average. The cron takes 43,200 of them. Every view
   of a profile or card is a Worker request.
4. **KV writes.** 1 million a month are included, about 33,000 snapshot
   refreshes a day. A cold snapshot is still served, so the limit costs D1
   reads, not availability.
5. **CPU.** Not a limit at these sizes: 30 s per request and per tick, against
   tens of milliseconds measured. A first `wrangler tail` measured 10 to 23 ms
   CPU for six ticks that each pulled a 200-play page of mostly new tracks, with
   1.1 to 3.0 s of wall time. The work that grew with new tracks was the
   per-listen normalisation and the matching batch. Normalisation now runs once
   per unique artist or title on the page (a 200-listen page holds about 40
   artists and 130 titles, not 400 strings), the two clause patterns are skipped
   when the text holds none of their keywords, and the batch's JSON payloads are
   deduplicated and carry only the fields each statement reads. A second
   `wrangler tail` on 2026-11-12 measured a pull tick at 16 to 24 ms `cpuTime`
   for a 200-listen page (16, 17, 20, 23, 24 ms over five ticks), at 12 to 19 ms
   with the page cut to 50 listens (12, 13, 18, 19 ms over four ticks), and an
   idle tick with no source due at 1 to 2 ms. The cost barely moves with page
   size, so most of it is fixed per invocation, not per listen: the local bench
   measures about 1.2 ms of JavaScript for the same 200-listen page. The bench's
   own tail on 2026-11-12 measured the stages, in `cpuTime`: the empty handler 0
   ms, `JSON.parse` of the page 0 to 7 ms, the valibot parse 3 to 6 ms,
   `resolvePageTracks` 6 to 12 ms, the store step with its D1 batch 6 to 17 ms,
   a pull with a fixture fetcher 5 to 17 ms, and a pull with a real fetch 4 to
   28 ms, with a warm isolate repeating the real pull at 4 to 11 ms. Deployed
   cost runs 5 to 10 times the local figures. The fetch and the JSON parse are
   not the cost; track resolution, the D1 batch and its result decoding are, and
   a cold isolate adds more. A warm pull lands at 4 to 13 ms. The upload path
   shares the matching code: `wrangler tail` measured 9 ms CPU for an upload of
   200 plays on new tracks and 1 to 3 ms for 3-play uploads, and the same local
   measure is about 0.95 ms. On 2026-11-13 the bench measured the Paid sizes,
   each call storing new plays after a reset: `/store` at 2 to 8 ms for 200
   listens and 5 to 8 ms for 1,000, `/pull` with the fixture fetcher at 5 to 11
   ms for 200 and 10 to 24 ms for 1,000, at 1.5 to 1.7 s of wall time. The
   duplicate mark runs after every store on the span the page touched. The bench
   measured it on 2026-11-13 over the 200 newest plays of the worse-ranked
   source: each run marked 200 plays and wrote 1,200 rows. The `lastfm` case,
   which pairs by the ten-minute window, read about 620 rows for the span
   statement at 7, 12 and 7 ms `cpuTime` and 816 to 955 ms of wall time. The
   `ytmusic` case, which pairs by day, read about 400 rows at 10, 12 and 10 ms
   and about 1 s of wall time.

### Why there is no Last.fm source

The service pulled Last.fm behind a launch gate until 2026-11-14, when the
source was removed. The [Last.fm API terms](https://www.last.fm/api/tos), read
on 2026-11-12, put written approval with no deadline in front of every public
page (clause 2.7), and they require a credit button (4.2.2), cap the stored data
at 100 MB (4.3.4), allow non-commercial use only (3.1) and require deletion when
the licence ends (9.3). A source that cannot appear on the public page until a
third party answers gave users nothing, so it went. The Gist path of the Rust
crate still reads Last.fm, because that output is private to its user.

## 7. Build order

Each milestone ships on its own and ends with a check a person can run.

1. **Spotify, profile, JSON.** `apps/web/` with `wrangler.jsonc`, the migration,
   the custom domain `music.rising.sh` and a deploy workflow. Users are rows
   added with `wrangler d1 execute`, with no sign-in. The cron pulls Spotify.
   `/u/NAME` and `/u/NAME.json` work for the three periods. The milestone writes
   `docs/web-deploy.md` with every account step, secret name and command, and
   measures CPU per pull and rows written per play on real D1. _Done when_ a
   pulled page renders and a second pull inserts nothing.
2. **Last.fm behind the gate.** Built, then removed on 2026-11-14
   ([why](#why-there-is-no-lastfm-source)).
3. **Card and cache.** `/u/NAME.svg`, the KV snapshots and the headers. _Done
   when_ a README embeds the card and the CPU of a warm request is under 10 ms.
4. **Sign-in and self-service.** GitHub OAuth, sessions, the settings page where
   a user connects Spotify, the name and visibility settings, export, and
   deletion. _Done when_ a new person signs in, connects Spotify, and deletes
   the account, and no row of theirs remains.
5. **YouTube Music push.** The upload endpoint, tokens, the alignment of
   [section 3](#aligning-a-page-with-the-last-one), the crate's upload output,
   and the template workflow ([below](#8-the-gist-action)). Measures the day
   boundary and the CPU of the alignment at 1,000 pairs. The dashboard shows a
   `gap` and warns that a YouTube play that is also played on Spotify counts
   twice until milestone 6. _Done when_ an integration test and a live run both
   pass. The test posts a page of three plays (`c b a`), then a page of the two
   newest of them and one new play (`x c b`): four plays are stored and the
   total reads 4. It then posts `x c b` again (still 4), and a page that shares
   nothing (`q r s`: seven plays and the source status `gap`). A second case
   covers repeated plays: `A A B`, then `A A A` stores four plays in total with
   `ambiguous` 0. `A A A` again is a replay: it stores none, keeps the total at
   four, reports `inserted` 0 and `ambiguous` 0, and leaves `maybe_missing`
   unchanged. Then `A A A A` stores one play (five in total) and reports
   `ambiguous` 1, and `maybe_missing` becomes 1. A third source starts with
   `A A`, then posts `A A A`: three plays in total, `ambiguous` 0. The live run
   is two runs of the Action one hour apart with a play between them, and each
   play is stored once.
6. **Cross-source duplicates.** `markDuplicates`. _Done when_ a user with
   Spotify and YouTube Music on one listening app shows each play once.
7. **Spotify replaces ListenBrainz.** The OAuth connect, the token vault and the
   pull of this milestone swap the pulled source to Spotify, and a migration
   deletes the old source's rows. _Done when_ a user connects Spotify and a play
   of a track that YouTube Music also holds counts once.
8. **Imports.** Built, then removed on 2026-11-14
   ([File imports](#file-imports)).
9. **Phone scrobbler.** The ListenBrainz-compatible `submit-listens` and
   `validate-token` routes, scrobbler tokens on the settings page, and the
   `listenbrainz` source kind ([Phone scrobbler](#phone-scrobbler)). _Done when_
   a play scrobbled from a phone lands on the profile and a YouTube Music play
   of the same track counts once.

## 8. The Gist Action

The Gist output and its workflow stay. They serve a person who wants a five-line
list in their GitHub profile and no account anywhere. The program gains a second
output, and the template repository's workflow gains an upload.

### The Rust crate

The change is small and sits behind new settings:

- `UPLOAD_URL` (default `https://earshot.rising.sh`) and `UPLOAD_TOKEN`. When
  `UPLOAD_TOKEN` is set, the program posts the YouTube plays to `/api/v1/upload`
  through a new `src/output/upload.rs`. `GIST_ID` and `GH_TOKEN` become
  optional, and at least one output is required. `UPLOAD_TOKEN` needs
  `YOUTUBE_COOKIE`, the only source it uploads. The
  [Configuration](configuration.md) page changes with the code.
- `MUSIC_STATS_TZ` sets the time zone for "Today" and "Yesterday".
- The YouTube provider returns all the plays of the page and marks which have a
  day. `DAYS` applies to the Gist only. The upload ignores it and sends every
  play with a day and a video id, up to the whole page.
- `youtube_json.rs` reads `videoId` from each play's `watchEndpoint`.
- Last.fm stays a Gist-only input in the program. The service has no Last.fm
  source ([why](#why-there-is-no-lastfm-source)).

The cookie never leaves the runner. The upload body has no field for it and the
Worker has no code that could store one. The only secret that reaches the
service is the upload token, which can write plays and read nothing.

### The template workflow

The template's `gist.yml` keeps its daily run. A new `upload.yml` runs every
three hours (`0 */3 * * *`). The page holds about 200 plays, which is ten hours
of continuous listening, so a three-hour gap leaves a threefold margin. It
downloads the binary that [`release.yml`](../.github/workflows/release.yml)
attaches to a release, with `gh release download`, instead of compiling. Today's
workflow compiles on every run, which takes minutes. It passes `YOUTUBE_COOKIE`,
`UPLOAD_TOKEN`, `MUSIC_STATS_TZ` and `UPLOAD_URL`. When `UPLOAD_TOKEN` is unset
the workflow skips the upload job, so the template repository itself and
Gist-only users see no failing run. It keeps the `keepalive` job, because GitHub
disables a scheduled workflow after 60 days without activity
([GitHub Actions](github-actions.md#schedule)). Google may end a cookie that
moves to a runner's network, as
[Providers](providers.md#keep-the-cookie-working) explains. When the upload
fails, GitHub emails the user, and the dashboard shows the age of the last
upload.

## How comparable projects answer

| Question         | Project                                                                           | What it does                                                                                                                              | What this design takes                                         |
| ---------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Pulled sources   | [multi-scrobbler](https://github.com/FoxxMD/multi-scrobbler)                      | Polls Spotify and YouTube Music, keeps a queue, retries after failures, and sends to Last.fm, ListenBrainz and others.                    | The pull loop.                                                 |
| Duplicates       | multi-scrobbler                                                                   | Scores title, artist and album text with Levenshtein and Dice, and compares times in four states (exact, close, during, fuzzy).           | Time as the second witness, and a window for end-time sources. |
| Push and listens | [ListenBrainz](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html) | Per-user token in `Authorization`, 1,000 listens a request, `listen_type: import`, MBIDs and ISRC in `additional_info`.                   | The token header and the batch limit.                          |
| Weekly output    | [music-box](https://github.com/jacc/music-box)                                    | A fork-and-secrets Action reads Last.fm and writes the week to a Gist.                                                                    | The Gist stays, as the no-account path.                        |
| Workers and D1   | [listentomore](https://github.com/rianvdm/listentomore)                           | Hono on Workers, D1 for data and KV for cache.                                                                                            | The platform pairing.                                          |
| Spotify upkeep   | [stats.fm](https://support.spotistats.app/docs/import/spotify-import)             | Refreshes Spotify history about every 100 minutes and needs an import of the full history for play counts, since the API gives no counts. | Polling with back-off.                                         |

## Open questions

None. The operator registers the one shared Spotify app, per
[Spotify and the user limit](#spotify-and-the-user-limit); the dashboard steps
are in [Web deployment](web-deploy.md#create-the-spotify-app).
