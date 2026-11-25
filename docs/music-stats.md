# music-stats

[![Crates.io](https://img.shields.io/crates/v/music-stats?label=crates.io&logo=rust&color=orange)](https://crates.io/crates/music-stats)
[![docs.rs](https://docs.rs/music-stats/badge.svg)](https://docs.rs/music-stats)

music-stats writes your most played tracks of the last few days to a GitHub
Gist. It reads your history from Last.fm (which collects plays from Spotify,
Tidal, Deezer and other services), from YouTube Music, or from both, and writes
one plain-text file to an existing Gist.

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

The Gist now holds your five most played tracks of the last seven days:

```text
Weird Fishes/ Arpeggi                   Radiohead (4×)
Motion Sickness                         Phoebe Bridgers (3×)
Xtal                                    Aphex Twin (2×)
I Was Here                              Beyoncé
Your Best American Girl                 Mitski
```

- Reads Last.fm, YouTube Music, or both. If one fails, the other still
  publishes.
- Counts plays per track and lists the top `TOP_N`, with the play count when a
  track was played more than once.
- Aligns the columns and truncates long titles and artist names, including wide
  characters such as Japanese.
- Takes all settings from environment variables or a `.env` file.

To run it every day from a repository you own, see
[GitHub Actions](github-actions.md). To read YouTube Music, see
[Providers](providers.md). To change the number of days or tracks, see
[Configuration](configuration.md).
