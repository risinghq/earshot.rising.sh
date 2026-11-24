// Adaptive difficulty: one logistic rating per player and per track. The
// chance of a right answer is σ(skill − difficulty + modeOffset). A track
// starts at a prior taken from its streams, scaled inside its category, and
// every recorded outcome moves both ratings, Elo-style. The rebuild walks
// round_outcomes once so the answers already logged count too.
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { batchWrites, database, jsonRows, t, type Db } from "../../platform/db";
import type { Env } from "../../env";
import type { Mode } from "./rules";

// The draw favours tracks a player is likely, but not certain, to know.
export const targetChance = 0.7;
const targetWidth = 0.2;

// A mean track meets a mean player at the 0.61 hit rate round_outcomes shows.
const meanRate = 0.61;
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const baseDifficulty = -logit(meanRate);

// The offset is per mode: a choice of titles with artists is easier than
// titles alone, and typing is harder than both.
export const modeOffset: Record<Mode, number> = {
  easy: 0.5,
  normal: 0,
  hard: -1.2,
};

// The prior moves half a logit per standard deviation of log streams inside
// the category, clamped so an outlier cannot leave the prior's reach.
const streamsSlope = 0.5;
const zClamp = 2.5;

// Each outcome moves a player's skill a fixed step and the track's difficulty
// a step that shrinks as the track gathers answers.
const playerStep = 0.4;
const trackStepBase = 0.6;
const trackStepHalving = 8;

const rebuildChunk = 400;

export function chance(skill: number, difficulty: number, mode: Mode) {
  return sigmoid(skill - difficulty + modeOffset[mode]);
}

interface StreamStats {
  mean: number;
  sd: number;
}

// A track with no count starts at its category's mean.
export function difficultyPrior(
  streams: number | null,
  stats: StreamStats | null,
) {
  if (streams === null || stats === null || stats.sd === 0)
    return baseDifficulty;
  const z = Math.max(
    -zClamp,
    Math.min(zClamp, (Math.log(streams) - stats.mean) / stats.sd),
  );
  return baseDifficulty - streamsSlope * z;
}

const inJson = (column: unknown, keys: string[]) =>
  sql`${column} IN (SELECT value FROM ${jsonRows(keys)})`;

async function playerSkills(db: Db, keys: string[]) {
  if (keys.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ key: t.playerRatings.playerKey, skill: t.playerRatings.skill })
    .from(t.playerRatings)
    .where(inJson(t.playerRatings.playerKey, keys));
  return new Map(rows.map((row) => [row.key, row.skill]));
}

async function storedDifficulties(db: Db, keys: string[]) {
  if (keys.length === 0) return new Map<string, number>();
  const rows = await db
    .select({
      key: t.trackRatings.trackKey,
      difficulty: t.trackRatings.difficulty,
    })
    .from(t.trackRatings)
    .where(inJson(t.trackRatings.trackKey, keys));
  return new Map(rows.map((row) => [row.key, row.difficulty]));
}

// The mean and spread of log streams across a category's catalog tracks.
async function streamStats(db: Db, categories: string[]) {
  const stats = new Map<string, StreamStats>();
  if (categories.length === 0) return stats;
  const rows = await db
    .select({
      category: t.categorySources.category,
      streams: t.catalogTracks.streams,
    })
    .from(t.catalogMembers)
    .innerJoin(
      t.categorySources,
      eq(t.categorySources.id, t.catalogMembers.sourceId),
    )
    .innerJoin(
      t.catalogTracks,
      eq(t.catalogTracks.trackKey, t.catalogMembers.trackKey),
    )
    .where(
      and(
        inArray(t.categorySources.category, categories),
        isNotNull(t.catalogTracks.streams),
      ),
    );
  const logs = new Map<string, number[]>();
  for (const row of rows) {
    if (row.streams === null) continue;
    logs.set(row.category, [
      ...(logs.get(row.category) ?? []),
      Math.log(row.streams),
    ]);
  }
  for (const [category, values] of logs) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
    );
    stats.set(category, { mean, sd });
  }
  return stats;
}

// The difficulty a track plays at: its stored rating, else its streams prior
// scaled inside the category the game drew it from.
export async function trackDifficulties(
  db: Db,
  items: { key: string; category: string }[],
): Promise<Map<string, number>> {
  const keys = [...new Set(items.map((item) => item.key))];
  const stored = await storedDifficulties(db, keys);
  const categories = new Map<string, string>();
  for (const item of items)
    if (!stored.has(item.key) && !categories.has(item.key))
      categories.set(item.key, item.category);
  const [stats, streams] = await Promise.all([
    streamStats(db, [...new Set(categories.values())]),
    keys.length === 0
      ? new Map<string, number | null>()
      : db
          .select({
            key: t.catalogTracks.trackKey,
            streams: t.catalogTracks.streams,
          })
          .from(t.catalogTracks)
          .where(inJson(t.catalogTracks.trackKey, keys))
          .then((rows) => new Map(rows.map((row) => [row.key, row.streams]))),
  ]);
  return new Map(
    keys.map((key) => [
      key,
      stored.get(key) ??
        difficultyPrior(
          streams.get(key) ?? null,
          stats.get(categories.get(key) ?? "") ?? null,
        ),
    ]),
  );
}

export interface RatingOutcome {
  playerKey: string;
  trackKey: string;
  category: string;
  mode: Mode;
  correct: boolean;
}

// Moves the player's skill and the track's difficulty once per outcome.
// Unrated players start at the mean skill; unrated tracks at their prior.
export async function applyOutcomes(
  db: Db,
  rows: RatingOutcome[],
  now = Math.floor(Date.now() / 1000),
) {
  const playerKeys = [...new Set(rows.map((row) => row.playerKey))];
  const items = [...new Set(rows.map((row) => row.trackKey))].map((key) => ({
    key,
    category: rows.find((row) => row.trackKey === key)!.category,
  }));
  const [skills, difficulties, priors] = await Promise.all([
    db
      .select({
        key: t.playerRatings.playerKey,
        skill: t.playerRatings.skill,
        rounds: t.playerRatings.rounds,
      })
      .from(t.playerRatings)
      .where(inJson(t.playerRatings.playerKey, playerKeys))
      .then(
        (rows) =>
          new Map(
            rows.map((row) => [
              row.key,
              { skill: row.skill, rounds: row.rounds },
            ]),
          ),
      ),
    db
      .select({
        key: t.trackRatings.trackKey,
        difficulty: t.trackRatings.difficulty,
        answers: t.trackRatings.answers,
      })
      .from(t.trackRatings)
      .where(
        inJson(
          t.trackRatings.trackKey,
          items.map((i) => i.key),
        ),
      )
      .then(
        (rows) =>
          new Map(
            rows.map((row) => [
              row.key,
              { difficulty: row.difficulty, answers: row.answers },
            ]),
          ),
      ),
    trackDifficulties(db, items),
  ]);
  for (const row of rows) {
    const player = skills.get(row.playerKey) ?? { skill: 0, rounds: 0 };
    const track = difficulties.get(row.trackKey) ?? {
      difficulty: priors.get(row.trackKey) ?? baseDifficulty,
      answers: 0,
    };
    const miss =
      (row.correct ? 1 : 0) - chance(player.skill, track.difficulty, row.mode);
    player.skill += playerStep * miss;
    track.difficulty -=
      ((trackStepBase * trackStepHalving) /
        (trackStepHalving + track.answers)) *
      miss;
    player.rounds += 1;
    track.answers += 1;
    skills.set(row.playerKey, player);
    difficulties.set(row.trackKey, track);
  }
  await batchWrites(db, [
    ...[...skills].map(([key, player]) =>
      db
        .insert(t.playerRatings)
        .values({
          playerKey: key,
          skill: player.skill,
          rounds: player.rounds,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: t.playerRatings.playerKey,
          set: {
            skill: player.skill,
            rounds: player.rounds,
            updatedAt: now,
          },
        }),
    ),
    ...[...difficulties].map(([key, track]) =>
      db
        .insert(t.trackRatings)
        .values({
          trackKey: key,
          difficulty: track.difficulty,
          answers: track.answers,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: t.trackRatings.trackKey,
          set: {
            difficulty: track.difficulty,
            answers: track.answers,
            updatedAt: now,
          },
        }),
    ),
  ]);
}

// Ratings a recorded outcome should apply. Until the rebuild is done the
// rows are left to it, so no outcome is counted twice.
export async function updateRatings(
  db: Db,
  rows: RatingOutcome[],
  now = Math.floor(Date.now() / 1000),
) {
  const state = await db
    .select()
    .from(t.ratingState)
    .where(eq(t.ratingState.id, 1))
    .get();
  if (state?.doneAt == null) return;
  await applyOutcomes(db, rows, now);
}

// A bounded step of the one-time rebuild over round_outcomes, run from the
// minutely cron. Returns true once every outcome is counted.
export async function rebuildRatings(
  env: Env,
  limit = rebuildChunk,
  now = Math.floor(Date.now() / 1000),
) {
  const db = database(env.DB);
  const state = await db
    .select()
    .from(t.ratingState)
    .where(eq(t.ratingState.id, 1))
    .get();
  if (state?.doneAt != null) return true;
  const lastId = state?.lastOutcomeId ?? 0;
  const rows = await db
    .select({
      id: t.roundOutcomes.id,
      playerKey: t.roundOutcomes.playerKey,
      trackKey: t.roundOutcomes.trackKey,
      category: t.roundOutcomes.category,
      mode: t.roundOutcomes.mode,
      correct: t.roundOutcomes.correct,
    })
    .from(t.roundOutcomes)
    .where(gt(t.roundOutcomes.id, lastId))
    .orderBy(t.roundOutcomes.id)
    .limit(limit);
  if (rows.length === 0) {
    await db
      .insert(t.ratingState)
      .values({ id: 1, lastOutcomeId: lastId, doneAt: now })
      .onConflictDoUpdate({
        target: t.ratingState.id,
        set: { doneAt: now },
      });
    return true;
  }
  await applyOutcomes(
    db,
    rows.map((row) => ({
      playerKey: row.playerKey,
      trackKey: row.trackKey,
      category: row.category,
      mode: row.mode,
      correct: row.correct === 1,
    })),
    now,
  );
  const last = rows[rows.length - 1].id;
  await db
    .insert(t.ratingState)
    .values({ id: 1, lastOutcomeId: last, doneAt: null })
    .onConflictDoUpdate({
      target: t.ratingState.id,
      set: { lastOutcomeId: last, doneAt: null },
    });
  return false;
}

const secure = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

// A weighted permutation: every item can still be drawn, but the weight it
// carries decides how early it lands (Efraimidis–Spirakis). Equal weights
// are the plain shuffle.
export function weightedShuffle<T>(
  items: T[],
  weigh: (item: T, index: number) => number,
  rand: () => number = secure,
) {
  return items
    .map((item, index) => ({
      item,
      key: Math.pow(
        Math.max(rand(), 1e-12),
        1 / Math.max(weigh(item, index), 1e-12),
      ),
    }))
    .sort((a, b) => b.key - a.key)
    .map(({ item }) => item);
}

// The draw weight of each item for the median rated player: how close its
// predicted chance comes to the target. Items share the caller's order.
export async function drawWeights(
  db: Db,
  playerKeys: string[],
  items: { key: string; category: string }[],
  mode: Mode,
) {
  const [skills, difficulties] = await Promise.all([
    playerSkills(db, playerKeys),
    trackDifficulties(db, items),
  ]);
  const ordered = playerKeys
    .map((key) => skills.get(key) ?? 0)
    .sort((a, b) => a - b);
  const skill =
    ordered.length === 0 ? 0 : ordered[Math.floor(ordered.length / 2)];
  return items.map((item) => {
    const p = chance(skill, difficulties.get(item.key) ?? baseDifficulty, mode);
    return Math.exp(-((p - targetChance) ** 2) / (2 * targetWidth ** 2));
  });
}
