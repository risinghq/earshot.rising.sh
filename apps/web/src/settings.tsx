import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import {
  base64url,
  cookieClear,
  endSession,
  providerHref,
  providerNames,
  sha256Bytes,
  validName,
  type SignedInUser,
} from "./auth";
import { and, count, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { database, t, type Db } from "./db";
import { ingestPage, type PageSource } from "./ingest";
import { sourceNames } from "./names";
import { sealSecret } from "./secret";
import type { Env } from "./types";
import { pullIntervalSeconds } from "./ytmusic";
import {
  fetchHistoryPage,
  hasSapisid,
  HistoryPageError,
  parseHistoryPage,
  SignedOutError,
  todayIn,
} from "./youtube";
import { memberOnly } from "./sign-in";
import { Notice } from "./ui/notice";
import { Page } from "./ui/shell";
import { TokenDisplay } from "./ui/token";

const exportPageSize = 1000;

const timeZones = (() => {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
})();

// A stored zone wins; otherwise the browser's own zone replaces UTC.
const tzScript = `
const tzField = document.getElementById("ytmusic-tz");
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (tzField && tzField.dataset.stored === undefined &&
    [...tzField.options].some((option) => option.value === zone))
  tzField.value = zone;
`;

// The server checks the typed name again; this only arms the button.
const deleteScript = `
const confirmField = document.getElementById("confirm");
const deleteButton = document.getElementById("delete-account");
if (confirmField && deleteButton) {
  const arm = () => {
    deleteButton.disabled = confirmField.value.trim() !== confirmField.dataset.name;
  };
  arm();
  confirmField.addEventListener("input", arm);
}
`;

const exportScript = `
const exportAll = document.getElementById("export-all");
exportAll?.addEventListener("click", async (event) => {
  event.preventDefault();
  const label = exportAll.textContent;
  exportAll.textContent = "Exporting…";
  const parts = [];
  let url = "/settings/export";
  while (url !== null) {
    const page = await fetch(url);
    parts.push(await page.text());
    const link = page.headers.get("link");
    url = /<([^>]+)>;\\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(
    new Blob(parts, { type: "application/x-ndjson" }),
  );
  anchor.download = \`music-stats-\${exportAll.dataset.name}.ndjson\`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  exportAll.textContent = label;
});
`;

type PageData = Awaited<ReturnType<typeof pageData>>;
type SourceInfo = PageData["sources"][number];
type TokenInfo = PageData["tokens"][number];
type Logins = PageData["logins"];

function dayText(timestamp: number | null) {
  if (timestamp === null) return "never";
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

const leadNames: Record<string, string> = {
  ...sourceNames,
  listenbrainz: "your phone",
};

function sourcesLead(sources: SourceInfo[]) {
  if (sources.length === 0)
    return "No sources connected. Plays feed your profile, your For you mix and your groups.";
  const names = sources.map((source) => leadNames[source.kind] ?? source.kind);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Plays arrive from ${list}. They feed your profile, your For you mix and your groups.`;
}

function StatusPill({ source, on }: { source?: SourceInfo; on: string }) {
  if (source === undefined)
    return <span class="status-pill">Not connected</span>;
  if (source.status === "error")
    return <span class="status-pill is-bad">Needs attention</span>;
  if (source.status === "gap")
    return <span class="status-pill is-bad">Plays may be missing</span>;
  return <span class="status-pill is-on">{on}</span>;
}

function SourceProblems({ source }: { source?: SourceInfo }) {
  if (source === undefined) return null;
  return (
    <>
      {source.status === "gap" && (
        <p class="form-error">
          Uploads lost touch. Plays between the last aligned upload and the next
          one may be missing.
        </p>
      )}
      {source.status === "error" && (
        <p class="form-error">{source.error ?? "The last pull failed."}</p>
      )}
      {source.maybeMissing > 0 && (
        <p>
          Up to {source.maybeMissing} plays of repeated songs may be missing.
        </p>
      )}
    </>
  );
}

function RemoveSource({ source }: { source: SourceInfo }) {
  return (
    <div class="row">
      <p>Removing it deletes the plays it brought.</p>
      <form method="post" action="/settings/sources/remove" class="inline">
        <input type="hidden" name="id" value={source.id} />
        <button class="btn is-sm is-leave">
          Remove {sourceNames[source.kind] ?? source.kind}
        </button>
      </form>
    </div>
  );
}

function TokenList({ tokens }: { tokens: TokenInfo[] }) {
  if (tokens.length === 0) return null;
  return (
    <ul class="token-list">
      {tokens.map((token) => (
        <li class="row" key={token.id}>
          <span>
            <code class="code-chip">…{token.hint}</code> created{" "}
            {dayText(token.createdAt)} · last used {dayText(token.lastUsedAt)}
          </span>
          <form method="post" action="/settings/tokens/revoke" class="inline">
            <input type="hidden" name="id" value={token.id} />
            <button class="btn is-sm">Revoke</button>
          </form>
        </li>
      ))}
    </ul>
  );
}

function TokenPill({
  tokens,
  issued,
}: {
  tokens: TokenInfo[];
  issued: boolean;
}) {
  if (issued) return <span class="status-pill is-on">Issued just now</span>;
  if (tokens.length === 0) return <span class="status-pill">No token</span>;
  return <span class="status-pill is-on">{tokens.length} active</span>;
}

function IssueToken({ kind }: { kind: string }) {
  return (
    <form method="post" action="/settings/tokens" class="inline">
      <input type="hidden" name="kind" value={kind} />
      <button class="btn is-sm">Issue a new token</button>
    </form>
  );
}

const downloadIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);

interface PageOptions {
  notice?: string;
  error?: string;
  field?: string;
  issuedToken?: string;
  issuedKind?: string;
}

function settingsPage(
  user: SignedInUser,
  sources: SourceInfo[],
  tokens: TokenInfo[],
  logins: Logins,
  options: PageOptions,
  origin: string,
) {
  const { notice, error, field, issuedToken, issuedKind } = options;
  const uploadTokens = tokens.filter((token) => token.kind === "ytmusic");
  const scrobblerTokens = tokens.filter(
    (token) => token.kind === "listenbrainz",
  );
  const spotify = sources.find((item) => item.kind === "spotify");
  const ytmusic = sources.find((item) => item.kind === "ytmusic");
  const phone = sources.find((item) => item.kind === "listenbrainz");
  const cookieConnected = ytmusic !== undefined && ytmusic.hasSecret;
  const issuedHere = (kind: string) =>
    issuedToken !== undefined && (issuedKind ?? "ytmusic") === kind;
  const issued = (kind: string, label: string) =>
    issuedHere(kind) && (
      <>
        <TokenDisplay token={issuedToken as string} label={label} />
        <p class="form-hint">Shown once. Store it now.</p>
      </>
    );
  const fieldError = (name: string) =>
    field === name && error ? (
      <p class="form-error" id={`${name}-error`} role="alert">
        <b>Error:</b> {error}
      </p>
    ) : null;
  const invalid = (name: string) =>
    field === name && error
      ? { "aria-invalid": "true", "aria-describedby": `${name}-error` }
      : {};
  const topError = field === undefined && error !== undefined && (
    <p class="form-error" role="alert">
      <b>Error:</b> {error}
    </p>
  );
  return Page({
    title: "Settings",
    user,
    children: (
      <div class="settings">
        <header class="head">
          <h1>Settings</h1>
          <p class="lead">
            Signed in as <b>{user.name}</b> with{" "}
            {[logins.github && "GitHub", logins.google && "Google"]
              .filter(Boolean)
              .join(" or ")}
            .
          </p>
        </header>
        <nav class="settings-nav" aria-label="Settings">
          <a href="#sources">Sources</a>
          <a href="#account">Account</a>
          <a href="#data">Your data</a>
          <a class="is-danger" href="#delete">
            Delete account
          </a>
          <form class="nav-foot" method="post" action="/settings/sign-out">
            <button class="btn is-sm">Sign out</button>
          </form>
        </nav>
        <div class="settings-col">
          {notice !== undefined && <Notice>{notice}</Notice>}
          {topError}
          <section id="sources">
            <h2>Sources</h2>
            <p class="lead">{sourcesLead(sources)}</p>
            <div class="card">
              <div class="source" id="spotify">
                <header>
                  <h3>Spotify</h3>
                  <StatusPill source={spotify} on="Connected" />
                </header>
                <div class="row">
                  <p>
                    {spotify === undefined
                      ? "Spotify asks you to approve read access to your recently played tracks, then the service pulls them every few minutes."
                      : `Connected as ${spotify.account ?? "your account"}. The service pulls your recently played tracks every few minutes.`}
                  </p>
                  {(spotify === undefined || spotify.status === "error") && (
                    <a class="btn" href="/auth/spotify">
                      {spotify === undefined
                        ? "Connect Spotify"
                        : "Reconnect Spotify"}
                    </a>
                  )}
                </div>
                <SourceProblems source={spotify} />
                {spotify !== undefined && <RemoveSource source={spotify} />}
              </div>
              <div class="source" id="ytmusic">
                <header>
                  <h3>YouTube Music</h3>
                  {cookieConnected ? (
                    <StatusPill source={ytmusic} on="Connected" />
                  ) : (
                    <span class="status-pill">Not connected</span>
                  )}
                </header>
                {cookieConnected && (
                  <div class="row">
                    <p>The service pulls your history page every hour.</p>
                    <form
                      method="post"
                      action="/settings/ytmusic/disconnect"
                      class="inline"
                    >
                      <button class="btn is-sm">Disconnect cookie</button>
                    </form>
                  </div>
                )}
                <SourceProblems source={ytmusic} />
                <form method="post" action="/settings/ytmusic">
                  <div class="split">
                    <div class="form-block">
                      <label class="form-label" for="ytmusic-cookie">
                        Browser cookie
                      </label>
                      <span class="form-hint">
                        It signs the service in the same way it signs your
                        browser in.
                      </span>
                      {fieldError("cookie")}
                      <textarea
                        class="field"
                        id="ytmusic-cookie"
                        name="cookie"
                        placeholder="Paste the whole Cookie header"
                        required
                        spellcheck={false}
                        autocomplete="off"
                        {...invalid("cookie")}
                      />
                    </div>
                    <div class="form-block">
                      <label class="form-label" for="ytmusic-tz">
                        Time zone
                      </label>
                      <span class="form-hint">
                        For “Today” and “Yesterday”.
                      </span>
                      {fieldError("tz")}
                      <select
                        class="field"
                        id="ytmusic-tz"
                        name="tz"
                        data-stored={ytmusic?.tz ?? undefined}
                        {...invalid("tz")}
                      >
                        {timeZones.map((zone) => (
                          <option
                            value={zone}
                            selected={zone === (ytmusic?.tz ?? "UTC")}
                          >
                            {zone}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <details class="disclosure" open={!cookieConnected}>
                    <summary>How to copy the cookie</summary>
                    <ol class="steps">
                      <li>
                        <span>
                          On music.youtube.com, open the developer tools’
                          Network tab.
                        </span>
                      </li>
                      <li>
                        <span>
                          Reload the page and open the history request.
                        </span>
                      </li>
                      <li>
                        <span>
                          Copy the whole Cookie request header and paste it
                          above.
                        </span>
                      </li>
                    </ol>
                  </details>
                  <div>
                    <button class="btn is-primary">
                      {cookieConnected
                        ? "Replace the cookie"
                        : "Connect YouTube Music"}
                    </button>
                  </div>
                </form>
                <script
                  type="module"
                  dangerouslySetInnerHTML={{ __html: tzScript }}
                />
                {ytmusic !== undefined && <RemoveSource source={ytmusic} />}
              </div>
              <div class="source" id="upload">
                <header>
                  <h3>Upload token</h3>
                  <TokenPill
                    tokens={uploadTokens}
                    issued={issuedHere("ytmusic")}
                  />
                </header>
                <p>
                  Pushing plays from a GitHub Action still works and feeds the
                  same source as YouTube Music. Store the token as{" "}
                  <code class="code-chip">UPLOAD_TOKEN</code> in the Action’s
                  secrets.
                </p>
                {issued("ytmusic", "New upload token")}
                <TokenList tokens={uploadTokens} />
                <div>
                  <IssueToken kind="ytmusic" />
                </div>
              </div>
              <div class="source" id="phone">
                <header>
                  <h3>Phone scrobbler</h3>
                  <TokenPill
                    tokens={scrobblerTokens}
                    issued={issuedHere("listenbrainz")}
                  />
                </header>
                <div class="split">
                  <ol class="steps">
                    <li>
                      <span>Install Pano Scrobbler on your Android phone.</span>
                    </li>
                    <li>
                      <span>
                        Add a ListenBrainz account with server{" "}
                        <code class="code-chip">{origin}</code> and this token.
                      </span>
                    </li>
                    <li>
                      <span>
                        Every play your phone reports appears on your profile.
                      </span>
                    </li>
                  </ol>
                  <div class="split-end">
                    <IssueToken kind="listenbrainz" />
                  </div>
                </div>
                {issued("listenbrainz", "New scrobbler token")}
                <TokenList tokens={scrobblerTokens} />
                <SourceProblems source={phone} />
                {phone !== undefined && <RemoveSource source={phone} />}
              </div>
            </div>
          </section>
          <section id="account">
            <h2>Account</h2>
            <div class="card sign-in-methods">
              {(["github", "google"] as const).map((provider) => {
                const login = logins[provider];
                return (
                  <div class="source">
                    <div class="row">
                      <p class="data-note">
                        <b>{providerNames[provider]}</b>
                        <br />
                        {login === null
                          ? "Not linked. Link it to sign in with either."
                          : `Signs you in as ${login}.`}
                      </p>
                      {login === null && (
                        <a
                          class="btn"
                          href={providerHref(provider, "/settings#account")}
                        >
                          Link {providerNames[provider]}
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <form class="card is-pad" method="post" action="/settings/profile">
              <div class="form-block">
                <label class="form-label" for="name">
                  Profile name
                </label>
                <span class="form-hint">
                  Lowercase letters, digits and hyphens, no hyphen at either
                  end. Your page is at /u/&lt;name&gt;.
                </span>
                {fieldError("name")}
                <div class="field-wrap name-field">
                  <span class="prefix">/u/</span>
                  <input
                    class="field"
                    id="name"
                    name="name"
                    type="text"
                    value={user.name}
                    minlength={1}
                    maxlength={39}
                    required
                    spellcheck={false}
                    autocomplete="off"
                    {...invalid("name")}
                  />
                </div>
              </div>
              <label class="check-line" for="is_public">
                <input
                  class="check"
                  id="is_public"
                  name="is_public"
                  type="checkbox"
                  checked={user.isPublic === 1}
                />
                <span>
                  <b>Public profile</b>
                  <span class="form-hint">
                    A hidden profile returns 404 for the page, the JSON and the
                    card. Your plays still feed the playlist of any group you
                    belong to, and you can leave a group any time.
                  </span>
                </span>
              </label>
              <div>
                <button class="btn is-primary">Save profile</button>
              </div>
            </form>
          </section>
          <section id="data">
            <h2>Your data</h2>
            <div class="card">
              <div class="source">
                <div class="row">
                  <p class="data-note">
                    Download your plays as NDJSON, one play per line. Without
                    JavaScript the link returns the first 1,000 plays. The Link
                    header of each page points at the next.
                  </p>
                  <a
                    class="btn"
                    href="/settings/export"
                    id="export-all"
                    data-name={user.name}
                  >
                    {downloadIcon}
                    Download your plays
                  </a>
                </div>
                <p class="form-hint">
                  Your quiz answers are kept so the game can pick better songs.
                </p>
              </div>
            </div>
            <script
              type="module"
              dangerouslySetInnerHTML={{ __html: exportScript }}
            />
          </section>
          <section class="danger-card" id="delete">
            <h2>Delete account</h2>
            <p>
              Deletes every play, source, token and session of this account.
              There is no undo.
            </p>
            <form method="post" action="/settings/delete" class="form-block">
              <label class="form-label" for="confirm">
                Type <code>{user.name}</code> to confirm
              </label>
              {fieldError("confirm")}
              <div class="field-line">
                <input
                  class="field"
                  id="confirm"
                  name="confirm"
                  type="text"
                  data-name={user.name}
                  required
                  spellcheck={false}
                  autocomplete="off"
                  {...invalid("confirm")}
                />
                <button class="btn is-danger is-form" id="delete-account">
                  Delete account
                </button>
              </div>
            </form>
            <script
              type="module"
              dangerouslySetInnerHTML={{ __html: deleteScript }}
            />
          </section>
        </div>
      </div>
    ),
  });
}

// Counted plays: a duplicate stays in plays but in no total.
const countedPlays = (userId: number) =>
  and(eq(t.plays.userId, userId), eq(t.plays.dup, 0));

const playDay = sql<number>`${t.plays.playedAt} / 86400`;

function recountStatements(db: Db, userId: number) {
  return [
    db.delete(t.trackTotals).where(eq(t.trackTotals.userId, userId)),
    db.insert(t.trackTotals).select(
      db
        .select({
          userId: t.plays.userId,
          trackId: t.plays.trackId,
          plays: count().as("plays"),
          lastPlayedAt: sql<number>`max(${t.plays.playedAt})`.as(
            "last_played_at",
          ),
        })
        .from(t.plays)
        .where(countedPlays(userId))
        .groupBy(t.plays.trackId),
    ),
    db.delete(t.dailyTotals).where(eq(t.dailyTotals.userId, userId)),
    db.insert(t.dailyTotals).select(
      db
        .select({
          userId: t.plays.userId,
          day: playDay.as("day"),
          plays: count().as("plays"),
        })
        .from(t.plays)
        .where(countedPlays(userId))
        .groupBy(playDay),
    ),
    db.delete(t.artistTotals).where(eq(t.artistTotals.userId, userId)),
    db.insert(t.artistTotals).select(
      db
        .select({
          userId: t.plays.userId,
          artistId: t.tracks.artistId,
          plays: count().as("plays"),
        })
        .from(t.plays)
        .innerJoin(t.tracks, eq(t.tracks.id, t.plays.trackId))
        .where(countedPlays(userId))
        .groupBy(t.tracks.artistId),
    ),
  ] as const;
}

export function sourceRemovalStatements(
  db: Db,
  userId: number,
  sourceId: number,
) {
  return [
    db
      .delete(t.plays)
      .where(and(eq(t.plays.userId, userId), eq(t.plays.sourceId, sourceId))),
    db.delete(t.tokens).where(eq(t.tokens.sourceId, sourceId)),
    db
      .delete(t.sources)
      .where(and(eq(t.sources.id, sourceId), eq(t.sources.userId, userId))),
    ...recountStatements(db, userId),
  ] as const;
}

const sourcesOf = (db: Db, userId: number) =>
  db
    .select({ id: t.sources.id })
    .from(t.sources)
    .where(eq(t.sources.userId, userId));

export function deletionStatements(db: Db, userId: number) {
  return [
    db.delete(t.plays).where(eq(t.plays.userId, userId)),
    db.delete(t.trackTotals).where(eq(t.trackTotals.userId, userId)),
    db.delete(t.dailyTotals).where(eq(t.dailyTotals.userId, userId)),
    db.delete(t.artistTotals).where(eq(t.artistTotals.userId, userId)),
    db
      .delete(t.tokens)
      .where(inArray(t.tokens.sourceId, sourcesOf(db, userId))),
    db.delete(t.sources).where(eq(t.sources.userId, userId)),
    db.delete(t.sessions).where(eq(t.sessions.userId, userId)),
    db.delete(t.users).where(eq(t.users.id, userId)),
    // The cascade above can empty a group the deleted user did not make.
    db.delete(t.friendGroups).where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(t.groupMembers)
          .where(eq(t.groupMembers.groupId, t.friendGroups.id)),
      ),
    ),
  ] as const;
}

function newUploadToken() {
  return `msu_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

type SettingsContext = Context<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>;

async function pageData(context: SettingsContext) {
  const user = context.get("user");
  const db = database(context.env.DB);
  const [sources, tokens, logins] = await db.batch([
    db
      .select({
        id: t.sources.id,
        kind: t.sources.kind,
        account: t.sources.account,
        status: t.sources.status,
        error: t.sources.error,
        maybeMissing: t.sources.maybeMissing,
        hasSecret: sql<boolean>`${t.sources.secret} IS NOT NULL`.mapWith(
          Boolean,
        ),
        tz: t.sources.tz,
      })
      .from(t.sources)
      .where(eq(t.sources.userId, user.id))
      .orderBy(t.sources.kind, t.sources.id),
    db
      .select({
        id: t.tokens.id,
        hint: t.tokens.hint,
        createdAt: t.tokens.createdAt,
        lastUsedAt: t.tokens.lastUsedAt,
        kind: t.sources.kind,
      })
      .from(t.tokens)
      .innerJoin(t.sources, eq(t.sources.id, t.tokens.sourceId))
      .where(and(eq(t.sources.userId, user.id), isNull(t.tokens.revokedAt)))
      .orderBy(t.tokens.id),
    // The GitHub login and Google address that sign this user in, or null.
    db
      .select({
        github: sql<string | null>`CASE WHEN ${t.users.githubId} > 0
          THEN coalesce(${t.users.githubLogin}, 'id ' || ${t.users.githubId}) END`,
        google: t.users.googleEmail,
      })
      .from(t.users)
      .where(eq(t.users.id, user.id)),
  ]);
  return {
    user,
    sources,
    tokens,
    logins: logins[0] ?? { github: null, google: null },
  };
}

function render(
  context: SettingsContext,
  data: PageData,
  options: PageOptions,
  status: 200 | 400 = 200,
) {
  return context.html(
    settingsPage(
      data.user,
      data.sources,
      data.tokens,
      data.logins,
      options,
      new URL(context.req.url).origin,
    ),
    status,
  );
}

async function form(context: SettingsContext, name: string) {
  const body = await context.req.parseBody();
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

export const settingsApp = new Hono<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>();

settingsApp.use("*", csrf());

settingsApp.use(
  "*",
  memberOnly({
    title: "Settings",
    heading: "Sign in to see your settings",
    body: "Settings connect the services your plays come from and hold your profile name.",
  }),
);

settingsApp.get("/", async (context) => {
  const data = await pageData(context);
  const issued = getCookie(context, "issued-token", "host");
  const issuedKind = getCookie(context, "issued-token-kind", "host");
  if (issued !== undefined) {
    deleteCookie(context, "issued-token", cookieClear);
    deleteCookie(context, "issued-token-kind", cookieClear);
  }
  return render(context, data, {
    issuedToken: issued,
    issuedKind,
  });
});

settingsApp.post("/sign-out", async (context) => {
  await endSession(context);
  deleteCookie(context, "session", cookieClear);
  return context.redirect("/", 303);
});

settingsApp.post("/profile", async (context) => {
  const user = context.get("user");
  const name = await form(context, "name");
  const isPublic = (await context.req.parseBody()).is_public === "on" ? 1 : 0;
  const data = await pageData(context);
  if (!validName(name))
    return render(
      context,
      data,
      {
        error:
          "The name needs 1 to 39 lowercase letters, digits or hyphens, with no hyphen at either end.",
        field: "name",
      },
      400,
    );
  try {
    await database(context.env.DB)
      .update(t.users)
      .set({ name, isPublic })
      .where(eq(t.users.id, user.id));
  } catch {
    return render(
      context,
      data,
      { error: `The name ${name} is taken.`, field: "name" },
      400,
    );
  }
  return context.redirect("/settings", 303);
});

settingsApp.post("/sources/remove", async (context) => {
  const user = context.get("user");
  const id = Number(await form(context, "id"));
  const data = await pageData(context);
  const source = data.sources.find((item) => item.id === id);
  if (source === undefined)
    return render(
      context,
      data,
      { error: "That source is not connected." },
      400,
    );
  const db = database(context.env.DB);
  await db.batch(sourceRemovalStatements(db, user.id, id));
  return context.redirect("/settings", 303);
});

const tokenKinds = ["ytmusic", "listenbrainz"] as const;
type TokenKind = (typeof tokenKinds)[number];
const isTokenKind = (kind: string): kind is TokenKind =>
  (tokenKinds as readonly string[]).includes(kind);

settingsApp.post("/tokens", async (context) => {
  const user = context.get("user");
  const now = Math.floor(Date.now() / 1000);
  const db = database(context.env.DB);
  const kind = await form(context, "kind");
  if (!isTokenKind(kind))
    return render(
      context,
      await pageData(context),
      { error: "Unknown token kind." },
      400,
    );
  const [, [source]] = await db.batch([
    db
      .insert(t.sources)
      .values({ userId: user.id, kind })
      .onConflictDoNothing({ target: [t.sources.userId, t.sources.kind] }),
    db
      .select({ id: t.sources.id })
      .from(t.sources)
      .where(and(eq(t.sources.userId, user.id), eq(t.sources.kind, kind))),
  ]);
  if (source === undefined) throw new Error("could not create the source");
  const token = newUploadToken();
  await db.insert(t.tokens).values({
    sourceId: source.id,
    hash: await sha256Bytes(token),
    hint: token.slice(-4),
    createdAt: now,
  });
  setCookie(context, "issued-token-kind", kind, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: 120,
  });
  setCookie(context, "issued-token", token, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: 120,
  });
  return context.redirect("/settings", 303);
});

settingsApp.post("/tokens/revoke", async (context) => {
  const user = context.get("user");
  const id = Number(await form(context, "id"));
  const now = Math.floor(Date.now() / 1000);
  const db = database(context.env.DB);
  await db
    .update(t.tokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(t.tokens.id, id),
        inArray(t.tokens.sourceId, sourcesOf(db, user.id)),
        isNull(t.tokens.revokedAt),
      ),
    );
  return context.redirect("/settings", 303);
});

const ytmusicOf = (userId: number) =>
  and(eq(t.sources.userId, userId), eq(t.sources.kind, "ytmusic"));

settingsApp.post("/ytmusic", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
  const cookie = await form(context, "cookie");
  const tzInput = (await form(context, "tz")) || "UTC";
  const data = await pageData(context);
  const bad = (error: string, field: string) =>
    render(context, data, { error, field }, 400);
  let tz = tzInput;
  try {
    tz = new Intl.DateTimeFormat("en-US", {
      timeZone: tzInput,
    }).resolvedOptions().timeZone;
  } catch {
    return bad(
      "The time zone is not a known IANA name, for example Europe/Berlin.",
      "tz",
    );
  }
  if (!hasSapisid(cookie))
    return bad(
      "The cookie has no __Secure-3PAPISID. Copy the whole Cookie request header, not one cookie.",
      "cookie",
    );

  let html: string;
  try {
    html = await fetchHistoryPage(cookie);
  } catch {
    return bad(
      "YouTube Music could not be reached. Try again in a moment.",
      "cookie",
    );
  }
  let plays;
  try {
    plays = parseHistoryPage(html, todayIn(Math.floor(Date.now() / 1000), tz));
  } catch (error) {
    if (error instanceof SignedOutError)
      return bad(
        "YouTube Music answered as signed out. Copy the cookie from a signed-in browser session.",
        "cookie",
      );
    if (error instanceof HistoryPageError)
      return bad("The YouTube Music history page did not parse.", "cookie");
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  const secret = await sealSecret(context.env, cookie);
  const [, [source]] = await db.batch([
    db
      .insert(t.sources)
      .values({
        userId: user.id,
        kind: "ytmusic",
        secret,
        tz,
        nextPullAt: now + pullIntervalSeconds,
      })
      .onConflictDoUpdate({
        target: [t.sources.userId, t.sources.kind],
        set: {
          secret: sql`excluded.secret`,
          tz: sql`excluded.tz`,
          nextPullAt: sql`excluded.next_pull_at`,
          error: null,
        },
      }),
    db
      .select({
        id: t.sources.id,
        user_id: t.sources.userId,
        status: t.sources.status,
        last_page: t.sources.lastPage,
        play_seq: t.sources.playSeq,
        gap_at: t.sources.gapAt,
      } satisfies Record<keyof PageSource, unknown>)
      .from(t.sources)
      .where(ytmusicOf(user.id)),
  ]);
  let inserted = 0;
  if (source !== undefined) {
    const result = await ingestPage(
      context.env.DB,
      source,
      plays
        .filter(
          (play) =>
            play.day !== null &&
            play.videoId !== null &&
            [...play.title].length <= 512 &&
            [...play.artist].length <= 512,
        )
        .map((play) => ({
          day: play.day as string,
          artist: play.artist,
          title: play.title,
          video_id: play.videoId as string,
        })),
      { now, pullNextAt: now + pullIntervalSeconds },
    );
    inserted = result.inserted;
  }
  return render(context, await pageData(context), {
    notice: `YouTube Music connected. ${inserted} plays stored.`,
  });
});

settingsApp.post("/ytmusic/disconnect", async (context) => {
  const user = context.get("user");
  await database(context.env.DB)
    .update(t.sources)
    .set({
      secret: null,
      nextPullAt: null,
      error: null,
      status: sql`CASE WHEN ${t.sources.status} = 'error' THEN 'active' ELSE ${t.sources.status} END`,
    })
    .where(ytmusicOf(user.id));
  return context.redirect("/settings", 303);
});

// One page of the export, after a (played_at, source_id, ref) key. The keys
// are the export file's field names; source_id only orders the pages.
function exportPage(db: Db, userId: number, after: [number, number, string]) {
  const [playedAt, sourceId, ref] = after;
  return db
    .select({
      played_at: t.plays.playedAt,
      source_id: t.plays.sourceId,
      source: t.sources.kind,
      ref: t.plays.ref,
      artist: t.artists.name,
      title: t.tracks.title,
    })
    .from(t.plays)
    .innerJoin(t.sources, eq(t.sources.id, t.plays.sourceId))
    .innerJoin(t.tracks, eq(t.tracks.id, t.plays.trackId))
    .innerJoin(t.artists, eq(t.artists.id, t.tracks.artistId))
    .where(
      and(
        eq(t.plays.userId, userId),
        sql`(${t.plays.playedAt}, ${t.plays.sourceId}, ${t.plays.ref}) > (${playedAt}, ${sourceId}, ${ref})`,
      ),
    )
    .orderBy(t.plays.playedAt, t.plays.sourceId, t.plays.ref)
    .limit(exportPageSize);
}

settingsApp.get("/export", async (context) => {
  const user = context.get("user");
  const afterParam = context.req.query("after");
  const parts = afterParam?.split(",") ?? [];
  const after: [number, number, string] =
    parts.length >= 3
      ? [Number(parts[0]), Number(parts[1]), parts.slice(2).join(",")]
      : [0, 0, ""];
  if (
    parts.length >= 3 &&
    (!Number.isFinite(after[0]) || !Number.isFinite(after[1]))
  )
    return context.text("Bad after key", 400);
  const rows = await exportPage(database(context.env.DB), user.id, after);
  const body = rows
    .map((row) => {
      const { source_id: _sourceId, ...line } = row;
      return `${JSON.stringify(line)}\n`;
    })
    .join("");
  const last = rows.at(-1);
  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-disposition": `attachment; filename="${user.name}-plays.ndjson"`,
  };
  if (last !== undefined && rows.length === exportPageSize) {
    const key = `${last.played_at},${last.source_id},${encodeURIComponent(last.ref)}`;
    headers.link = `</settings/export?after=${key}>; rel="next"`;
  }
  return new Response(body, { headers });
});

settingsApp.post("/delete", async (context) => {
  const user = context.get("user");
  const confirm = await form(context, "confirm");
  const data = await pageData(context);
  if (confirm !== user.name)
    return render(
      context,
      data,
      {
        error: `Type ${user.name} to delete the account.`,
        field: "confirm",
      },
      400,
    );
  const db = database(context.env.DB);
  await db.batch(deletionStatements(db, user.id));
  deleteCookie(context, "session", cookieClear);
  return context.redirect("/", 303);
});
