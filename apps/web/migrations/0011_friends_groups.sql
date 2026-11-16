ALTER TABLE users ADD COLUMN friend_link TEXT;
CREATE UNIQUE INDEX users_friend_link ON users (friend_link);

CREATE TABLE friend_requests (
  id INTEGER PRIMARY KEY,
  from_user INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  to_user INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (from_user, to_user)
);
CREATE INDEX friend_requests_to ON friend_requests (to_user);
CREATE INDEX friend_requests_from ON friend_requests (from_user);

CREATE TABLE friendships (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
) WITHOUT ROWID;

CREATE TABLE friend_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES friend_groups (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
) WITHOUT ROWID;
CREATE INDEX group_members_user ON group_members (user_id);
