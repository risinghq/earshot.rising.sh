import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import type { Game } from "../game/game";

const gameTtlMs = 3600 * 1000;

// One object per solo game holds its state. A read sees the last write at
// once, which KV did not promise, and a write is a local storage commit, not
// the half-second KV put that every tap used to wait on.
export class SoloGame extends DurableObject<Env> {
  private game: Game | null | undefined;

  async read(): Promise<Game | null> {
    if (this.game === undefined)
      this.game = (await this.ctx.storage.get<Game>("game")) ?? null;
    return this.game;
  }

  async write(game: Game): Promise<void> {
    this.game = game;
    await this.ctx.storage.put("game", game);
    // Every write pushes the expiry out, so a game lives an hour past its
    // last move, as the KV TTL did.
    await this.ctx.storage.setAlarm(Date.now() + gameTtlMs);
  }

  async alarm(): Promise<void> {
    this.game = null;
    await this.ctx.storage.deleteAll();
  }
}
