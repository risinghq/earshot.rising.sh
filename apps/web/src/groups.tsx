import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import type { SignedInUser } from "./auth";
import { incomingRequests, PeopleSwitch } from "./friends";
import {
  blend,
  youtubePlaylistUrl,
  type PartyTrack,
  type PartyUser,
} from "./party-blend";
import { memberOnly } from "./sign-in";
import type { Env } from "./types";
import { EmptyState } from "./ui/empty";
import { Notice } from "./ui/notice";
import {
  BackLink,
  Cover,
  Monogram,
  MonoStack,
  Mosaic,
  playIcon,
} from "./ui/person";
import { Page } from "./ui/shell";

const recentDays = 90;
const playlistLength = 25;
const cacheSeconds = 600;
const nameLength = 60;
const stackSize = 3;
const foldRows = 8;

interface CandidateRow {
  track_id: number;
  title: string;
  artist: string;
  artist_id: number;
  plays: number;
  video_id: string | null;
}

const recentSql = `
  SELECT plays.track_id, tracks.title, artists.name AS artist,
         tracks.artist_id, COUNT(*) AS plays,
         (SELECT MIN(alias.source_key) FROM track_aliases AS alias
          WHERE alias.kind = 'ytmusic'
            AND alias.track_id = plays.track_id) AS video_id
  FROM plays
  JOIN tracks ON tracks.id = plays.track_id
  JOIN artists ON artists.id = tracks.artist_id
  WHERE plays.user_id = ?1 AND plays.dup = 0 AND plays.played_at >= ?2
  GROUP BY plays.track_id
  ORDER BY plays DESC, plays.track_id
  LIMIT ?3
`;

const allTimeSql = `
  SELECT totals.track_id, tracks.title, artists.name AS artist,
         tracks.artist_id, totals.plays,
         (SELECT MIN(alias.source_key) FROM track_aliases AS alias
          WHERE alias.kind = 'ytmusic'
            AND alias.track_id = totals.track_id) AS video_id
  FROM track_totals AS totals
  JOIN tracks ON tracks.id = totals.track_id
  JOIN artists ON artists.id = tracks.artist_id
  WHERE totals.user_id = ?1
  ORDER BY totals.plays DESC, totals.track_id
  LIMIT ?2
`;

interface Member {
  id: number;
  name: string;
  is_public: number;
}

interface Group {
  id: number;
  name: string;
  creator_id: number;
}

interface GroupCard extends Group {
  names: string[];
}

type GroupsContext = Context<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>;

async function membership(db: D1Database, groupId: number, userId: number) {
  const group = await db
    .prepare(
      `SELECT friend_groups.id, friend_groups.name, friend_groups.creator_id,
              group_members.user_id IS NOT NULL AS member
       FROM friend_groups
       LEFT JOIN group_members
         ON group_members.group_id = friend_groups.id
        AND group_members.user_id = ?2
       WHERE friend_groups.id = ?1`,
    )
    .bind(groupId, userId)
    .first<Group & { member: number }>();
  return group;
}

async function buildPlaylist(db: D1Database, members: Member[], now: number) {
  const since = now - recentDays * 86400;
  const results = await db.batch(
    members.flatMap((member) => [
      db.prepare(recentSql).bind(member.id, since, playlistLength),
      db.prepare(allTimeSql).bind(member.id, playlistLength),
    ]),
  );
  const users: PartyUser[] = members.map((member, index) => {
    const recent = results[2 * index]?.results as unknown as CandidateRow[];
    const allTime = results[2 * index + 1]
      ?.results as unknown as CandidateRow[];
    const seen = new Set(recent.map((row) => row.track_id));
    const tracks = [
      ...recent,
      ...allTime.filter((row) => !seen.has(row.track_id)),
    ]
      .slice(0, playlistLength)
      .map((row, index2) => ({
        trackId: row.track_id,
        title: row.title,
        artist: row.artist,
        artistKey: String(row.artist_id),
        videoId: row.video_id,
        // Shared ranking sums 90-day counts, so fill rows count as 0.
        plays: index2 < recent.length ? row.plays : 0,
      }));
    return { name: member.name, tracks };
  });
  return blend(users, playlistLength);
}

async function cachedPlaylist(env: Env, group: Group, members: Member[]) {
  const ids = members
    .map((member) => member.id)
    .sort((a, b) => a - b)
    .join("-");
  const key = `group:${group.id}:${ids}`;
  let items: PartyTrack[] | null = null;
  if (env.CACHE !== undefined) {
    try {
      items = await env.CACHE.get<PartyTrack[]>(key, "json");
    } catch {
      items = null;
    }
  }
  if (items === null) {
    items = await buildPlaylist(env.DB, members, Math.floor(Date.now() / 1000));
    await env.CACHE?.put(key, JSON.stringify(items), {
      expirationTtl: cacheSeconds,
    }).catch(() => undefined);
  }
  return items;
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
  return member.is_public === 1 ? (
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

// The script folds a long playlist to its first rows and shows the button
// that unfolds it, so without JavaScript every row stays visible.
const foldScript = `
const card = document.getElementById("playlist");
const more = document.getElementById("show-all");
if (card && more) {
  card.classList.add("is-folded");
  more.hidden = false;
  more.addEventListener("click", () => {
    card.classList.remove("is-folded");
    more.remove();
  });
}
`;

function PlaylistCard({ items }: { items: PartyTrack[] }) {
  return (
    <section class="top-card playlist-card" id="playlist">
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
            <Cover seed={`${item.title} ${item.artist}`} />
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
        <>
          <button class="show-all" id="show-all" type="button" hidden>
            Show all {items.length}
          </button>
          <script
            type="module"
            dangerouslySetInnerHTML={{ __html: foldScript }}
          />
        </>
      )}
    </section>
  );
}

// The manage panel is a disclosure on a phone. On desktop a script opens it
// and the CSS hides its summary, so without JavaScript it stays a working
// disclosure.
const manageScript = `
const manage = document.getElementById("manage");
if (manage && matchMedia("(min-width: 900px)").matches) manage.open = true;
`;

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
      <script
        type="module"
        dangerouslySetInnerHTML={{ __html: manageScript }}
      />
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
                  {member.id === group.creator_id && (
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
  const db = context.env.DB;
  const [groups, names, friends] = await db.batch([
    db
      .prepare(
        `SELECT friend_groups.id, friend_groups.name, friend_groups.creator_id
         FROM group_members
         JOIN friend_groups ON friend_groups.id = group_members.group_id
         WHERE group_members.user_id = ?1
         ORDER BY friend_groups.name`,
      )
      .bind(user.id),
    db
      .prepare(
        `SELECT everyone.group_id, users.name
         FROM group_members AS mine
         JOIN group_members AS everyone ON everyone.group_id = mine.group_id
         JOIN users ON users.id = everyone.user_id
         WHERE mine.user_id = ?1
         ORDER BY users.name`,
      )
      .bind(user.id),
    db
      .prepare(
        `SELECT users.id, users.name, users.is_public
         FROM friendships JOIN users ON users.id = friendships.friend_id
         WHERE friendships.user_id = ?1 ORDER BY users.name`,
      )
      .bind(user.id),
  ]);
  const byGroup = new Map<number, string[]>();
  for (const row of names.results as unknown as Array<{
    group_id: number;
    name: string;
  }>) {
    const list = byGroup.get(row.group_id) ?? [];
    list.push(row.name);
    byGroup.set(row.group_id, list);
  }
  return {
    groups: (groups.results as unknown as Group[]).map((group) => ({
      ...group,
      names: byGroup.get(group.id) ?? [],
    })),
    friends: friends.results as unknown as Member[],
    requests: await incomingRequests(db, user.id),
  };
}

groupsApp.get("/", async (context) => {
  const user = context.get("user");
  return context.html(listPage(user, await listData(context), {}));
});

groupsApp.post("/", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
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
    const slots = picks.map(() => "?").join(", ");
    const found = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM friendships
         WHERE user_id = ?1 AND friend_id IN (${slots})`,
      )
      .bind(user.id, ...picks)
      .first<{ n: number }>();
    if ((found?.n ?? 0) !== picks.length) return context.text("Forbidden", 403);
  }
  const group = await db
    .prepare(
      `INSERT INTO friend_groups (name, creator_id, created_at)
       VALUES (?1, ?2, ?3) RETURNING id`,
    )
    .bind(name, user.id, now)
    .first<{ id: number }>();
  if (group === null) throw new Error("could not create the group");
  await db.batch(
    [user.id, ...picks].map((member) =>
      db
        .prepare(
          `INSERT INTO group_members (group_id, user_id, created_at)
           VALUES (?1, ?2, ?3)`,
        )
        .bind(group.id, member, now),
    ),
  );
  return context.redirect(`/groups/${group.id}`, 303);
});

async function groupData(
  context: GroupsContext,
  group: Group,
): Promise<GroupPageData> {
  const user = context.get("user");
  const [members, friends] = await context.env.DB.batch([
    context.env.DB.prepare(
      `SELECT users.id, users.name, users.is_public
       FROM group_members JOIN users ON users.id = group_members.user_id
       WHERE group_members.group_id = ?1 ORDER BY users.name`,
    ).bind(group.id),
    context.env.DB.prepare(
      `SELECT users.id, users.name, users.is_public
       FROM friendships JOIN users ON users.id = friendships.friend_id
       WHERE friendships.user_id = ?1
         AND users.id NOT IN
           (SELECT user_id FROM group_members WHERE group_id = ?2)
       ORDER BY users.name`,
    ).bind(user.id, group.id),
  ]);
  const memberRows = members.results as unknown as Member[];
  const items = await cachedPlaylist(context.env, group, memberRows);
  return {
    group,
    members: memberRows,
    friends: friends.results as unknown as Member[],
    items,
    mine: group.creator_id === user.id,
  };
}

groupsApp.get("/:id", async (context) => {
  const user = context.get("user");
  const id = Number(context.req.param("id"));
  const group = await membership(context.env.DB, id, user.id);
  if (group === null || group.member !== 1) return missing(context);
  return context.html(groupPage(user, await groupData(context, group), {}));
});

groupsApp.post("/:id/members", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const id = Number(context.req.param("id"));
  const group = await membership(db, id, user.id);
  if (group === null || group.member !== 1) return missing(context);
  const friend = Number((await context.req.parseBody()).user ?? Number.NaN);
  const isFriend =
    (await db
      .prepare(
        `SELECT 1 AS yes FROM friendships
         WHERE user_id = ?1 AND friend_id = ?2`,
      )
      .bind(user.id, friend)
      .first()) !== null;
  if (!isFriend) return context.text("Forbidden", 403);
  await db
    .prepare(
      `INSERT OR IGNORE INTO group_members (group_id, user_id, created_at)
       VALUES (?1, ?2, ?3)`,
    )
    .bind(id, friend, Math.floor(Date.now() / 1000))
    .run();
  return context.redirect(`/groups/${id}`, 303);
});

groupsApp.post("/:id/rename", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const id = Number(context.req.param("id"));
  const group = await membership(db, id, user.id);
  if (group === null || group.member !== 1) return missing(context);
  if (group.creator_id !== user.id) return context.text("Forbidden", 403);
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
  await db
    .prepare("UPDATE friend_groups SET name = ?1 WHERE id = ?2")
    .bind(name, id)
    .run();
  return context.redirect(`/groups/${id}`, 303);
});

groupsApp.post("/:id/leave", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const id = Number(context.req.param("id"));
  const group = await membership(db, id, user.id);
  if (group === null || group.member !== 1) return missing(context);
  await db.batch([
    db
      .prepare("DELETE FROM group_members WHERE group_id = ?1 AND user_id = ?2")
      .bind(id, user.id),
    // A group with nobody in it is gone.
    db
      .prepare(
        `DELETE FROM friend_groups WHERE id = ?1 AND NOT EXISTS
         (SELECT 1 FROM group_members WHERE group_id = ?1)`,
      )
      .bind(id),
  ]);
  return context.redirect("/groups", 303);
});
