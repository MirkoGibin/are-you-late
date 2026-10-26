# are-you-late

Has my regional train left the previous stations yet? How late is it? A tiny phone-first page that answers that for one morning train and one return train.

> Personal, unofficial project. Data comes from [ViaggiaTreno](http://www.viaggiatreno.it) and may be incomplete or late. Not affiliated with Trenitalia.

## Status

🚧 Under construction. Progress and ideas in [Issues](https://github.com/MirkoGibin/are-you-late/issues).

## How it works

- A static page on GitHub Pages, meant for the phone.
- A small Cloudflare Worker that reads ViaggiaTreno (browsers can't call it directly) and computes the train status.
- The route (trains, stations, labels) is configuration kept outside this repository. See `worker/route-config.example.json` once it exists.

Design and technical details: [CLAUDE.md](CLAUDE.md) and [the design spec](docs/superpowers/specs/2026-10-26-are-you-late-design.md).

## Privacy

The site uses no cookies and collects no data. The hosting providers (GitHub, Cloudflare) may log IP addresses for technical and security purposes.
