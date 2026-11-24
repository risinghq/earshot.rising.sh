import { describe, expect, it } from "vitest";
import * as game from "../src/play/room/game";
import type { Presence, RoomInit, Stored } from "../src/play/room/game";
import { roundsPerGame, scoreFor } from "../src/play/game/rules";

const songs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    title: `Song ${i}`,
    artist: `Artist ${i}`,
    cover: null,
    link: null,
  }));

const inOrder = <T>(items: T[]) => items;

function newRoom(init: Partial<RoomInit> = {}) {
  let next = 0;
  return game.createRoom(
    {
      code: "ABCDEF",
      kind: "room",
      categorySlug: "pop",
      categoryName: "Pop",
      mode: "normal",
      candidates: songs(10),
      creatorToken: "host",
      players: [],
      ...init,
    },
    0,
    () => `seat-${(next += 1)}`,
  );
}

let fresh = 0;
function join(
  s: Stored,
  typed: string,
  request: Partial<game.SeatRequest> = {},
) {
  fresh += 1;
  return game.seat(
    s,
    {
      token: undefined,
      uid: null,
      signedName: "",
      typed,
      anon: null,
      ...request,
    },
    0,
    { id: `p${fresh}`, token: `t${fresh}` },
  );
}

function seated(s: Stored, typed: string, request?: Partial<game.SeatRequest>) {
  const result = join(s, typed, request);
  if (!result.ok) throw new Error(`seat refused: ${result.code}`);
  return result.player;
}

const present = (...ids: string[]): Presence => ({
  connected: new Set(ids),
  screen: false,
});

const watched = (...ids: string[]): Presence => ({
  connected: new Set(ids),
  screen: true,
});

// Begins a game and opens its first round at `now`.
function playing(s: Stored, presence: Presence, now = 1_000) {
  game.begin(s, now, presence, "game-1", undefined, inOrder);
  const index = game.takeCandidate(s)!;
  game.openRound(s, index, {}, now);
  return s.round!;
}

const titleOf = (s: Stored) => s.candidates[s.round!.index].title;

function match() {
  return newRoom({
    kind: "match",
    creatorToken: "",
    players: [
      { name: "Ann", token: "a", userId: null },
      { name: "Bob", token: "b", userId: null },
    ],
  });
}

describe("seats", () => {
  it("plants a signed-in name up to 39 characters and a guest's up to 20", () => {
    const seats = (name: string, userId: number | null) => [
      { name, token: "t1", userId },
      { name: "Bob", token: "t2", userId: null },
    ];
    expect(game.seatedOk(seats("x".repeat(39), 1))).toBe(true);
    expect(game.seatedOk(seats("x".repeat(40), 1))).toBe(false);
    expect(game.seatedOk(seats("y".repeat(20), null))).toBe(true);
    expect(game.seatedOk(seats("y".repeat(21), null))).toBe(false);
    expect(game.seatedOk(seats("bob", null))).toBe(false);
  });

  it("seats the creator as Host when they give no nickname", () => {
    const s = newRoom();
    expect(seated(s, "", { token: "host" })).toMatchObject({
      name: "Host",
      creator: true,
    });
  });

  it("refuses a nickname another player holds, whatever its case", () => {
    const s = newRoom();
    seated(s, "Ann");
    expect(join(s, "ann")).toEqual({
      ok: false,
      code: "taken",
      preview: false,
    });
  });

  it("refuses an empty or overlong nickname", () => {
    const s = newRoom();
    expect(join(s, "  ")).toMatchObject({ ok: false, code: "name" });
    expect(join(s, "x".repeat(game.nicknameMaxLength + 1))).toMatchObject({
      ok: false,
      code: "name",
    });
  });

  it("seats a signed-in player under the next free variant of their name", () => {
    const s = newRoom();
    seated(s, "David");
    expect(seated(s, "", { uid: 7, signedName: "David" })).toMatchObject({
      name: "David 2",
      userId: 7,
    });
  });

  it("gives a signed-in player the same seat on another device", () => {
    const s = newRoom();
    const first = seated(s, "", { uid: 7, signedName: "David" });
    expect(seated(s, "", { uid: 7, signedName: "David" }).id).toBe(first.id);
    expect(s.players).toHaveLength(1);
  });

  it("moves a guest's seat into the account they sign in with", () => {
    const s = newRoom();
    const guest = seated(s, "Ann");
    expect(join(s, "", { token: guest.token, uid: 9 })).toMatchObject({
      ok: true,
      claimed: true,
    });
    expect(s.players[0].userId).toBe(9);
  });

  it("refuses a player once every seat is taken", () => {
    const s = newRoom();
    for (let i = 0; i < game.maxPlayers; i += 1) seated(s, `P${i}`);
    expect(join(s, "Late")).toEqual({ ok: false, code: "full", preview: true });
  });

  it("admits nobody to a match beyond the seats it was made with", () => {
    const s = match();
    expect(join(s, "Cy")).toMatchObject({ ok: false, code: "full" });
    expect(join(s, "", { token: "a" })).toMatchObject({ ok: true });
  });
});

describe("answers", () => {
  it("scores a right answer by how fast it came", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    game.answer(s, ann.id, titleOf(s), round.startedAt + 3_000);
    expect(s.players[0]).toMatchObject({
      score: scoreFor(3_000),
      streak: 1,
      correct: 1,
    });
  });

  it("scores a wrong answer 0 and breaks the streak", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    s.players[0].streak = 3;
    game.answer(s, ann.id, "Not the title", round.startedAt + 1_000);
    expect(s.players[0]).toMatchObject({ score: 0, streak: 0 });
  });

  it("ignores an answer sent before the clip starts, and a second one", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    expect(game.answer(s, ann.id, titleOf(s), round.startedAt - 500)).toBe(
      false,
    );
    game.answer(s, ann.id, "Wrong", round.startedAt + 1_000);
    expect(game.answer(s, ann.id, titleOf(s), round.startedAt + 2_000)).toBe(
      false,
    );
    expect(s.players[0].score).toBe(0);
  });

  it("accepts a typed title in Hard", () => {
    const s = newRoom({ mode: "hard" });
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    game.answer(s, ann.id, ` ${titleOf(s).toLowerCase()} `, round.startedAt);
    expect(s.players[0].score).toBe(1000);
  });

  it("waits for every connected player, and stops waiting for one who left", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const bob = seated(s, "Bob");
    const round = playing(s, present(ann.id, bob.id));
    game.answer(s, ann.id, titleOf(s), round.startedAt + 1_000);
    expect(game.everyoneAnswered(s, present(ann.id, bob.id))).toBe(false);
    expect(game.everyoneAnswered(s, present(ann.id))).toBe(true);
  });
});

describe("reveal", () => {
  it("writes an outcome for each player who answered", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const bob = seated(s, "Bob");
    const round = playing(s, present(ann.id, bob.id));
    game.answer(s, ann.id, titleOf(s), round.startedAt + 1_000);
    const outcomes = game.closeRound(s, round.startedAt + 2_000);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      category: "pop",
      correct: true,
      elapsedMs: 1_000,
      gameId: "game-1",
      round: 1,
    });
    expect(s.phase).toBe("reveal");
    expect(s.reveal!.until).toBe(round.startedAt + 2_000 + game.revealMs);
  });

  it("breaks the streak of a player who did not answer", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    s.players[0].streak = 2;
    game.closeRound(s, round.endsAt);
    expect(s.players[0]).toMatchObject({ streak: 0, marks: [false] });
  });

  it("writes no outcomes for a room without a category", () => {
    const s = newRoom({ categorySlug: "" });
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    game.answer(s, ann.id, titleOf(s), round.startedAt);
    expect(game.closeRound(s, round.startedAt)).toEqual([]);
  });

  it("ends the game after its rounds or when the songs run out", () => {
    const short = newRoom({ candidates: songs(4) });
    playing(short, present());
    expect(game.gameOver(short)).toBe(false);
    while (game.takeCandidate(short) !== null);
    expect(game.gameOver(short)).toBe(true);
    const long = newRoom({ candidates: songs(30) });
    long.served = roundsPerGame;
    expect(game.gameOver(long)).toBe(true);
  });
});

describe("round start", () => {
  it("waits four seconds for devices that do not report the clip", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id), 1_000);
    expect(round.startedAt).toBe(1_000 + game.readyWaitMs + game.startLeadMs);
    expect(game.startEarly(s, 1_200, present(ann.id))).toBe(false);
  });

  it("starts early once every connected device has loaded the clip", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const bob = seated(s, "Bob");
    const presence = present(ann.id, bob.id);
    playing(s, presence, 1_000);
    game.markLoaded(s, ann.id);
    expect(game.startEarly(s, 1_200, presence)).toBe(false);
    game.markLoaded(s, bob.id);
    expect(game.startEarly(s, 1_300, presence)).toBe(true);
    expect(s.round!.startedAt).toBe(1_300 + game.startLeadMs);
    expect(s.round!.endsAt - s.round!.startedAt).toBe(15_000);
  });

  it("waits for a watching screen as well as the phones", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    playing(s, watched(ann.id), 1_000);
    game.markLoaded(s, ann.id);
    expect(game.startEarly(s, 1_200, watched(ann.id))).toBe(false);
    game.markLoaded(s, "screen");
    expect(game.startEarly(s, 1_200, watched(ann.id))).toBe(true);
  });

  it("retries the same song after a quota answer", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    game.begin(s, 1_000, present(ann.id), "game-1", undefined, inOrder);
    const index = game.takeCandidate(s)!;
    game.holdForQuota(s, index, 2_000);
    const retryAt = 2_000 + game.quotaRetryMs;
    expect(game.dueAt(s, retryAt - 1, present(ann.id))).toBeNull();
    expect(game.dueAt(s, retryAt, present(ann.id))).toBe("retry");
    expect(game.takeCandidate(s)).toBe(index);
  });
});

describe("games", () => {
  it("starts the next game with fresh scores, streaks and marks", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    game.answer(s, ann.id, titleOf(s), round.startedAt);
    game.closeRound(s, round.startedAt);
    game.endGame(s);
    expect(game.begin(s, 9_000, present(ann.id), "game-2")).toMatchObject({
      id: "game-2",
      origin: "rematch",
    });
    expect(s.players[0]).toMatchObject({
      score: 0,
      streak: 0,
      correct: 0,
      marks: [],
    });
  });

  it("refuses to begin while a game is on", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    playing(s, present(ann.id));
    expect(game.begin(s, 2_000, present(ann.id), "game-2")).toBeNull();
  });

  it("counts only the players connected at the start", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    seated(s, "Bob");
    expect(game.begin(s, 0, present(ann.id), "g")).toMatchObject({
      origin: "start",
      players: 1,
    });
  });

  it("starts a match once every seat is connected", () => {
    const s = match();
    const [ann, bob] = s.players;
    expect(game.matchFilled(s, present(ann.id))).toBe(false);
    expect(game.matchFilled(s, present(ann.id, bob.id))).toBe(true);
  });

  it("ranks signed-in players and writes nothing for guests", () => {
    const s = newRoom();
    const ann = seated(s, "", { uid: 1, signedName: "Ann" });
    const bob = seated(s, "", { uid: 2, signedName: "Bob" });
    seated(s, "Guest");
    const round = playing(s, present(ann.id, bob.id));
    game.answer(s, bob.id, titleOf(s), round.startedAt);
    expect(
      game.resultRows(s, 100).map((r) => [r.userId, r.rank, r.players]),
    ).toEqual([
      [2, 1, 2],
      [1, 2, 2],
    ]);
    expect(game.resultRows(newRoom(), 100)).toEqual([]);
  });
});

describe("between games", () => {
  function finished() {
    const s = newRoom();
    const ann = seated(s, "Ann", { token: "host" });
    const bob = seated(s, "Bob");
    playing(s, present(ann.id, bob.id));
    game.endGame(s);
    return { s, ann, bob };
  }

  const rock = { slug: "rock", name: "Rock", mode: "normal" as const };
  const jazz = { slug: "jazz", name: "Jazz", mode: "normal" as const };

  it("orders Up next by votes, and a player holds one vote", () => {
    const { s, ann, bob } = finished();
    game.suggest(s, ann.id, rock, "x1", 0);
    game.suggest(s, bob.id, jazz, "x2", 0);
    game.vote(s, ann.id, "x2", 0);
    const shown = game.snapshot(s, ann.id, present(), null, 0).suggestions!;
    expect(shown.map((x) => [x.name, x.votes, x.voted])).toEqual([
      ["Jazz", 2, true],
      ["Rock", 0, false],
    ]);
  });

  it("counts a suggestion of what is already up next as a vote", () => {
    const { s, ann, bob } = finished();
    game.suggest(s, ann.id, rock, "x1", 0);
    game.suggest(s, bob.id, rock, "x2", 0);
    expect(s.suggestions).toHaveLength(1);
    expect(s.suggestions![0].voters).toEqual([ann.id, bob.id]);
  });

  it("refuses suggestions during a game", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    playing(s, present(ann.id));
    expect(game.suggest(s, ann.id, rock, "x1", 0)).toBe(false);
  });

  it("lets only the creator change the category, and only between games", () => {
    const { s } = finished();
    const target = {
      categorySlug: "rock",
      categoryName: "Rock",
      mode: "normal" as const,
      candidates: songs(5),
    };
    expect(game.retarget(s, "other", target, 0)).toBe(403);
    expect(game.retarget(s, "host", target, 0)).toBe(204);
    expect(s).toMatchObject({ phase: "lobby", categoryName: "Rock" });
    playing(s, present(s.players[0].id));
    expect(game.retarget(s, "host", target, 0)).toBe(409);
  });
});

describe("timing", () => {
  it("closes a room after an hour without action", () => {
    const s = newRoom();
    seated(s, "Ann");
    expect(game.dueAt(s, game.idleMs - 1, present())).toBeNull();
    expect(game.dueAt(s, game.idleMs, present())).toBe("expire");
  });

  it("starts a match with whoever came once the wait is over", () => {
    const s = match();
    const ann = s.players[0];
    expect(game.dueAt(s, game.matchWaitMs, present())).toBeNull();
    expect(game.nextDue(s, 0, present(ann.id))).toBe(game.matchWaitMs);
    expect(game.dueAt(s, game.matchWaitMs, present(ann.id))).toBe("begin");
  });

  it("arms the alarm for the round's end, never for a time already past", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    expect(game.nextDue(s, round.startedAt, present(ann.id))).toBe(
      round.endsAt,
    );
    expect(game.dueAt(s, round.endsAt, present(ann.id))).toBe("close");
    expect(game.nextDue(s, round.endsAt, present(ann.id))).toBe(
      s.lastActive + game.idleMs,
    );
  });

  it("advances from the reveal when it is over", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    game.closeRound(s, round.endsAt);
    expect(game.dueAt(s, s.reveal!.until, present(ann.id))).toBe("advance");
  });
});

describe("what each device sees", () => {
  it("plays the clip on the screen only while one watches", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    playing(s, present(ann.id));
    expect(game.snapshot(s, ann.id, present(ann.id), "clip", 0).clip).toBe(
      "clip",
    );
    expect(
      game.snapshot(s, ann.id, watched(ann.id), "clip", 0).clip,
    ).toBeUndefined();
    expect(game.snapshot(s, undefined, watched(ann.id), "clip", 0).clip).toBe(
      "clip",
    );
  });

  it("keeps a player's pick through a reload", () => {
    const s = newRoom();
    const ann = seated(s, "Ann");
    const round = playing(s, present(ann.id));
    game.answer(s, ann.id, "Song 3", round.startedAt);
    expect(game.snapshot(s, ann.id, present(ann.id), null, 0).you.answer).toBe(
      "Song 3",
    );
  });
});
