import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import {
  and,
  eq,
  inArray,
  max,
  notExists,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { SignedInUser } from "../account/auth";
import { database, t, type Db } from "../platform/db";
import { incomingRequests, isFriend, PeopleSwitch } from "./friends";
import { groupPlaylist } from "./blend";
import { youtubePlaylistUrl, type PartyTrack } from "./party-blend";
import { memberOnly } from "../account/sign-in";
import type { Env } from "../env";
import { EmptyState } from "../ui/empty";
import { Notice } from "../ui/notice";
import {
  BackLink,
  Cover,
  Monogram,
  MonoStack,
  Mosaic,
  playIcon,
} from "../ui/person";
import { Page } from "../ui/shell";

const nameLength = 60;
const stackSize = 3;
const foldRows = 8;

const memberFields = {
  id: t.users.id,
  name: t.users.name,
  isPublic: t.users.isPublic,
};

type Member = Pick<typeof t.users.$inferSelect, keyof typeof memberFields>;

const groupFields = {
  id: t.friendGroups.id,
  name: t.friendGroups.name,
  creatorId: t.friendGroups.creatorId,
};

type Group = Pick<typeof t.friendGroups.$inferSelect, keyof typeof groupFields>;

interface GroupCard extends Group {
  names: string[];
}

type GroupsContext = Context<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>;

// A group the user is not in answers the same as a group that does not exist.
function membership(db: Db, groupId: number, userId: number) {
  return db
    .select(groupFields)
    .from(t.friendGroups)
    .innerJoin(
      t.groupMembers,
      and(
        eq(t.groupMembers.groupId, t.friendGroups.id),
        eq(t.groupMembers.userId, userId),
      ),
    )
    .where(eq(t.friendGroups.id, groupId))
    .get();
}

const groupSeed = (group: Group) => group.name;

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const chevronRight = (
  <svg class="chev" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 5l7 7-7 7" />
  </svg>
);

function ErrorLine({ error }: { error?: string }) {
  return error === undefined ? null : (
    <p class="form-error" role="alert">
      <b>Error:</b> {error}
    </p>
  );
}

function GroupList({ groups }: { groups: GroupCard[] }) {
  if (groups.length === 0)
    return (
      <div class="card">
        <p class="people-none">
          No groups yet. Make one, then add friends to it.
        </p>
      </div>
    );
  return (
    <ul class="group-cards">
      {groups.map((group) => (
        <li key={group.id}>
          <a class="group-card" href={`/groups/${group.id}`}>
            <Mosaic seed={groupSeed(group)} />
            <span class="body">
              <span class="name">{group.name}</span>
              <span class="members">
                <MonoStack names={group.names.slice(0, stackSize)} />
                {count(group.names.length, "member", "members")}
              </span>
            </span>
            {chevronRight}
          </a>
        </li>
      ))}
    </ul>
  );
}

function NewGroup({ friends, error }: { friends: Member[]; error?: string }) {
  return (
    <form class="card is-pad new-group" method="post" action="/groups">
      <h2 class="card-title">New group</h2>
      <ErrorLine error={error} />
      <div class="form-block">
        <label class="form-label" for="name">
          Name
        </label>
        <input
          class="field"
          id="name"
          name="name"
          type="text"
          maxlength={nameLength}
          required
          spellcheck={false}
          autocomplete="off"
        />
      </div>
      <div class="form-block" role="group" aria-labelledby="pick-label">
        <span class="form-label" id="pick-label">
          Add friends
        </span>
        {friends.length === 0 ? (
          <span class="form-hint">
            Add friends on the <a href="/friends">Friends</a> page to bring them
            in.
          </span>
        ) : (
          <div class="pick-list">
            {friends.map((friend) => (
              <label class="pick-row" key={friend.id}>
                <Monogram name={friend.name} />
                <span class="name">{friend.name}</span>
                <input
                  class="check"
                  type="checkbox"
                  name="member"
                  value={friend.id}
                />
              </label>
            ))}
          </div>
        )}
      </div>
      <button class="btn is-primary is-lg is-block">Make the group</button>
    </form>
  );
}

function listPage(
  user: SignedInUser,
  data: { groups: GroupCard[]; friends: Member[]; requests: number },
  options: { error?: string },
) {
  return Page({
    title: "Groups",
    user,
    nav: "groups",
    children: (
      <>
        <header class="head">
          <div>
            <h1>Groups</h1>
            <p class="lead">
              A group blends what its members play into one playlist that opens
              on YouTube.
            </p>
          </div>
          <PeopleSwitch current="groups" requests={data.requests} />
        </header>
        <div class="groups">
          <GroupList groups={data.groups} />
          <NewGroup friends={data.friends} error={options.error} />
        </div>
      </>
    ),
  });
}

interface GroupPageData {
  group: Group;
  members: Member[];
  friends: Member[];
  items: PartyTrack[];
  mine: boolean;
}

function MemberWho({ member }: { member: Member }) {
  const inner = (
    <>
      <Monogram name={member.name} />
      <span class="who-text">
        <span class="name">{member.name}</span>
      </span>
    </>
  );
  return member.isPublic === 1 ? (
    <a class="who" href={`/u/${encodeURIComponent(member.name)}`}>
      {inner}
    </a>
  ) : (
    <span class="who">{inner}</span>
  );
}

function missingNote(items: PartyTrack[]) {
  const missing = items.filter((item) => item.videoId === null).length;
  if (missing === items.length)
    return "None of these tracks has a YouTube link yet.";
  if (missing === 0) return "Every track opens on YouTube.";
  return `${missing} of ${items.length} tracks have no YouTube link and are skipped.`;
}

function GroupHero({ data }: { data: GroupPageData }) {
  const { group, members, items } = data;
  const url = youtubePlaylistUrl(items);
  const sub = `${count(members.length, "member", "members")} · ${count(items.length, "track", "tracks")}`;
  const play = (
    <>
      {playIcon}
      Play on YouTube
    </>
  );
  return (
    <section
      class={
        items.length === 0
          ? "hero-stage is-group is-empty"
          : "hero-stage is-group"
      }
    >
      {items.length === 0 ? (
        <span class="mosaic is-empty" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Mosaic seed={groupSeed(group)} />
      )}
      <div class="hero-text">
        <p class="kicker">Group blend</p>
        <h1 class="hero-title">{group.name}</h1>
        <p class="hero-sub with-stack">
          <MonoStack names={members.slice(0, stackSize).map((m) => m.name)} />
          <span>{sub}</span>
        </p>
      </div>
      <div class="hero-foot">
        {items.length === 0 && (
          <div class="hero-empty">
            <h2>Nothing to blend yet</h2>
            <p>
              Nobody in this group has any plays yet. When someone connects a
              source in Settings, their plays show up here.
            </p>
          </div>
        )}
        {url === null ? (
          <button class="btn is-primary is-play" type="button" disabled>
            {play}
          </button>
        ) : (
          <a
            class="btn is-primary is-play"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {play}
          </a>
        )}
        {items.length > 0 && <p class="hero-note">{missingNote(items)}</p>}
      </div>
    </section>
  );
}

function PlaylistCard({ items }: { items: PartyTrack[] }) {
  return (
    <section class="top-card playlist-card" id="playlist" data-fold>
      <header>
        <h2>Playlist</h2>
        <span class="count">{count(items.length, "track", "tracks")}</span>
      </header>
      <ol>
        {items.map((item, index) => (
          <li
            class={item.videoId === null ? "trow is-missing" : "trow"}
            key={item.trackId}
          >
            <span class="rank">{index + 1}</span>
            <Cover seed={`${item.title} ${item.artist}`} src={item.image} />
            <div class="body">
              <span class="title">{item.title}</span>
              <span class="artist">{item.artist}</span>
            </div>
            <span class="art">{item.artist}</span>
            {item.videoId === null ? (
              <span class="tag">No YouTube link</span>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ol>
      {items.length > foldRows && (
        <button class="show-all" id="show-all" type="button" data-unfold hidden>
          Show all {items.length}
        </button>
      )}
    </section>
  );
}

function ManageGroup({ data, error }: { data: GroupPageData; error?: string }) {
  const { group, friends, mine } = data;
  return (
    <details class="disclosure manage" id="manage" open={error !== undefined}>
      <summary>Manage group</summary>
      <div class="manage-body">
        <ErrorLine error={error} />
        {friends.length > 0 && (
          <form
            class="form-block"
            method="post"
            action={`/groups/${group.id}/members`}
          >
            <label class="form-label" for="add-member">
              Add one of your friends
            </label>
            <div class="field-line is-inline">
              <select class="field" id="add-member" name="user">
                {friends.map((friend) => (
                  <option value={friend.id} key={friend.id}>
                    {friend.name}
                  </option>
                ))}
              </select>
              <button class="btn is-form">Add</button>
            </div>
          </form>
        )}
        {mine && (
          <form
            class="form-block"
            method="post"
            action={`/groups/${group.id}/rename`}
          >
            <label class="form-label" for="name">
              Group name
            </label>
            <div class="field-line is-inline">
              <input
                class="field"
                id="name"
                name="name"
                type="text"
                value={group.name}
                maxlength={nameLength}
                required
                spellcheck={false}
                autocomplete="off"
              />
              <button class="btn is-form">Rename</button>
            </div>
          </form>
        )}
        <form
          class="leave-row"
          method="post"
          action={`/groups/${group.id}/leave`}
        >
          <span class="is-wide">Your plays stop feeding this blend.</span>
          <button class="btn is-leave">Leave the group</button>
        </form>
      </div>
    </details>
  );
}

function groupPage(
  user: SignedInUser,
  data: GroupPageData,
  options: { notice?: string; error?: string },
) {
  const { group, members, items } = data;
  return Page({
    title: group.name,
    user,
    nav: "groups",
    children: (
      <div class="board is-group">
        <div class="board-main">
          <BackLink href="/groups" label="Groups" />
          {options.notice !== undefined && <Notice>{options.notice}</Notice>}
          <GroupHero data={data} />
          {items.length === 0 ? (
            <a class="btn is-lg is-block" href="/settings#sources">
              Connect a source
            </a>
          ) : (
            <PlaylistCard items={items} />
          )}
        </div>
        <section class="people group-side">
          <header>
            <h2>Members</h2>
          </header>
          <div class="card">
            <ul>
              {members.map((member) => (
                <li class="prow" key={member.id}>
                  <MemberWho member={member} />
                  {member.id === group.creatorId && (
                    <span class="tag">Made the group</span>
                  )}
                </li>
              ))}
            </ul>
            <ManageGroup data={data} error={options.error} />
          </div>
        </section>
      </div>
    ),
  });
}

function missing(context: GroupsContext) {
  const user = context.get("user");
  return context.html(
    Page({
      title: "Group",
      user,
      nav: "groups",
      children: (
        <EmptyState
          heading="h1"
          title="Group not found"
          body="The group does not exist, or you are not a member."
          action={{ href: "/groups", label: "Your groups" }}
        />
      ),
    }),
    404,
  );
}

function readName(body: Record<string, unknown>) {
  const value = body.name;
  return typeof value === "string" ? value.trim() : "";
}

export const groupsApp = new Hono<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>();

groupsApp.use("*", csrf());

groupsApp.use(
  "*",
  memberOnly({
    title: "Groups",
    heading: "Sign in to see your groups",
    body: "A group blends what its members play into one playlist.",
    nav: "groups",
  }),
);

async function listData(context: GroupsContext) {
  const user = context.get("user");
  const db = database(context.env.DB);
  const mine = alias(t.groupMembers, "mine");
  const [groups, names, friends, [requests]] = await db.batch([
    db
      .select(groupFields)
      .from(t.groupMembers)
      .innerJoin(t.friendGroups, eq(t.friendGroups.id, t.groupMembers.groupId))
      .where(eq(t.groupMembers.userId, user.id))
      .orderBy(t.friendGroups.name),
    db
      .select({ groupId: t.groupMembers.groupId, name: t.users.name })
      .from(mine)
      .innerJoin(t.groupMembers, eq(t.groupMembers.groupId, mine.groupId))
      .innerJoin(t.users, eq(t.users.id, t.groupMembers.userId))
      .where(eq(mine.userId, user.id))
      .orderBy(t.users.name),
    friendsOf(db, user.id),
    incomingRequests(db, user.id),
  ]);
  const byGroup = new Map<number, string[]>();
  for (const row of names)
    byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row.name]);
  return {
    groups: groups.map((group) => ({
      ...group,
      names: byGroup.get(group.id) ?? [],
    })),
    friends,
    requests: requests?.count ?? 0,
  };
}

function friendsOf(db: Db, userId: number, also?: SQL) {
  return db
    .select(memberFields)
    .from(t.friendships)
    .innerJoin(t.users, eq(t.users.id, t.friendships.friendId))
    .where(and(eq(t.friendships.userId, userId), also))
    .orderBy(t.users.name);
}

groupsApp.get("/", async (context) => {
  const user = context.get("user");
  return context.html(listPage(user, await listData(context), {}));
});

groupsApp.post("/", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
  const now = Math.floor(Date.now() / 1000);
  const body = await context.req.parseBody();
  const name = readName(body);
  if ([...name].length === 0 || [...name].length > nameLength) {
    return context.html(
      listPage(user, await listData(context), {
        error: "The name needs 1 to 60 characters.",
      }),
      400,
    );
  }
  const raw = body.member;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const picks = [...new Set(values.map((value) => Number(value)))];
  if (picks.some((pick) => !Number.isInteger(pick)))
    return context.text("Forbidden", 403);
  if (picks.length > 0) {
    const found = await db.$count(
      t.friendships,
      and(
        eq(t.friendships.userId, user.id),
        inArray(t.friendships.friendId, picks),
      ),
    );
    if (found !== picks.length) return context.text("Forbidden", 403);
  }
  // The batch is one transaction, so the creator's newest group is the one
  // its first statement inserted.
  const newest = db
    .select({ id: max(t.friendGroups.id) })
    .from(t.friendGroups)
    .where(eq(t.friendGroups.creatorId, user.id));
  const [[group]] = await db.batch([
    db
      .insert(t.friendGroups)
      .values({ name, creatorId: user.id, createdAt: now })
      .returning({ id: t.friendGroups.id }),
    db.insert(t.groupMembers).select(
      db
        .select({
          groupId: sql<number>`(${newest})`.as("group_id"),
          userId: t.users.id,
          createdAt: sql<number>`${now}`.as("created_at"),
        })
        .from(t.users)
        .where(inArray(t.users.id, [user.id, ...picks])),
    ),
  ]);
  if (group === undefined) throw new Error("could not create the group");
  return context.redirect(`/groups/${group.id}`, 303);
});

async function groupData(
  context: GroupsContext,
  group: Group,
): Promise<GroupPageData> {
  const user = context.get("user");
  const db = database(context.env.DB);
  const [members, friends] = await db.batch([
    db
      .select(memberFields)
      .from(t.groupMembers)
      .innerJoin(t.users, eq(t.users.id, t.groupMembers.userId))
      .where(eq(t.groupMembers.groupId, group.id))
      .orderBy(t.users.name),
    friendsOf(
      db,
      user.id,
      notInArray(
        t.users.id,
        db
          .select({ userId: t.groupMembers.userId })
          .from(t.groupMembers)
          .where(eq(t.groupMembers.groupId, group.id)),
      ),
    ),
  ]);
  const items = await groupPlaylist(context.env, group.id, members);
  return {
    group,
    members,
    friends,
    items,
    mine: group.creatorId === user.id,
  };
}

function groupOf(context: GroupsContext) {
  const id = Number(context.req.param("id"));
  return membership(database(context.env.DB), id, context.get("user").id);
}

groupsApp.get("/:id", async (context) => {
  const group = await groupOf(context);
  if (group === undefined) return missing(context);
  const data = await groupData(context, group);
  return context.html(groupPage(context.get("user"), data, {}));
});

groupsApp.post("/:id/members", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
  const group = await groupOf(context);
  if (group === undefined) return missing(context);
  const friend = Number((await context.req.parseBody()).user ?? Number.NaN);
  if (!(await isFriend(db, user.id, friend)))
    return context.text("Forbidden", 403);
  await db
    .insert(t.groupMembers)
    .values({
      groupId: group.id,
      userId: friend,
      createdAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoNothing();
  return context.redirect(`/groups/${group.id}`, 303);
});

groupsApp.post("/:id/rename", async (context) => {
  const user = context.get("user");
  const group = await groupOf(context);
  if (group === undefined) return missing(context);
  if (group.creatorId !== user.id) return context.text("Forbidden", 403);
  const name = readName(await context.req.parseBody());
  if ([...name].length === 0 || [...name].length > nameLength) {
    const data = await groupData(context, group);
    return context.html(
      groupPage(user, data, {
        error: "The name needs 1 to 60 characters.",
      }),
      400,
    );
  }
  await database(context.env.DB)
    .update(t.friendGroups)
    .set({ name })
    .where(eq(t.friendGroups.id, group.id));
  return context.redirect(`/groups/${group.id}`, 303);
});

groupsApp.post("/:id/leave", async (context) => {
  const user = context.get("user");
  const db = database(context.env.DB);
  const group = await groupOf(context);
  if (group === undefined) return missing(context);
  await db.batch([
    db
      .delete(t.groupMembers)
      .where(
        and(
          eq(t.groupMembers.groupId, group.id),
          eq(t.groupMembers.userId, user.id),
        ),
      ),
    // A group with nobody in it is gone.
    db
      .delete(t.friendGroups)
      .where(
        and(
          eq(t.friendGroups.id, group.id),
          notExists(
            db
              .select({ userId: t.groupMembers.userId })
              .from(t.groupMembers)
              .where(eq(t.groupMembers.groupId, group.id)),
          ),
        ),
      ),
  ]);
  return context.redirect("/groups", 303);
});
