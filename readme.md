<p align="center">
  <a href="https://earshot.rising.sh"><img alt="" src="apps/web/public/favicon.svg" width="72" height="72"></a>
</p>

# Earshot

Guess the song from a 15-second clip, alone or with friends. Earshot runs at
<https://earshot.rising.sh>.

[![Crates.io](https://img.shields.io/crates/v/music-stats?label=crates.io&logo=rust&color=orange)](https://crates.io/crates/music-stats)
[![docs.rs](https://docs.rs/music-stats/badge.svg)](https://docs.rs/music-stats)
[![codecov](https://codecov.io/gh/risinghq/earshot.rising.sh/graph/badge.svg)](https://codecov.io/gh/risinghq/earshot.rising.sh)

<img alt="The Earshot play page: genres with a decade picker, and a mix built from your own listening" src="docs/earshot.png" width="860">

## Play

- **Solo:** ten rounds from a genre, a decade, or a mix built from your own
  listening. The faster you answer, the more the round is worth.
- **Room:** start a room and share its code or link. Up to 8 players answer on
  their own phones, and every round starts on every device at once.
- **Match:** get paired with a stranger who picked the same genre.
- **TV:** open a room on a big screen. It plays the clip and shows the code, the
  round and the scores, while the phones take the answers.

Signed-in players keep their points on the weekly board, join groups with
friends, and get a public listening profile at `/u/NAME`, with JSON at
`/u/NAME.json` and a card for a README at `/u/NAME.svg`.

[Web app](docs/web-app.md) is the design of the site, and
[Web deploy](docs/web-deploy.md) is how it ships.

## music-stats

music-stats is the command-line program in this repository. It writes your most
played tracks of the last few days to a GitHub Gist. It reads your history from
Last.fm (which collects plays from Spotify, Tidal, Deezer and other services),
from YouTube Music, or from both. It runs as a command, or on a schedule in
GitHub Actions.

It reads only those two sources and writes one plain-text file to an existing
Gist.

```text
Weird Fishes/ Arpeggi                   Radiohead (4×)
Motion Sickness                         Phoebe Bridgers (3×)
Xtal                                    Aphex Twin (2×)
I Was Here                              Beyoncé
Your Best American Girl                 Mitski
```

### Get started

Install the binary with Cargo:

```sh
cargo install music-stats
```

Create a public Gist at <https://gist.github.com>, and a
[personal access token](https://github.com/settings/personal-access-tokens/new)
with the Gists permission. Then run:

```sh
export GIST_ID=<the ID at the end of the Gist URL>
export GH_TOKEN=<your token>
export LASTFM_API_KEY=<your Last.fm API key>
export LASTFM_USERNAME=<your Last.fm username>
music-stats
```

The Gist now holds your five most played tracks of the last seven days. To use
YouTube Music instead of, or as well as, Last.fm, see
[Providers](docs/providers.md). To change the number of days or tracks, see
[Configuration](docs/configuration.md).

### Run it on a schedule

Create a repository from the
[template](https://github.com/new?template_name=earshot.rising.sh&template_owner=risinghq),
add your credentials as Actions secrets, and the included workflow updates the
Gist every day. `DAYS` and `TOP_N` are repository variables.
[GitHub Actions](docs/github-actions.md) has the steps.

### Features

- Reads Last.fm, YouTube Music, or both. If one fails, the other still
  publishes.
- Counts plays per track and lists the top `TOP_N`, with the play count when a
  track was played more than once.
- Aligns the columns and truncates long titles and artist names, including wide
  characters such as Japanese.
- Takes all settings from environment variables or a `.env` file.

## Documentation

- [Manual](docs/readme.md)
- [Contributing](.github/contributing.md)
- [License](LICENSE)

Earshot is a [rising.sh](https://rising.sh) project.
