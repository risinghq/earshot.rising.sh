import { describe, expect, it } from "vitest";
import {
  blend,
  youtubePlaylistUrl,
  type PartyCandidate,
  type PartyUser,
} from "../src/party-blend";

function candidate(
  trackId: number,
  artist: string,
  plays: number,
  videoId: string | null = `v${trackId}`,
): PartyCandidate {
  return {
    trackId,
    title: `Song ${trackId}`,
    artist,
    artistKey: artist,
    videoId,
    image: null,
    plays,
  };
}

function user(name: string, tracks: PartyCandidate[]): PartyUser {
  return { name, tracks };
}

describe("blend", () => {
  it("puts shared tracks first, ordered by how many people share them", () => {
    const items = blend(
      [
        user("a", [
          candidate(1, "X", 9),
          candidate(2, "Y", 8),
          candidate(3, "Z", 7),
        ]),
        user("b", [candidate(3, "Z", 9), candidate(2, "Y", 7)]),
        user("c", [candidate(3, "Z", 6)]),
      ],
      4,
    );
    expect(items.map((item) => item.trackId)).toEqual([3, 2, 1]);
    expect(items[0]?.names).toEqual(["a", "b", "c"]);
    expect(items[1]?.names).toEqual(["a", "b"]);
  });

  it("round-robins the rest so a heavy listener cannot dominate", () => {
    const items = blend(
      [
        user(
          "heavy",
          [1, 2, 3, 4, 5, 6].map((id) => candidate(id, "X", 100 - id)),
        ),
        user("light", [candidate(7, "Y", 1)]),
      ],
      5,
    );
    expect(items.map((item) => item.trackId)).toEqual([1, 7, 2, 3, 4]);
    expect(items[1]?.names).toEqual(["light"]);
  });

  it("defers a turn so an artist sits at least four slots apart", () => {
    const items = blend(
      [
        user("a", [candidate(1, "Same", 9), candidate(2, "Same", 8)]),
        user("b", [
          candidate(3, "X", 9),
          candidate(4, "Y", 8),
          candidate(5, "Z", 7),
          candidate(6, "W", 6),
        ]),
      ],
      6,
    );
    expect(items.map((item) => item.trackId)).toEqual([1, 3, 4, 5, 2, 6]);
  });

  it("places a close artist when every candidate violates the gap", () => {
    const items = blend(
      [
        user(
          "a",
          [1, 2, 3].map((id) => candidate(id, "Same", 9 - id)),
        ),
      ],
      3,
    );
    expect(items.map((item) => item.trackId)).toEqual([1, 2, 3]);
  });

  it("is deterministic for the same input", () => {
    const users = [
      user("a", [candidate(1, "X", 5), candidate(2, "Y", 4)]),
      user("b", [candidate(2, "Y", 5), candidate(3, "Z", 4)]),
    ];
    expect(blend(users, 4)).toEqual(blend(users, 4));
  });

  it("builds the YouTube link from video ids only, capped at 50", () => {
    const items = blend(
      [
        user(
          "a",
          Array.from({ length: 75 }, (_, index) =>
            candidate(
              index + 1,
              `Artist ${index}`,
              100 - index,
              index % 15 === 0 ? null : `vid-${index}`,
            ),
          ),
        ),
      ],
      75,
    );
    const url = youtubePlaylistUrl(items);
    expect(url).not.toBeNull();
    expect(
      url?.startsWith("https://www.youtube.com/watch_videos?video_ids="),
    ).toBe(true);
    const ids = url?.split("video_ids=")[1]?.split(",");
    expect(ids).toHaveLength(50);
    expect(ids?.every((id) => id.startsWith("vid-"))).toBe(true);
    expect(items.filter((item) => item.videoId === null)).toHaveLength(5);
  });

  it("returns no link when no track has a video id", () => {
    const items = blend(
      [user("a", [candidate(1, "X", 5, null), candidate(2, "Y", 4, null)])],
      2,
    );
    expect(youtubePlaylistUrl(items)).toBeNull();
  });
});
