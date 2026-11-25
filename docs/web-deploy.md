# Web deployment

The hosted profile runs as the `music-stats-web` Worker. It uses a D1 database
for listening history and a KV namespace for profile snapshots.

## Create the Cloudflare resources

Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) with an
account that owns the `rising.sh` zone and can create Workers resources.

From the repository root, enter `apps/web/`, install the pinned tools, then log
Wrangler in:

```sh
cd apps/web
mise install
npx wrangler login
```

Create the D1 database and copy the returned database ID:

```sh
cd apps/web
npx wrangler d1 create music-stats
```

Create the KV namespace and copy the returned namespace ID:

```sh
npx wrangler kv namespace create CACHE
```

Replace `REPLACE_WITH_D1_DATABASE_ID` and `REPLACE_WITH_KV_NAMESPACE_ID` in
[`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc) with those IDs. Keep the
bindings named `DB` and `CACHE`.

## Apply the schema

From `apps/web/`, apply the migration to the remote database:

```sh
npx wrangler d1 migrations apply music-stats --remote
```

The migration creates the complete schema used by the current and later web
milestones. Do not edit a deployed migration. When the schema changes, edit
`src/platform/db/schema.ts` and run `npm run db:generate` to write the next
migration.

After this first setup, the `web` workflow applies new migrations on each push
to master, after the tests and before `wrangler deploy`. A migration must only
add, because it lands while the previous Worker still serves.

## Configure the deploy secret

In the repository's GitHub settings, open **Secrets and variables → Actions**
and add these repository secrets:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with Workers Scripts edit,
  Workers Routes edit, D1 edit and KV edit permissions for this account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID that owns the Worker.

The deploy workflow reads these names. It does not store their values in the
repository.

## Configure GitHub sign-in

Sign-in uses the shared GitHub OAuth App `rising.sh`, owned by the `risinghq`
organization. Every rising.sh product uses it, each with its own exact redirect
URI. Wildcard matching is off. Do not register a new OAuth App.

The Worker sends `redirect_uri` as the origin of the request plus
`/auth/github/callback`
([`apps/web/src/account/auth.ts`](../apps/web/src/account/auth.ts)). It is
`https://earshot.rising.sh/auth/github/callback` when deployed and
`http://localhost:8787/auth/github/callback` under `wrangler dev`.

Open the app as an organization owner: **risinghq → Settings → Developer
settings → OAuth Apps → rising.sh**. Under **Authorization callback URLs**, add
one entry for each of these that the app does not list yet:

- `https://earshot.rising.sh/auth/github/callback`
- `https://music.rising.sh/auth/github/callback`
- `http://localhost/auth/github/callback`

A fork serving another domain adds `https://<domain>/auth/github/callback`
instead. GitHub ignores the port of a loopback redirect URI, so the one
`http://localhost/...` entry covers `wrangler dev` on any port, including 8787.

Generate a client secret for this Worker. On the app's page, under **Client
secrets**, choose **Generate a new client secret**, and copy the value at once:
GitHub shows it once. Each Worker has its own secret, so revoking one product's
secret leaves the others signed in. Copy the app's **Client ID** from the same
page. Store both as Worker secrets, from `apps/web/`:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Local development uses its own client secret, generated the same way, and the
same client id. Put them in `apps/web/.dev.vars`, and do not commit that file:

```sh
GITHUB_CLIENT_ID=the-client-id
GITHUB_CLIENT_SECRET=the-local-client-secret
```

## Configure Google sign-in

Every rising.sh product signs in with Google through one Google Cloud project,
`teams-rising-sh`, so the consent screen is the same everywhere. Each product
has its own OAuth client in it, so revoking one product's secret leaves the
others signed in. Do not create a new project.

In the
[Google Auth Platform](https://console.cloud.google.com/auth/clients?project=teams-rising-sh)
choose **Create client**, type **Web application**, name it after the product,
and add these **Authorized redirect URIs**:

- `https://earshot.rising.sh/auth/google/callback`
- `https://music.rising.sh/auth/google/callback`
- `http://localhost:8787/auth/google/callback`

Google shows the client secret once, when the client is created. The client id
is public and lives in `GOOGLE_CLIENT_ID` under `vars` in
[`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc). Store the secret as the
repository secret `GOOGLE_CLIENT_SECRET`, from the repository root:

```sh
gh secret set GOOGLE_CLIENT_SECRET
```

The `web` workflow uploads it with each deploy
(`wrangler deploy --secrets-file`), so no local Wrangler login is needed. For
`wrangler dev`, put `GOOGLE_CLIENT_SECRET` in `apps/web/.dev.vars`.

The project's branding is verified: the consent screen reads "continue to
rising.sh". Google checks it against the home page `https://rising.sh`, whose
**Sign in with rising.sh** section must name the app and say what the sign-in is
for, and against the policy at `https://rising.sh/privacy/`. Both live in the
`risinghq/rising.sh` repository. A product that starts asking Google for more
data updates that policy first. Google refused a plain "r" mark as a logo
because it does not identify the brand. The logo is the rising.sh flame.

## Attach the custom domain

The `routes` entry in `apps/web/wrangler.jsonc` attaches `earshot.rising.sh` and
`music.rising.sh` as Worker custom domains. Ensure `rising.sh` is active in the
same Cloudflare account, then deploy from the repository root:

```sh
npm --prefix apps/web ci
npm --prefix apps/web run deploy
```

Cloudflare creates the DNS record and certificate for the custom domain. Check
the result in **Workers & Pages → music-stats-web → Settings → Domains &
Routes**.

## Create the Spotify app

The pulled source is one shared Spotify app owned by the operator. In the
[Spotify developer dashboard](https://developer.spotify.com/dashboard) create an
app, select **Web API**, and add these redirect URIs:

- `https://earshot.rising.sh/auth/spotify/callback`
- `https://music.rising.sh/auth/spotify/callback`
- `http://127.0.0.1:8787/auth/spotify/callback`

Spotify rejects `localhost` in a redirect URI; the local one must be a loopback
literal such as `127.0.0.1`
([redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)).

Under **User Management**, add the Spotify email of every user who may connect.
Development mode allows 5 users, and the app owner must have Spotify Premium.

Copy the app's client ID and client secret and store them as Worker secrets,
from `apps/web/`:

```sh
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
```

The refresh tokens and YouTube Music cookies live in `sources.secret`, AES-GCM
encrypted under one key. Generate a 32-byte key, print it as base64, and store
it too:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
  | npx wrangler secret put SOURCE_ENCRYPTION_KEY
```

For local development put the same values in `apps/web/.dev.vars`, and do not
commit that file:

```sh
SPOTIFY_CLIENT_ID=the-client-id
SPOTIFY_CLIENT_SECRET=the-local-client-secret
SOURCE_ENCRYPTION_KEY=the-base64-key
```

Users sign in with GitHub and connect Spotify on the settings page. The cron
trigger pulls the source on the next minute.

## Connect YouTube Music

The user connects YouTube Music themselves on the settings page: they paste the
`Cookie` request header of `music.youtube.com`, copied from their browser's
developer tools, and pick their IANA time zone. The Worker checks the cookie
against the history page, stores it AES-GCM encrypted, imports the page's plays
at once, and pulls the page every hour from then on. The source needs no
Worker-side YouTube secret: `SOURCE_ENCRYPTION_KEY` above covers the stored
cookie.

## Add a YouTube Music upload token

An upload token is the secondary way in, for a user who keeps their GitHub
Action and does not paste a cookie. It lets the Action post plays to
`POST /api/v1/upload`. The database keeps only the token's SHA-256 hash, so
create the token after the user has a `ytmusic` source.

Add the source if the user does not have one yet:

```sh
npx wrangler d1 execute music-stats --remote --command \
  "INSERT INTO sources (user_id, kind) VALUES ((SELECT id FROM users WHERE name = 'alice'), 'ytmusic');"
```

Run the token script from `apps/web/` with the source's id. It prints the token
once and the SQL that stores its hash:

```sh
node scripts/make-token.mjs 1
```

Paste the printed `INSERT` into a remote execute:

```sh
npx wrangler d1 execute music-stats --remote --command \
  "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (1, X'...', '....', unixepoch());"
```

Store the printed token as `UPLOAD_TOKEN` in the user repository's Actions
secrets. The token is not stored anywhere else; if it is lost, run the script
again and revoke the old row by setting `revoked_at`.

## Phone scrobbler

Users issue a scrobbler token on the settings page under **Phone scrobbler** and
paste it into a ListenBrainz-compatible app such as Pano Scrobbler, with
`https://earshot.rising.sh` as the server. The source needs no Worker secret or
OAuth app: the token lives hashed in the `tokens` table against the user's
`listenbrainz` source.

## Take payments for Earshot+

A $5 one-time payment upgrades a user to the `paid` tier, which unlocks the
intro clip mode. Polar sells it through a checkout link and tells the Worker
about the payment with a webhook. No Polar library runs on the Worker: the
Standard Webhooks signature is checked with Web Crypto.

In the [Polar dashboard](https://polar.sh/), create a product with a one-time
price of $5, then create a **checkout link** for it and set its success URL to
`https://earshot.rising.sh/settings`. Copy the link's URL and store it, from
`apps/web/`:

```sh
npx wrangler secret put POLAR_CHECKOUT_LINK
```

The settings page reads the link from `POLAR_CHECKOUT_LINK` and appends
`?reference_id=<user id>`. Polar stores the reference in the checkout's metadata
and copies it onto the order.

Under **Settings → Webhooks**, add an endpoint pointing at
`https://earshot.rising.sh/billing/webhook` and subscribe it to `order.paid` and
`order.refunded`. Copy the endpoint's signing secret (`whsec_...`) and store it:

```sh
npx wrangler secret put POLAR_WEBHOOK_SECRET
```

The webhook reads the user id from the order's `metadata.reference_id`. It marks
that user as `paid` on `order.paid` and revokes the tier on `order.refunded`.
The Worker checks the signature with the Standard Webhooks scheme, which Polar
uses for every secret created since 8 September 2026. An operator can also grant
or revoke the tier by hand on `/admin/users`.

Intro clips come from the antra fetch pipeline at `https://antra.hoshi.cfd`. The
Worker needs its credentials:

```sh
npx wrangler secret put ANTRA_USERNAME
npx wrangler secret put ANTRA_PASSWORD
```

`ANTRA_BASE` overrides the base URL. `INTRO_SECONDS` sets the clip length, 10
seconds by default, under `vars` in
[`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc). The fetched mp3 sits in
the `CACHE` KV for 24 hours, so only a track's first paid play waits on antra.

### Test payments locally

Local development takes payments in the
[Polar sandbox](https://sandbox.polar.sh/), which charges no real money. Create
a sandbox organization, the same $5 product and a checkout link whose success
URL is `http://localhost:8787/settings`.

Polar cannot reach `localhost`, so the Polar CLI forwards the sandbox's webhook
events to the local Worker. Sign in to the sandbox and start the forwarder:

```sh
npx @polar-sh/cli auth login --sandbox
npx @polar-sh/cli webhook listen http://localhost:8787/billing/webhook
```

The forwarder prints its own signing secret. Put it in `apps/web/.dev.vars` with
the sandbox checkout link and the antra credentials, and do not commit that
file:

```sh
POLAR_CHECKOUT_LINK=https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_.../redirect
POLAR_WEBHOOK_SECRET=the-secret-printed-by-webhook-listen
ANTRA_USERNAME=name
ANTRA_PASSWORD=password
```

The forwarder's secret has no `whsec_` prefix and signs with its UTF-8 bytes;
the Worker accepts both forms. Run `npm run dev`, sign in, and buy Earshot+ from
the settings page with the test card `4242 4242 4242 4242`, any future expiry
and any CVC. Polar refuses an `example.com` email. The forwarder logs
`order.paid 200 OK` and the user turns `paid`.

To skip the checkout, send a signed event for user 1 straight through the
forwarder:

```sh
npx @polar-sh/cli webhook trigger order.paid \
  --override 'data.metadata={"reference_id":"1"}'
```
