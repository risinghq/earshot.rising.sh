import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import {
  base64url,
  sessionUser,
  signInHref,
  validName,
  type SignedInUser,
} from "../account/auth";
import { and, count, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { database, t, type Db } from "../platform/db";
import { memberOnly } from "../account/sign-in";
import type { Env } from "../env";
import { EmptyState } from "../ui/empty";
import { Notice } from "../ui/notice";
import { Monogram } from "../ui/person";
import { Segmented } from "../ui/segmented";
import { Page } from "../ui/shell";
import { CopyButton, TokenDisplay, TokenField } from "../ui/token";

const pendingLimit = 20;

type FriendRow = Pick<typeof t.users.$inferSelect, "id" | "name" | "isPublic">;

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
  const db = database(context.env.DB);
  const requestsWith = (other: typeof t.friendRequests.fromUser) =>
    db
      .select({ id: t.friendRequests.id, name: t.users.name })
      .from(t.friendRequests)
      .innerJoin(t.users, eq(t.users.id, other))
      .orderBy(t.friendRequests.id);
  // First visit sets the link only if it is still unset, so concurrent
  // visits cannot each mint a different token; the read-back holds the
  // canonical one.
  const [, [stored], friends, incoming, outgoing] = await db.batch([
    db
      .update(t.users)
      .set({
        friendLink: base64url(crypto.getRandomValues(new Uint8Array(24))),
      })
      .where(and(eq(t.users.id, user.id), isNull(t.users.friendLink))),
    db
      .select({ link: t.users.friendLink })
      .from(t.users)
      .where(eq(t.users.id, user.id)),
    db
      .select({
        id: t.users.id,
        name: t.users.name,
        isPublic: t.users.isPublic,
      })
      .from(t.friendships)
      .innerJoin(t.users, eq(t.users.id, t.friendships.friendId))
      .where(eq(t.friendships.userId, user.id))
      .orderBy(t.users.name),
    requestsWith(t.friendRequests.fromUser).where(
      eq(t.friendRequests.toUser, user.id),
    ),
    requestsWith(t.friendRequests.toUser).where(
      eq(t.friendRequests.fromUser, user.id),
    ),
  ]);
  const link = stored?.link;
  if (link === null || link === undefined)
    throw new Error("friend link was not stored");
  return { user, link, friends, incoming, outgoing };
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
  const linkUrl = `${origin}/friends/add/${data.link}`;
  const nameField = (
    <div class="field-wrap">
      <span class="prefix">/u/</span>
      <input
        class="field"
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
  );
  const alone =
    friends.length === 0 && incoming.length === 0 && outgoing.length === 0;
  return Page({
    title: "Friends",
    user,
    nav: "groups",
    children: (
      <div id="friends-body" class="contents">
        <header class="head">
          <div>
            <h1>Friends</h1>
            <p class="lead">
              Friends fill a group together, and the group’s playlist blends
              what each member plays.
            </p>
          </div>
          <PeopleSwitch current="friends" requests={incoming.length} />
        </header>
        {notice !== undefined && <Notice>{notice}</Notice>}
        {topError}
        {alone ? (
          <div class="friends is-alone">
            <div class="empty-card">
              <span class="circles" aria-hidden="true">
                <Monogram name={user.name} />
                <span class="ghost" />
                <span class="ghost" />
              </span>
              <h2>No friends yet</h2>
              <p>
                Send your link. Anyone signed in who opens it can add you in one
                tap.
              </p>
              <TokenField token={linkUrl} label="Your friend link" />
              <CopyButton
                label="Copy your link"
                className="btn is-primary is-lg is-block"
              />
            </div>
            <form
              class="card is-pad"
              method="post"
              action="/friends/request"
              data-inline="friends-body"
            >
              <label class="card-title" for="name">
                Or add by profile name
              </label>
              {fieldError("name")}
              <div class="field-line is-inline">
                {nameField}
                <button class="btn is-form">Send</button>
              </div>
            </form>
          </div>
        ) : (
          <div class="friends">
            <div class="friends-col">
              {incoming.length + outgoing.length > 0 && (
                <section class="people">
                  <header>
                    <h2>Requests</h2>
                  </header>
                  <div class="card">
                    <ul>
                      {incoming.map((request) => (
                        <li class="prow is-request" key={request.id}>
                          <span class="who">
                            <Monogram name={request.name} />
                            <span class="who-text">
                              <span class="name">{request.name}</span>
                              <span class="sub">Wants to be your friend</span>
                            </span>
                          </span>
                          <div class="actions">
                            <form
                              method="post"
                              action="/friends/requests/accept"
                              data-inline="friends-body"
                            >
                              <input
                                type="hidden"
                                name="id"
                                value={request.id}
                              />
                              <button class="btn is-primary">Accept</button>
                            </form>
                            <form
                              method="post"
                              action="/friends/requests/decline"
                              data-inline="friends-body"
                            >
                              <input
                                type="hidden"
                                name="id"
                                value={request.id}
                              />
                              <button class="btn">Decline</button>
                            </form>
                          </div>
                        </li>
                      ))}
                      {outgoing.map((request) => (
                        <li class="prow is-sent" key={request.id}>
                          <span class="who">
                            <Monogram name={request.name} waiting />
                            <span class="who-text">
                              <span class="name">{request.name}</span>
                              <span class="sub">Sent · waiting for them</span>
                            </span>
                          </span>
                          <form
                            method="post"
                            action="/friends/requests/cancel"
                            data-inline="friends-body"
                          >
                            <input type="hidden" name="id" value={request.id} />
                            <button class="btn is-sm">Cancel</button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              )}
              <section class="people">
                <header>
                  <h2>Your friends</h2>
                  <span class="count">{friends.length}</span>
                </header>
                <div class="card">
                  {friends.length === 0 ? (
                    <p class="people-none">
                      No friends yet. Answer a request, send one, or share your
                      link.
                    </p>
                  ) : (
                    <ul>
                      {friends.map((friend) => (
                        <li class="prow" key={friend.id}>
                          <FriendWho friend={friend} />
                          <form
                            method="post"
                            action="/friends/remove"
                            data-inline="friends-body"
                          >
                            <input type="hidden" name="id" value={friend.id} />
                            <button class="btn is-quiet">Remove</button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>
            <div class="friends-col">
              <form
                class="card is-pad"
                method="post"
                action="/friends/request"
                data-inline="friends-body"
              >
                <h2 class="card-title">Add by name</h2>
                <div class="form-block">
                  <label class="form-label" for="name">
                    Profile name
                  </label>
                  <span class="form-hint">
                    The exact name on their profile.
                  </span>
                  {fieldError("name")}
                  <div class="field-line">
                    {nameField}
                    <button class="btn is-primary is-form">
                      Send a request
                    </button>
                  </div>
                </div>
              </form>
              <section class="link-card">
                <h2 class="card-title">Your friend link</h2>
                <p>Anyone signed in who opens it can add you in one tap.</p>
                <TokenDisplay
                  token={linkUrl}
                  label="Your friend link"
                  primary
                />
                <div class="foot">
                  <span>Resetting stops the old link.</span>
                  <form method="post" action="/friends/link/reset">
                    <button class="btn is-sm">Reset link</button>
                  </form>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    ),
  });
}

function FriendWho({ friend }: { friend: FriendRow }) {
  const inner = (
    <>
      <Monogram name={friend.name} />
      <span class="who-text">
        <span class="name">{friend.name}</span>
      </span>
    </>
  );
  return friend.isPublic === 1 ? (
    <a class="who" href={`/u/${encodeURIComponent(friend.name)}`}>
      {inner}
    </a>
  ) : (
    <span class="who">{inner}</span>
  );
}

// Groups and friends share one place in the site nav; this switch moves
// between them and counts the requests that wait for an answer.
export function PeopleSwitch({
  current,
  requests,
}: {
  current: "groups" | "friends";
  requests: number;
}) {
  return (
    <div class="sub-switch">
      <Segmented
        label="Groups and friends"
        options={[
          { label: "Groups", href: "/groups", current: current === "groups" },
          {
            label: "Friends",
            href: "/friends",
            current: current === "friends",
            badge:
              requests > 0 ? (
                <>
                  {requests}
                  <span class="sr-only"> waiting</span>
                </>
              ) : undefined,
          },
        ]}
      />
    </div>
  );
}

export function incomingRequests(db: Db, userId: number) {
  return db
    .select({ count: count() })
    .from(t.friendRequests)
    .where(eq(t.friendRequests.toUser, userId));
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

function findRequest(db: Db, id: number) {
  return db
    .select({
      fromUser: t.friendRequests.fromUser,
      toUser: t.friendRequests.toUser,
    })
    .from(t.friendRequests)
    .where(eq(t.friendRequests.id, id))
    .get();
}

// The request from one user to another, if any.
function requestBetween(db: Db, from: number, to: number) {
  return db
    .select({ id: t.friendRequests.id })
    .from(t.friendRequests)
    .where(
      and(eq(t.friendRequests.fromUser, from), eq(t.friendRequests.toUser, to)),
    )
    .get();
}

// Both directions of a pair: a friendship is mutual, and a row exists for each.
const eitherWay = <A extends SQLiteColumn, B extends SQLiteColumn>(
  one: A,
  other: B,
  a: number,
  b: number,
) => or(and(eq(one, a), eq(other, b)), and(eq(one, b), eq(other, a)));

async function makeFriends(db: Db, a: number, b: number, now: number) {
  // Requests between the pair are spent.
  await db.batch([
    db
      .insert(t.friendships)
      .values([
        { userId: a, friendId: b, createdAt: now },
        { userId: b, friendId: a, createdAt: now },
      ])
      .onConflictDoNothing(),
    db
      .delete(t.friendRequests)
      .where(
        eitherWay(t.friendRequests.fromUser, t.friendRequests.toUser, a, b),
      ),
  ]);
}

export async function isFriend(db: Db, user: number, friend: number) {
  const row = await db
    .select({ friendId: t.friendships.friendId })
    .from(t.friendships)
    .where(
      and(eq(t.friendships.userId, user), eq(t.friendships.friendId, friend)),
    )
    .get();
  return row !== undefined;
}

export const friendsApp = new Hono<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>();

friendsApp.use("*", csrf());

// Registered before the member gate: a signed-out visitor sees whose link it
// is and signs in from the card.
friendsApp.get("/add/:token", addLanding);

friendsApp.use(
  "*",
  memberOnly({
    title: "Friends",
    heading: "Sign in to see your friends",
    body: "Friends fill a group together, and the group's playlist blends what each member plays.",
    nav: "groups",
  }),
);

friendsApp.get("/", async (context) => {
  return render(context, await pageData(context), {});
});

friendsApp.post("/request", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
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
    .select({ id: t.users.id, name: t.users.name })
    .from(t.users)
    .where(sql`${t.users.name} = ${name} COLLATE NOCASE`)
    .get();
  if (target !== undefined && target.id === user.id)
    return fail("That is your own profile.");
  if (target !== undefined) {
    if (await isFriend(db, user.id, target.id))
      return render(context, await pageData(context), {
        notice: `You are already friends with ${target.name}.`,
      });
    if ((await requestBetween(db, target.id, user.id)) !== undefined) {
      await makeFriends(db, user.id, target.id, now);
      return render(context, await pageData(context), {
        notice: `${target.name} had already asked. You are friends now.`,
      });
    }
    // The cap lives inside the insert so two requests cannot both pass a
    // count taken before either wrote. The sender's own row is the one row
    // the insert selects from.
    const sent = await db
      .insert(t.friendRequests)
      .select(
        db
          .select({
            fromUser: t.users.id,
            toUser: sql<number>`${target.id}`.as("to_user"),
            createdAt: sql<number>`${now}`.as("created_at"),
          })
          .from(t.users)
          .where(
            and(
              eq(t.users.id, user.id),
              lt(
                db.$count(
                  t.friendRequests,
                  eq(t.friendRequests.fromUser, user.id),
                ),
                pendingLimit,
              ),
            ),
          ),
      )
      .onConflictDoNothing();
    if (sent.meta.changes === 0) {
      if ((await requestBetween(db, user.id, target.id)) === undefined)
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
  const db = database(context.env.DB);
  const id = Number(await form(context, "id"));
  const request = await findRequest(db, id);
  if (request === undefined || request.toUser !== user.id)
    return render(
      context,
      await pageData(context),
      { error: "That request is not yours to answer." },
      400,
    );
  await makeFriends(
    db,
    user.id,
    request.fromUser,
    Math.floor(Date.now() / 1000),
  );
  return context.redirect(back(context), 303);
});

friendsApp.post("/requests/decline", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
  const id = Number(await form(context, "id"));
  const request = await findRequest(db, id);
  if (request === undefined || request.toUser !== user.id)
    return render(
      context,
      await pageData(context),
      { error: "That request is not yours to answer." },
      400,
    );
  await db.delete(t.friendRequests).where(eq(t.friendRequests.id, id));
  return context.redirect(back(context), 303);
});

friendsApp.post("/requests/cancel", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
  const id = Number(await form(context, "id"));
  const request = await findRequest(db, id);
  if (request === undefined || request.fromUser !== user.id)
    return render(
      context,
      await pageData(context),
      { error: "That request is not yours to cancel." },
      400,
    );
  await db.delete(t.friendRequests).where(eq(t.friendRequests.id, id));
  return context.redirect(back(context), 303);
});

friendsApp.post("/remove", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
  const id = Number(await form(context, "id"));
  if (!(await isFriend(db, user.id, id)))
    return render(
      context,
      await pageData(context),
      { error: "You are not friends." },
      400,
    );
  await db
    .delete(t.friendships)
    .where(
      eitherWay(t.friendships.userId, t.friendships.friendId, user.id, id),
    );
  return context.redirect("/friends", 303);
});

friendsApp.post("/link/reset", async (context) => {
  const user = context.get("user");
  await database(context.env.DB)
    .update(t.users)
    .set({ friendLink: base64url(crypto.getRandomValues(new Uint8Array(24))) })
    .where(eq(t.users.id, user.id));
  return context.redirect("/friends", 303);
});

function linkPage(
  user: SignedInUser | null,
  children: Parameters<typeof Page>[0]["children"],
) {
  return Page({
    title: "Friend link",
    user,
    nav: "groups",
    children: <div class="signed-out">{children}</div>,
  });
}

async function linkOwner(context: FriendsContext) {
  const token = context.req.param("token");
  if (token === undefined) return undefined;
  return database(context.env.DB)
    .select({ id: t.users.id, name: t.users.name })
    .from(t.users)
    .where(eq(t.users.friendLink, token))
    .get();
}

function deadLink(context: FriendsContext, user: SignedInUser | null) {
  return context.html(
    linkPage(
      user,
      <EmptyState
        heading="h1"
        title="This friend link does not work"
        body="It was reset or never existed. Ask for a fresh one."
        action={user ? { href: "/friends", label: "Your friends" } : undefined}
      />,
    ),
    404,
  );
}

async function addLanding(context: FriendsContext) {
  const user = await sessionUser(context);
  const owner = await linkOwner(context);
  if (owner === undefined) return deadLink(context, user);
  if (user !== null && owner.id === user.id)
    return context.html(
      linkPage(
        user,
        <EmptyState
          heading="h1"
          title="This is your own friend link"
          body="Share it with someone signed in to Earshot. Opening it lets them add you in one tap."
          action={{ href: "/friends", label: "Your friends" }}
        />,
      ),
    );
  if (
    user !== null &&
    (await isFriend(database(context.env.DB), user.id, owner.id))
  )
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
      <section class="landing">
        <Monogram name={owner.name} />
        <p class="kicker">Friend link</p>
        <h1>Add {owner.name} as a friend?</h1>
        <p>
          Then you can be in a group together, and the group’s playlist blends
          what you both play.
        </p>
        {user === null ? (
          <a class="btn is-primary" href={signInHref(context.req.path)}>
            Sign in to add {owner.name}
          </a>
        ) : (
          <form method="post" action={context.req.path}>
            <button class="btn is-primary">Add {owner.name}</button>
          </form>
        )}
      </section>,
    ),
  );
}

friendsApp.post("/add/:token", async (context) => {
  const user = context.get("user");
  const owner = await linkOwner(context);
  if (owner === undefined) return deadLink(context, user);
  if (owner.id !== user.id)
    await makeFriends(
      database(context.env.DB),
      user.id,
      owner.id,
      Math.floor(Date.now() / 1000),
    );
  return context.redirect("/friends", 303);
});
