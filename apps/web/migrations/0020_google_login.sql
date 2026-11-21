-- Sign-in with Google beside GitHub. google_sub is Google's stable account
-- id; google_email is shown only to the owner, on the settings page.
--
-- users.github_id stays NOT NULL: dropping the constraint means rebuilding
-- users, and D1 cannot turn foreign keys off, so the DROP TABLE would cascade
-- and delete every friend, group and game result. An account with no GitHub
-- link holds a negative github_id instead (src/auth.ts), which no GitHub
-- account or admin id can equal.
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN google_email TEXT;
CREATE UNIQUE INDEX users_google_sub ON users (google_sub);
