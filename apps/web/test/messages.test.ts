import { describe, expect, it } from "vitest";
import { readClientMessage, readMatchMessage } from "../src/play/messages";

const read = (value: unknown) => readClientMessage(JSON.stringify(value));

describe("room socket messages", () => {
  it("reads each message the room's pages send", () => {
    expect(read({ type: "join", name: "Ann", token: "t" })).toEqual({
      type: "join",
      name: "Ann",
      token: "t",
    });
    expect(read({ type: "watch" })).toEqual({ type: "watch" });
    expect(read({ type: "answer", answer: "Song" })).toEqual({
      type: "answer",
      answer: "Song",
    });
    expect(read({ type: "suggest", category: "pop", mode: "hard" })).toEqual({
      type: "suggest",
      category: "pop",
      mode: "hard",
    });
  });

  it("cuts long text instead of refusing it", () => {
    const answer = read({ type: "answer", answer: "a".repeat(500) });
    expect(answer).toEqual({ type: "answer", answer: "a".repeat(200) });
  });

  it("ignores anything that is not a message", () => {
    expect(readClientMessage("not json")).toBeNull();
    expect(readClientMessage(new ArrayBuffer(4))).toBeNull();
    expect(read({ type: "kick" })).toBeNull();
    expect(read({ type: "answer", answer: 5 })).toBeNull();
    expect(
      read({ type: "suggest", category: "pop", mode: "expert" }),
    ).toBeNull();
    expect(read({ type: "vote" })).toBeNull();
  });
});

describe("matchmaker socket messages", () => {
  it("reads a join with or without a name", () => {
    expect(readMatchMessage('{"type":"join"}')).toEqual({ type: "join" });
    expect(readMatchMessage('{"type":"join","name":"Bo"}')).toEqual({
      type: "join",
      name: "Bo",
    });
    expect(readMatchMessage('{"type":"leave"}')).toBeNull();
  });
});
