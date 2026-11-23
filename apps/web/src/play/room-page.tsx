import { providerHref, type SignedInUser } from "../auth";
import { ScriptTag } from "../ui/assets";
import { SaveScoreCard, SignInButtons } from "../ui/empty";
import { Page } from "../ui/shell";
import { quitDialog } from "./pages";
import { categoryBoardDays } from "./results";

// The room page is one shell for every phase. The room plays over a live
// socket, so client/room/ draws every view into #game from the room's
// state; the server sends what only it owns. The round uses the solo
// round's parts (game bar, stage, choices, results), so the two modes look
// and move the same. The room's own parts come from the Claude Design file
// "Earshot Room".
export function roomPage(code: string, user: SignedInUser | null) {
  const back = `/play/room/${code}`;
  return Page({
    title: `Room ${code}`,
    user,
    chrome: "game",
    styles: ["common", "game", "room"],
    children: (
      <div
        id="game"
        class="room"
        data-code={code}
        data-user={user ? "1" : undefined}
        data-board-days={String(categoryBoardDays)}
        data-phase="connecting"
      >
        <noscript>
          <p class="meta">
            This room needs JavaScript: it plays over a live connection.
          </p>
        </noscript>
        {quitDialog()}
        {/* The sign-in markup the room shows, built from the auth routes'
            links; the client takes a copy of each part where it needs it. */}
        <template id="room-parts">
          <div data-part="sign-in">
            <SignInButtons next={back} />
          </div>
          <div data-part="save">
            <SaveScoreCard id="done-save" title="" next={back} hidden />
          </div>
          <div data-part="board-foot">
            <p class="board-foot" id="done-board-foot">
              <a href={providerHref("google", back)}>Sign in</a> to put your
              next room scores on the board.
            </p>
          </div>
        </template>
        <ScriptTag name="room" />
      </div>
    ),
  });
}
