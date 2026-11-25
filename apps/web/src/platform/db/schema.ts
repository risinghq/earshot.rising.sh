// The D1 schema: row types and new migrations come from it. Triggers live
// only in the SQL migrations. docs/web-app.md, section 2, has the workflow.
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// A BLOB as bytes. Drizzle's own blob() defaults to JSON, and D1 hands a
// BLOB back as an ArrayBuffer.
const bytes = customType<{ data: Uint8Array; driverData: ArrayBuffer }>({
  dataType: () => "blob",
  fromDriver: (value) => new Uint8Array(value),
});

const gameKinds = ["solo", "room", "match"] as const;
const modes = ["easy", "normal", "hard"] as const;

export const users = sqliteTable(
  "users",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    githubId: integer("github_id").notNull(),
    name: text().notNull(),
    isPublic: integer("is_public").default(1).notNull(),
    createdAt: integer("created_at").notNull(),
    githubLogin: text("github_login"),
    friendLink: text("friend_link"),
    adminHidden: integer("admin_hidden").default(0).notNull(),
    googleSub: text("google_sub"),
    googleEmail: text("google_email"),
    tier: text().default("free").notNull(),
  },
  (table) => [
    uniqueIndex("users_google_sub").on(table.googleSub),
    uniqueIndex("users_friend_link").on(table.friendLink),
    unique("users_github_id_unique").on(table.githubId),
    unique("users_name_unique").on(table.name),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    hash: bytes().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("sessions_expires_at").on(table.expiresAt),
    index("sessions_user").on(table.userId),
  ],
);

export const tokens = sqliteTable(
  "tokens",
  {
    id: integer().primaryKey(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id),
    hash: bytes().notNull(),
    hint: text().notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("tokens_source").on(table.sourceId),
    unique("tokens_hash_unique").on(table.hash),
  ],
);

export const artists = sqliteTable(
  "artists",
  {
    id: integer().primaryKey(),
    key: text().notNull(),
    name: text().notNull(),
    mbid: text(),
    image: text(),
    imageAt: integer("image_at"),
  },
  (table) => [
    index("artists_image_miss")
      .on(table.imageAt)
      .where(sql`image IS NULL`),
    index("artists_image_new")
      .on(table.id)
      .where(sql`image_at IS NULL`),
    unique("artists_key_unique").on(table.key),
  ],
);

export const tracks = sqliteTable(
  "tracks",
  {
    id: integer().primaryKey(),
    key: text().notNull(),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id),
    title: text().notNull(),
    mbid: text(),
    isrc: text(),
    image: text(),
    imageAt: integer("image_at"),
  },
  (table) => [
    index("tracks_image_miss")
      .on(table.imageAt)
      .where(sql`image IS NULL`),
    index("tracks_image_new")
      .on(table.id)
      .where(sql`image_at IS NULL`),
    index("tracks_isrc")
      .on(table.isrc)
      .where(sql`isrc IS NOT NULL`),
    index("tracks_mbid")
      .on(table.mbid)
      .where(sql`mbid IS NOT NULL`),
    unique("tracks_key_unique").on(table.key),
  ],
);

export const trackAliases = sqliteTable(
  "track_aliases",
  {
    kind: text().notNull(),
    sourceKey: text("source_key").notNull(),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id),
  },
  (table) => [
    primaryKey({
      columns: [table.kind, table.sourceKey],
      name: "track_aliases_pk",
    }),
  ],
);

export const plays = sqliteTable(
  "plays",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    playedAt: integer("played_at").notNull(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id),
    ref: text().default("").notNull(),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id),
    dup: integer().default(0).notNull(),
  },
  (table) => [
    index("plays_source").on(table.sourceId),
    primaryKey({
      columns: [table.userId, table.playedAt, table.sourceId, table.ref],
      name: "plays_pk",
    }),
  ],
);

export const trackTotals = sqliteTable(
  "track_totals",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id),
    plays: integer().notNull(),
    lastPlayedAt: integer("last_played_at").notNull(),
  },
  (table) => [
    index("track_totals_top").on(table.userId, sql`plays DESC`),
    primaryKey({
      columns: [table.userId, table.trackId],
      name: "track_totals_pk",
    }),
  ],
);

export const dailyTotals = sqliteTable(
  "daily_totals",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    day: integer().notNull(),
    plays: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day], name: "daily_totals_pk" }),
  ],
);

export const artistTotals = sqliteTable(
  "artist_totals",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id),
    plays: integer().notNull(),
  },
  (table) => [
    index("artist_totals_top").on(table.userId, sql`plays DESC`),
    primaryKey({
      columns: [table.userId, table.artistId],
      name: "artist_totals_pk",
    }),
  ],
);

export const sources = sqliteTable(
  "sources",
  {
    id: integer().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    kind: text({
      enum: [
        "lastfm",
        "listenbrainz",
        "spotify",
        "ytmusic",
        "spotify_import",
        "ytmusic_import",
      ],
    }).notNull(),
    account: text(),
    secret: bytes(),
    cursor: integer(),
    backfillBefore: integer("backfill_before"),
    nextPullAt: integer("next_pull_at"),
    idlePulls: integer("idle_pulls").default(0).notNull(),
    status: text({ enum: ["active", "gap", "error"] })
      .default("active")
      .notNull(),
    error: text(),
    lastOkAt: integer("last_ok_at"),
    lastPage: text("last_page"),
    playSeq: integer("play_seq").default(0).notNull(),
    gapAt: integer("gap_at"),
    maybeMissing: integer("maybe_missing").default(0).notNull(),
    playCount: integer("play_count").default(0).notNull(),
    gapBefore: integer("gap_before"),
    gapFloor: integer("gap_floor"),
    tz: text(),
  },
  (table) => [
    unique("sources_user_id_kind_unique").on(table.userId, table.kind),
    index("sources_due")
      .on(table.nextPullAt)
      .where(sql`next_pull_at IS NOT NULL`),
    check(
      "sources_check_1",
      sql`kind IN ('lastfm', 'listenbrainz', 'spotify', 'ytmusic', 'spotify_import', 'ytmusic_import')`,
    ),
    check("sources_check_2", sql`status IN ('active', 'gap', 'error')`),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    slug: text().primaryKey(),
    name: text().notNull(),
    feed: text({
      enum: ["deezer_chart", "deezer_playlist", "apple_chart", "mine"],
    }).notNull(),
    ref: text(),
    position: integer().default(0).notNull(),
    hidden: integer().default(0).notNull(),
  },
  () => [
    check(
      "categories_check_3",
      sql`feed IN ('deezer_chart', 'deezer_playlist', 'apple_chart', 'mine')`,
    ),
  ],
);

export const gameResults = sqliteTable(
  "game_results",
  {
    id: text().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    finishedAt: integer("finished_at").notNull(),
    category: text().notNull(),
    kind: text({ enum: gameKinds }).notNull(),
    score: integer().notNull(),
    rank: integer().notNull(),
    players: integer().notNull(),
    correct: integer(),
    rounds: integer(),
  },
  (table) => [
    index("game_results_category").on(table.category, table.finishedAt),
    index("game_results_time").on(table.finishedAt),
    index("game_results_user").on(table.userId, table.finishedAt),
    check("game_results_check_4", sql`kind IN ('solo', 'room', 'match')`),
  ],
);

export const friendRequests = sqliteTable(
  "friend_requests",
  {
    id: integer().primaryKey(),
    fromUser: integer("from_user")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toUser: integer("to_user")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique("friend_requests_from_user_to_user_unique").on(
      table.fromUser,
      table.toUser,
    ),
    index("friend_requests_from").on(table.fromUser),
    index("friend_requests_to").on(table.toUser),
  ],
);

export const friendships = sqliteTable(
  "friendships",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    friendId: integer("friend_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.friendId],
      name: "friendships_pk",
    }),
    check("friendships_check_5", sql`user_id <> friend_id`),
  ],
);

export const friendGroups = sqliteTable("friend_groups", {
  id: integer().primaryKey(),
  name: text().notNull(),
  creatorId: integer("creator_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
});

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("group_members_user").on(table.userId),
    primaryKey({
      columns: [table.groupId, table.userId],
      name: "group_members_pk",
    }),
  ],
);

export const trackReports = sqliteTable(
  "track_reports",
  {
    id: integer().primaryKey(),
    trackKey: text("track_key").notNull(),
    title: text().notNull(),
    artist: text().notNull(),
    category: text(),
    reason: text({
      enum: ["wrong_song", "bad_clip", "wrong_title", "other"],
    }).notNull(),
    detail: text(),
    playerKey: text("player_key").notNull(),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
    resolvedBy: integer("resolved_by"),
    resolution: text(),
  },
  (table) => [
    index("track_reports_track")
      .on(table.trackKey)
      .where(sql`resolved_at IS NULL`),
    index("track_reports_open")
      .on(table.createdAt)
      .where(sql`resolved_at IS NULL`),
    check(
      "track_reports_check_6",
      sql`reason IN ('wrong_song', 'bad_clip', 'wrong_title', 'other')`,
    ),
  ],
);

export const adminActions = sqliteTable(
  "admin_actions",
  {
    id: integer().primaryKey(),
    githubId: integer("github_id").notNull(),
    action: text().notNull(),
    target: text(),
    detail: text(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("admin_actions_time").on(table.createdAt)],
);

export const categorySources = sqliteTable(
  "category_sources",
  {
    id: integer().primaryKey(),
    category: text()
      .notNull()
      .references(() => categories.slug, { onDelete: "cascade" }),
    kind: text({ enum: ["deezer_playlist", "curated"] }).notNull(),
    ref: text().notNull(),
    title: text(),
    tracksCount: integer("tracks_count"),
    decade: integer(),
    position: integer().default(0).notNull(),
    refreshedAt: integer("refreshed_at"),
  },
  (table) => [
    unique("category_sources_category_kind_ref_unique").on(
      table.category,
      table.kind,
      table.ref,
    ),
    check(
      "category_sources_check_7",
      sql`kind IN ('deezer_playlist', 'curated')`,
    ),
  ],
);

export const catalogTracks = sqliteTable("catalog_tracks", {
  trackKey: text("track_key").primaryKey(),
  deezerId: integer("deezer_id"),
  title: text().notNull(),
  originalTitle: text("original_title"),
  // The show or film a curated song comes from, and its slot there ("OP2").
  work: text(),
  theme: text(),
  artist: text().notNull(),
  artistId: integer("artist_id"),
  cover: text(),
  link: text(),
  preview: text(),
  year: integer(),
  yearAt: integer("year_at"),
  // All-time Spotify streams from kworb, when the curated list carries one.
  streams: integer(),

  answerTitle: text("answer_title"),
  answerYear: integer("answer_year"),
  bannedAt: integer("banned_at"),
  banReason: text("ban_reason"),
  updatedAt: integer("updated_at").notNull(),
});

export const catalogMembers = sqliteTable(
  "catalog_members",
  {
    sourceId: integer("source_id")
      .notNull()
      .references(() => categorySources.id, { onDelete: "cascade" }),
    trackKey: text("track_key")
      .notNull()
      .references(() => catalogTracks.trackKey),
    position: integer().notNull(),
  },
  (table) => [
    index("catalog_members_track").on(table.trackKey),
    primaryKey({
      columns: [table.sourceId, table.trackKey],
      name: "catalog_members_pk",
    }),
  ],
);

export const roundOutcomes = sqliteTable(
  "round_outcomes",
  {
    id: integer().primaryKey(),
    playerKey: text("player_key").notNull(),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    trackKey: text("track_key").notNull(),
    category: text().notNull(),
    era: integer(),
    mode: text({ enum: modes }).notNull(),
    kind: text({ enum: gameKinds }).notNull(),
    correct: integer().notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    answeredAt: integer("answered_at").notNull(),
    gameId: text("game_id"),
    round: integer(),
    title: text(),
    artist: text(),
  },
  (table) => [
    index("round_outcomes_game").on(table.gameId),
    index("round_outcomes_user")
      .on(table.userId)
      .where(sql`user_id IS NOT NULL`),
    index("round_outcomes_track").on(table.trackKey),
    index("round_outcomes_player").on(
      table.playerKey,
      table.category,
      table.era,
    ),
    check("round_outcomes_check_8", sql`mode IN ('easy', 'normal', 'hard')`),
    check("round_outcomes_check_9", sql`kind IN ('solo', 'room', 'match')`),
  ],
);

// One logistic rating per player and per track: the chance of a right answer
// is σ(skill − difficulty + modeOffset). A track starts from its streams
// prior and each recorded outcome moves both ratings.
export const playerRatings = sqliteTable("player_ratings", {
  playerKey: text("player_key").primaryKey(),
  skill: real().notNull(),
  rounds: integer().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const trackRatings = sqliteTable("track_ratings", {
  trackKey: text("track_key").primaryKey(),
  difficulty: real().notNull(),
  answers: integer().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// One row: how far the rebuild over round_outcomes has run, and when it
// finished. Until done_at is set, recordOutcomes leaves the ratings to the
// rebuild so an outcome is never counted twice.
export const ratingState = sqliteTable("rating_state", {
  id: integer().primaryKey(),
  lastOutcomeId: integer("last_outcome_id").notNull(),
  doneAt: integer("done_at"),
});

export const games = sqliteTable(
  "games",
  {
    id: text().primaryKey(),
    kind: text({ enum: gameKinds }).notNull(),
    room: text(),
    category: text().notNull(),
    mode: text({ enum: modes }).notNull(),
    origin: text({
      enum: ["start", "rematch", "pick", "match", "solo"],
    }).notNull(),
    players: integer().notNull(),
    startedAt: integer("started_at").notNull(),
  },
  (table) => [
    index("games_room").on(table.room, table.startedAt),
    index("games_time").on(table.startedAt),
    check("games_check_10", sql`kind IN ('solo', 'room', 'match')`),
    check("games_check_11", sql`mode IN ('easy', 'normal', 'hard')`),
    check(
      "games_check_12",
      sql`origin IN ('start', 'rematch', 'pick', 'match', 'solo')`,
    ),
  ],
);

// The warm claim for an intro clip. One atomic INSERT wins the antra job for
// a deezer track across every isolate; a claim older than two minutes is
// stale and can be reclaimed.
export const warmClaims = sqliteTable("warm_claims", {
  deezerId: integer("deezer_id").primaryKey(),
  claimedAt: integer("claimed_at").notNull(),
  // Token the claimer generated; a release deletes only its own claim, so a
  // slow worker cannot drop a claim another isolate has since taken.
  owner: text().notNull(),
});
