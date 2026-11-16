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
./publish.sh [USER@HOST] [DEST_PATH]
```

`publish.sh` copies the folder to the web host with `rsync --delete` (or `scp` when `rsync` is missing), leaving out the two scripts and this file. With no arguments it publishes to `root@gotchoices.org:/var/www/sereus.org`. It needs SSH access to that host.

## Keeping the site true

The site describes the product in general terms and is edited by hand, so nothing checks it against the code. When a page shows code or names a package, take the example from [`docs/getting-started.md`](../getting-started.md) or [`docs/schema-guide.md`](../schema-guide.md), whose examples are checked.
