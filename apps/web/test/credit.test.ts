import { describe, expect, it } from "vitest";
import { creditLine } from "../src/play/sources";

const credited = (...people: [string, string][]) => ({
  contributors: people.map(([name, role]) => ({ name, role })),
});

describe("creditLine", () => {
  it("leaves a solo track to its lead artist", () => {
    expect(creditLine(credited(["Daft Punk", "Main"]))).toBeUndefined();
    expect(creditLine({})).toBeUndefined();
  });

  it("joins two or three artists, main ones first", () => {
    expect(
      creditLine(credited(["Lady Gaga", "Main"], ["Bruno Mars", "Main"])),
    ).toBe("Lady Gaga & Bruno Mars");
    expect(
      creditLine(
        credited(
          ["Justin Bieber", "Featured"],
          ["Luis Fonsi", "Main"],
          ["Daddy Yankee", "Main"],
        ),
      ),
    ).toBe("Luis Fonsi, Daddy Yankee & Justin Bieber");
  });

  it("counts the names past three", () => {
    expect(
      creditLine(
        credited(
          ["HUNTR/X", "Main"],
          ["EJAE", "Main"],
          ["Audrey Nuna", "Main"],
          ["REI AMI", "Main"],
          ["KPop Demon Hunters Cast", "Main"],
        ),
      ),
    ).toBe("HUNTR/X, EJAE, Audrey Nuna +2");
  });

  it("names an artist credited twice once", () => {
    expect(
      creditLine(credited(["LiSA", "Main"], ["LiSA", "Featured"])),
    ).toBeUndefined();
  });
});
