import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import type { SignedInUser } from "./auth";
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
import { PillButton } from "./ui/pill";
import { Playlist } from "./ui/playlist";
import { Section } from "./ui/section";
import { Page } from "./ui/shell";

const recentDays = 90;
const playlistLength = 25;
const cacheSeconds = 600;
const nameLength = 60;

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

function memberName(member: Member) {
  return member.is_public === 1 ? (
    <a href={`/u/${encodeURIComponent(member.name)}`}>{member.name}</a>
  ) : (
    member.name
  );
}

function playlistBlock(items: PartyTrack[]) {
  const missing = items.filter((item) => item.videoId === null);
  const url = youtubePlaylistUrl(items);
  return items.length === 0 ? (
    <EmptyState
      title="No plays yet"
      body="Nobody in this group has any plays yet, so there is nothing to blend."
    />
  ) : (
    <>
      <div class="stack">
        {url !== null && (
          <div>
            <a class="pill primary" href={url} target="_blank" rel="noreferrer">
              Play on YouTube
            </a>
          </div>
        )}
        <p class="hint">
          {url === null
            ? "None of these tracks has a YouTube link yet."
            : missing.length === 0
              ? "Every track opens on YouTube."
              : `${missing.length} of ${items.length} tracks have no YouTube link yet.`}{" "}
          The playlist rebuilds from the latest plays as members come and go.
        </p>
      </div>
      <Section title="Playlist" aside={`${items.length} tracks`}>
        <Playlist items={items} />
      </Section>
    </>
  );
}

function listPage(
  user: SignedInUser,
  groups: Array<Group & { members: number }>,
  friends: Member[],
  options: { error?: string },
) {
  return Page({
    title: "Groups",
    user,
    children: (
      <>
        <div class="page-head">
          <h1>Groups</h1>
          <p>
            A group blends what its members play into one playlist that opens on
            YouTube.
          </p>
        </div>
        {options.error !== undefined && (
          <p class="form-error" role="alert">
            <b>Error:</b> {options.error}
          </p>
        )}
        <div class="duo">
          <Section title="Your groups" aside={`${groups.length}`}>
            {groups.length === 0 ? (
              <p class="muted">
                No groups yet. Make one, then add friends to it.
              </p>
            ) : (
              <ul class="rows">
                {groups.map((group) => (
                  <li key={group.id}>
                    <span class="track">
                      <b>
                        <a href={`/groups/${group.id}`}>{group.name}</a>
                      </b>
                      <small>
                        {group.members}{" "}
                        {group.members === 1 ? "member" : "members"}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="New group">
            <form method="post" action="/groups" class="stack">
              <div class="field">
                <label for="name">Name</label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  maxlength={nameLength}
                  required
                  spellcheck={false}
                  autocomplete="off"
                />
              </div>
              {friends.length > 0 && (
                <div class="field">
                  <span class="label">Add friends</span>
                  <div class="stack">
                    {friends.map((friend) => (
                      <label class="check" key={friend.id}>
                        <input
                          type="checkbox"
                          name="member"
                          value={friend.id}
                        />
                        <span>{friend.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <PillButton variant="primary">Make the group</PillButton>
              </div>
            </form>
          </Section>
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

function groupPage(
  user: SignedInUser,
  data: GroupPageData,
  options: { notice?: string; error?: string },
) {
  const { group, members, friends, items, mine } = data;
  return Page({
    title: group.name,
    user,
    children: (
      <>
        <div class="page-head">
          <h1>{group.name}</h1>
          <p class="meta">
            {members.length} {members.length === 1 ? "member" : "members"}
          </p>
        </div>
        {options.notice !== undefined && <Notice>{options.notice}</Notice>}
        {options.error !== undefined && (
          <p class="form-error" role="alert">
            <b>Error:</b> {options.error}
          </p>
        )}
        <div class="split">
          <div class="stack">{playlistBlock(items)}</div>
          <div class="stack">
            <Section title="Members">
              <ul class="rows">
                {members.map((member) => (
                  <li key={member.id}>
                    <span class="track">
                      <b>{memberName(member)}</b>
                      {member.id === group.creator_id && (
                        <small>made the group</small>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {friends.length > 0 && (
                <form
                  method="post"
                  action={`/groups/${group.id}/members`}
                  class="stack"
                >
                  <div class="field">
                    <label for="add-member">Add one of your friends</label>
                    <select id="add-member" name="user">
                      {friends.map((friend) => (
                        <option value={friend.id} key={friend.id}>
                          {friend.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <PillButton small>Add to the group</PillButton>
                  </div>
                </form>
              )}
            </Section>
            {mine && (
              <Section title="Rename">
                <form
                  method="post"
                  action={`/groups/${group.id}/rename`}
                  class="stack"
                >
                  <div class="field">
                    <label for="name">Name</label>
                    <input
                      id="name"
                      name="name"
                      type="text"
                      value={group.name}
                      maxlength={nameLength}
                      required
                      spellcheck={false}
                      autocomplete="off"
                    />
                  </div>
                  <div>
                    <PillButton small>Rename</PillButton>
                  </div>
                </form>
              </Section>
            )}
            <form method="post" action={`/groups/${group.id}/leave`}>
              <PillButton small>Leave the group</PillButton>
            </form>
          </div>
        </div>
      </>
    ),
  });
}

function missing(context: GroupsContext) {
  const user = context.get("user");
  return context.html(
    Page({
      title: "Group",
      user,
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
  memberOnly(
    "Groups",
    "A group blends what its members play into one playlist. Sign in to see yours.",
  ),
);

async function listData(context: GroupsContext) {
  const user = context.get("user");
  const [groups, friends] = await context.env.DB.batch([
    context.env.DB.prepare(
      `SELECT friend_groups.id, friend_groups.name, friend_groups.creator_id,
              (SELECT COUNT(*) FROM group_members
               WHERE group_members.group_id = friend_groups.id) AS members
       FROM group_members
       JOIN friend_groups ON friend_groups.id = group_members.group_id
       WHERE group_members.user_id = ?1
       ORDER BY friend_groups.name`,
    ).bind(user.id),
    context.env.DB.prepare(
      `SELECT users.id, users.name, users.is_public
       FROM friendships JOIN users ON users.id = friendships.friend_id
       WHERE friendships.user_id = ?1 ORDER BY users.name`,
    ).bind(user.id),
  ]);
  return {
    groups: groups.results as unknown as Array<Group & { members: number }>,
    friends: friends.results as unknown as Member[],
  };
}

groupsApp.get("/", async (context) => {
  const user = context.get("user");
  const { groups, friends } = await listData(context);
  return context.html(listPage(user, groups, friends, {}));
});

groupsApp.post("/", async (context) => {
  const user = context.get("user");
  const db = context.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const body = await context.req.parseBody();
  const name = readName(body);
  if ([...name].length === 0 || [...name].length > nameLength) {
    const { groups, friends } = await listData(context);
    return context.html(
      listPage(user, groups, friends, {
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
