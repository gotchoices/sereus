# sereus.org site source

This folder is the source of the public website at `https://sereus.org`: hand-written static HTML (`index.html` loads the other pages), one stylesheet and one script. It is not part of the developer documentation, which starts at [`docs/README.md`](../README.md).

## Preview

```bash
cd docs/web
./server.sh        # serves http://localhost:8080/index.html#home; pass a port to change it
```

`server.sh` needs `python3`.

## Publish

```bash
cd docs/web
./publish.sh [--yes] [USER@HOST] [DEST_PATH]
```

`publish.sh` copies the folder to the web host with `rsync --delete`, leaving out the two scripts and this file. With no arguments it publishes to `root@gotchoices.org:/var/www/sereus.org`. It needs SSH access to that host and `rsync`.

The docroot is shared. Other repositories publish into it, and `publish.sh` excludes their paths so `--delete` never removes them (the `PROTECTED` list in the script):

| Path | Published by |
|------|--------------|
| `/chat/` | `chat/site/publish.sh` (Sereus Chat) |
| `/health/` | `health/web/publish.sh` (Sereus Health) |
| `/taleus/` | `taleus/web/publish.sh` (Taleus) |
| `/.well-known/` | each app's `publish.sh` (merged app-link entries), and `taleus/contracts/publish.sh` (`stroc/`) |
| `/ipfs/` | `taleus/contracts/publish.sh` (published contract documents) |
| `/join/`, `/bonum/`, `/erp/` | reserved for pages not yet published |

Before syncing, the script does a dry run, lists anything `--delete` would remove and asks to continue (`--yes` skips the question). Add a new app's path to `PROTECTED` before its first publish.

## Apps

The [Apps page](apps.html) and the home page link to the app pages above with plain links (`href="/chat/"`), not `data-page`, because they are separate sites and not pages of this one. Their logos are copied into `images/apps/` so the cards render in a local preview, where the app links themselves 404.

## Keeping the site true

The site describes the product in general terms and is edited by hand, so nothing checks it against the code. When an app ships, moves or is renamed, update `apps.html`, the home page cards and `news.html`. When a page shows code or names a package, take the example from [`docs/getting-started.md`](../getting-started.md) or [`docs/schema-guide.md`](../schema-guide.md), whose examples are checked.
