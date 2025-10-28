# Sereus Web (static)

This is a lightweight static site that mirrors the `doc/web/example` pattern:
- Single HTML shell (`index.html`)
- Content pages loaded dynamically via hash routing (`<page>.html`)
- No build step required

## Local preview

Because pages are fetched with XHR, open through a local server (not `file://`). Examples:

```bash
# in this folder
python3 -m http.server 8080
# then open http://localhost:8080/index.html#home
```

Or with Node:

```bash
npx serve -l 8080
```

## Publish

Host the folder as static files on any web host (GitHub Pages, S3, nginx). Entry: `index.html`. Hash routing requires no server rewrites.

## Content workflow

- Start with placeholders under this directory.
- Replace sections using content derived from `../README.md` and linked projects (Quereus, Optimystic/Fret, libp2p, MyCHIPs, VoteTorrent).
- Keep each content page focused and link forward/back using `data-page` anchors for the sequential flow.
