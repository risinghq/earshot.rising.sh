import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { base64url, validName, type SignedInUser } from "./auth";
import { memberOnly } from "./sign-in";
import type { Env } from "./types";
import { EmptyState } from "./ui/empty";
import { Notice } from "./ui/notice";
import { PillButton } from "./ui/pill";
import { Section } from "./ui/section";
import { Page } from "./ui/shell";
import { TokenDisplay } from "./ui/token";

const pendingLimit = 20;

interface FriendRow {
  id: number;
  name: string;
  is_public: number;
}

interface RequestRow {
  id: number;
  name: string;
}

interface PageData {
  user: SignedInUser;
  link: string;
  friends: FriendRow[];
  incoming: RequestRow[];
  outgoing: RequestRow[];
}

interface PageOptions {
  notice?: string;
  error?: string;
  field?: string;
}

type FriendsContext = Context<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>;

async function pageData(context: FriendsContext): Promise<PageData> {
  const user = context.get("user");
  const db = context.env.DB;
  // First visit sets the link only if it is still unset, so concurrent
  // visits cannot each mint a different token; the read-back holds the
  // canonical one.
  await db
    .prepare(
      "UPDATE users SET friend_link = ?1 WHERE id = ?2 AND friend_link IS NULL",
    )
    .bind(base64url(crypto.getRandomValues(new Uint8Array(24))), user.id)
    .run();
  const link = (
    await db
      .prepare("SELECT friend_link FROM users WHERE id = ?1")
      .bind(user.id)
      .first<{ friend_link: string | null }>()
  )?.friend_link;
  if (link === null || link === undefined)
    throw new Error("friend link was not stored");
  const [friends, incoming, outgoing] = await db.batch([
    db
      .prepare(
        `SELECT users.id, users.name, users.is_public
         FROM friendships JOIN users ON users.id = friendships.friend_id
         WHERE friendships.user_id = ?1 ORDER BY users.name`,
      )
      .bind(user.id),
    db
      .prepare(
        `SELECT friend_requests.id, users.name
         FROM friend_requests JOIN users ON users.id = friend_requests.from_user
         WHERE friend_requests.to_user = ?1 ORDER BY friend_requests.id`,
      )
      .bind(user.id),
    db
      .prepare(
        `SELECT friend_requests.id, users.name
         FROM friend_requests JOIN users ON users.id = friend_requests.to_user
         WHERE friend_requests.from_user = ?1 ORDER BY friend_requests.id`,
      )
      .bind(user.id),
  ]);
  return {
    user,
    link,
    friends: friends.results as unknown as FriendRow[],
    incoming: incoming.results as unknown as RequestRow[],
    outgoing: outgoing.results as unknown as RequestRow[],
  };
}

function friendsPage(data: PageData, options: PageOptions, origin: string) {
  const { user, friends, incoming, outgoing } = data;
  const { notice, error, field } = options;
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
  const friendName = (friend: FriendRow) =>
    friend.is_public === 1 ? (
      <a href={`/u/${encodeURIComponent(friend.name)}`}>{friend.name}</a>
    ) : (
      friend.name
    );
  return Page({
    title: "Friends",
    user,
    children: (
      <>
        <div class="page-head">
          <h1>Friends</h1>
          <p>
            Friends fill a group together, and the group's playlist blends what
            each member plays.
          </p>
        </div>
        {notice !== undefined && <Notice>{notice}</Notice>}
        {topError}
        <div class="duo">
          <div class="stack">
            <Section title="Friends" aside={`${friends.length}`}>
              {friends.length === 0 ? (
                <p class="muted">
                  No friends yet. Send a request below, or share your friend
                  link.
                </p>
              ) : (
                <ul class="rows">
                  {friends.map((friend) => (
                    <li key={friend.id}>
                      <span class="track">
                        <b>{friendName(friend)}</b>
                      </span>
                      <form method="post" action="/friends/remove">
                        <input type="hidden" name="id" value={friend.id} />
                        <PillButton small>Remove</PillButton>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Requests">
              {incoming.length === 0 && outgoing.length === 0 ? (
                <p class="muted">No pending requests.</p>
              ) : (
                <ul class="rows">
                  {incoming.map((request) => (
                    <li key={request.id}>
                      <span class="track">
                        <b>{request.name}</b>
                        <small>asked to be your friend</small>
                      </span>
                      <form method="post" action="/friends/requests/accept">
                        <input type="hidden" name="id" value={request.id} />
                        <PillButton small variant="primary">
                          Accept
                        </PillButton>
                      </form>
                      <form method="post" action="/friends/requests/decline">
                        <input type="hidden" name="id" value={request.id} />
                        <PillButton small>Decline</PillButton>
                      </form>
                    </li>
                  ))}
                  {outgoing.map((request) => (
                    <li key={request.id}>
                      <span class="track">
                        <b>{request.name}</b>
                        <small>waiting for them</small>
                      </span>
                      <form method="post" action="/friends/requests/cancel">
                        <input type="hidden" name="id" value={request.id} />
                        <PillButton small>Cancel</PillButton>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
          <div class="stack">
            <Section title="Add by name">
              <form method="post" action="/friends/request" class="stack">
                <div class="field">
                  <label for="name">Profile name</label>
                  <small>The exact name on their profile.</small>
                  {fieldError("name")}
                  <input
                    id="name"
                    name="name"
                    type="text"
                    maxlength={39}
                    required
                    spellcheck={false}
                    autocomplete="off"
                    {...invalid("name")}
                  />
                </div>
                <div>
                  <PillButton variant="primary">Send a request</PillButton>
                </div>
              </form>
            </Section>
            <Section title="Friend link">
              <p class="muted">
                A signed-in visitor who opens your link becomes your friend at
                once.
              </p>
              <TokenDisplay token={`${origin}/friends/add/${data.link}`} />
              <div>
                <form method="post" action="/friends/link/reset">
                  <PillButton small>Reset the link</PillButton>
                </form>
              </div>
              <small class="hint">Resetting stops the old link.</small>
            </Section>
          </div>
        </div>
      </>
    ),
  });
}

function render(
  context: FriendsContext,
  data: PageData,
  options: PageOptions,
  status: 200 | 400 = 200,
) {
  return context.html(
    friendsPage(data, options, new URL(context.req.url).origin),
    status,
  );
}

async function form(context: FriendsContext, name: string) {
  const body = await context.req.parseBody();
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

function back(context: FriendsContext) {
  const referrer = context.req.header("referer");
  if (referrer === undefined) return "/friends";
  try {
    const url = new URL(referrer);
    return url.origin === new URL(context.req.url).origin
      ? `${url.pathname}${url.search}`
      : "/friends";
  } catch {
    return "/friends";
  }
}

async function findRequest(db: D1Database, id: number) {
  return db
    .prepare("SELECT id, from_user, to_user FROM friend_requests WHERE id = ?1")
    .bind(id)
    .first<{ id: number; from_user: number; to_user: number }>();
}

async function makeFriends(db: D1Database, a: number, b: number, now: number) {
  // A friendship is mutual, so each direction gets a row; requests between
  // the pair are spent.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at)
         VALUES (?1, ?2, ?3)`,
      )
      .bind(a, b, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at)
         VALUES (?1, ?2, ?3)`,
      )
      .bind(b, a, now),
    db
      .prepare(
        `DELETE FROM friend_requests
         WHERE (from_user = ?1 AND to_user = ?2)
            OR (from_user = ?2 AND to_user = ?1)`,
      )
      .bind(a, b),
  ]);
}

async function isFriend(db: D1Database, user: number, friend: number) {
  return (
    (await db
      .prepare(
        "SELECT 1 AS yes FROM friendships WHERE user_id = ?1 AND friend_id = ?2",
      )
      .bind(user, friend)
      .first()) !== null
  );
}

export const friendsApp = new Hono<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>();

friendsApp.use("*", csrf());

friendsApp.use(
  "*",
  memberOnly(
    "Friends",
    "Friends fill a group together, and the group's playlist blends what each member plays. Sign in to see yours.",
  ),
);

friendsApp.get("/", async (context) => {
  return render(context, await pageData(context), {});
});

friendsApp.post("/request", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const name = await form(context, "name");
  const body = await context.req.parseBody();
  const next =
    typeof body.next === "string" &&
    body.next.startsWith("/") &&
    !body.next.startsWith("//")
      ? body.next
      : "/friends";
  const fail = async (error: string) =>
    render(context, await pageData(context), { error, field: "name" }, 400);
  if (!validName(name))
    return fail(
      "The name needs 1 to 39 lowercase letters, digits or hyphens, with no hyphen at either end.",
    );
  const target = await db
    .prepare("SELECT id, name FROM users WHERE name = ?1 COLLATE NOCASE")
    .bind(name)
    .first<{ id: number; name: string }>();
  if (target !== null && target.id === user.id)
    return fail("That is your own profile.");
  if (target !== null) {
    if (await isFriend(db, user.id, target.id))
      return render(context, await pageData(context), {
        notice: `You are already friends with ${target.name}.`,
      });
    const asked = await db
      .prepare(
        `SELECT id FROM friend_requests
         WHERE from_user = ?1 AND to_user = ?2`,
      )
      .bind(target.id, user.id)
      .first();
    if (asked !== null) {
      await makeFriends(db, user.id, target.id, now);
      return render(context, await pageData(context), {
        notice: `${target.name} had already asked. You are friends now.`,
      });
    }
    // The cap lives inside the insert so two requests cannot both pass a
    // count taken before either wrote.
    const sent = await db
      .prepare(
        `INSERT OR IGNORE INTO friend_requests
           (from_user, to_user, created_at)
         SELECT ?1, ?2, ?3
         WHERE (SELECT COUNT(*) FROM friend_requests
                WHERE from_user = ?1) < ?4`,
      )
      .bind(user.id, target.id, now, pendingLimit)
      .run();
    if (sent.meta.changes === 0) {
      const already = await db
        .prepare(
          `SELECT id FROM friend_requests
           WHERE from_user = ?1 AND to_user = ?2`,
        )
        .bind(user.id, target.id)
        .first();
      if (already === null)
        return render(
          context,
          await pageData(context),
          {
            error: `You have ${pendingLimit} requests waiting. Cancel one before sending another.`,
          },
          400,
        );
    }
  }
  // Missing and hidden profiles get the same answer, so a name cannot be
  // probed for an account.
  return next === "/friends"
    ? render(context, await pageData(context), {
        notice: `Request sent to ${target?.name ?? name}.`,
      })
    : context.redirect(next, 303);
});

friendsApp.post("/requests/accept", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const id = Number(await form(context, "id"));
  const request = await findRequest(db, id);
  if (request === null || request.to_user !== user.id)
    return render(
      context,
      await pageData(context),
      { error: "That request is not yours to answer." },
      400,
    );
  await makeFriends(
    db,
    user.id,
    request.from_user,
    Math.floor(Date.now() / 1000),
  );
  return context.redirect(back(context), 303);
});

friendsApp.post("/requests/decline", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const id = Number(await form(context, "id"));
  const request = await findRequest(db, id);
  if (request === null || request.to_user !== user.id)
    return render(
      context,
      await pageData(context),
      { error: "That request is not yours to answer." },
      400,
    );
  await db.prepare("DELETE FROM friend_requests WHERE id = ?1").bind(id).run();
  return context.redirect(back(context), 303);
});

friendsApp.post("/requests/cancel", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const id = Number(await form(context, "id"));
  const request = await findRequest(db, id);
  if (request === null || request.from_user !== user.id)
    return render(
      context,
      await pageData(context),
      { error: "That request is not yours to cancel." },
      400,
    );
  await db.prepare("DELETE FROM friend_requests WHERE id = ?1").bind(id).run();
  return context.redirect(back(context), 303);
});

friendsApp.post("/remove", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const id = Number(await form(context, "id"));
  if (!(await isFriend(db, user.id, id)))
    return render(
      context,
      await pageData(context),
      { error: "You are not friends." },
      400,
    );
  await db.batch([
    db
      .prepare("DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2")
      .bind(user.id, id),
    db
      .prepare("DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2")
      .bind(id, user.id),
  ]);
  return context.redirect("/friends", 303);
});

friendsApp.post("/link/reset", async (context) => {
  const user = context.get("user");
  const link = base64url(crypto.getRandomValues(new Uint8Array(24)));
  await context.env.DB.prepare(
    "UPDATE users SET friend_link = ?1 WHERE id = ?2",
  )
    .bind(link, user.id)
    .run();
  return context.redirect("/friends", 303);
});

function linkPage(
  user: SignedInUser,
  children: Parameters<typeof Page>[0]["children"],
) {
  return Page({ title: "Friend link", user, children });
}

async function linkOwner(context: FriendsContext) {
  const token = context.req.param("token");
  return context.env.DB.prepare(
    "SELECT id, name FROM users WHERE friend_link = ?1",
  )
    .bind(token)
    .first<{ id: number; name: string }>();
}

function deadLink(context: FriendsContext) {
  const user = context.get("user");
  return context.html(
    linkPage(
      user,
      <EmptyState
        heading="h1"
        title="This friend link does not work"
        body="It was reset or never existed. Ask for a fresh one."
        action={{ href: "/friends", label: "Your friends" }}
      />,
    ),
    404,
  );
}

friendsApp.get("/add/:token", async (context) => {
  const user = context.get("user");
  const owner = await linkOwner(context);
  if (owner === null) return deadLink(context);
  if (owner.id === user.id)
    return context.html(
      linkPage(
        user,
        <EmptyState
          heading="h1"
          title="This is your own friend link"
          body="Share it with someone signed in to Earshot; opening it makes you friends."
          action={{ href: "/friends", label: "Your friends" }}
        />,
      ),
    );
  if (await isFriend(context.env.DB, user.id, owner.id))
    return context.html(
      linkPage(
        user,
        <EmptyState
          heading="h1"
          title={`You and ${owner.name} are already friends`}
          action={{ href: "/friends", label: "Your friends" }}
        />,
      ),
    );
  return context.html(
    linkPage(
      user,
      <>
        <div class="page-head">
          <h1>Add a friend</h1>
          <p>
            This link belongs to <b>{owner.name}</b>. Friends can add each other
            to groups, and you can remove a friend any time.
          </p>
        </div>
        <form method="post" action={context.req.path}>
          <PillButton variant="primary">Add {owner.name}</PillButton>
        </form>
      </>,
    ),
  );
});

friendsApp.post("/add/:token", async (context) => {
  const user = context.get("user");
  const owner = await linkOwner(context);
  if (owner === null) return deadLink(context);
  if (owner.id !== user.id)
    await makeFriends(
      context.env.DB,
      user.id,
      owner.id,
      Math.floor(Date.now() / 1000),
    );
  return context.redirect("/friends", 303);
});
