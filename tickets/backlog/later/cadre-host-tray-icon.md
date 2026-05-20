---
description: System-tray icon for cadre-host (Win/macOS/Linux). Status indicator + context menu (Open dashboard, Status, Quit). Deferred from the cadre-host-local-ui v1.
files: packages/cadre-host/src/tray/ (new), packages/cadre-host/src/bin/host.ts
---

## Why this is a backlog ticket

The v1 local UI ships browser-only (see `tickets/complete/6.5-...` once landed). A tray icon would be polish, not new behaviour:

- Discoverability is handled by the installer opening the browser on first run and the README documenting `cadre-host ui`.
- "Is it running?" can already be answered by either the OS service manager or `cadre-host status` (once that stub is real).
- The dashboard URL is stable; bookmarking is the usual workflow.

Tray support also has portability tax. Linux tray is messy (libappindicator vs StatusNotifier, GNOME's resistance, KDE/XFCE/Cinnamon variation). macOS and Windows are clean via Electron, but Electron is a ~100 MB dependency for one feature.

## Surface (when implemented)

- Idle icon: green dot when all managed cadre nodes are running and connectivity is `reachable`, yellow when at least one node is `restarting` or connectivity is `relay-only`, red on `unreachable` / any node stopped.
- Tooltip: `cadre-host — N nodes, M trust-circle members, <connectivity status>`.
- Context menu:
  - "Open dashboard" — opens `http://127.0.0.1:<uiPort>` via `installer/browser.ts`.
  - "Status" — opens dashboard at `#/`.
  - "Trust circle" — opens dashboard at `#/trust-circle`.
  - "Quit cadre-host" — confirms, then issues a clean shutdown via `POST /admin/shutdown` (new endpoint also out of scope for v1).

## Implementation notes

Prefer a non-Electron native module (e.g. `systray2` or `@cretueusebiu/node-tray`). Trade-off: those have small contributor bases and uneven release cadence; pin a version and test on each platform. If neither is reliable enough at evaluation time, consider a small native helper executable bundled in the standalone-binary distribution (see `tickets/backlog/cadre-host-standalone-binary.md`) so the tray code only ships in the binary path.

The tray icon must:

- Subscribe to `/api/events` (the same SSE stream the SPA uses) so the icon colour is reactive.
- Spawn no UI of its own — all interaction goes through the local web UI.
- Be optional: a `--no-tray` flag on `cadre-host start` (and a `tray.enabled: false` setting in `host.config.json`) disables it. On a headless box (no display server), it should silently no-op rather than crash.

## Open questions

- Does it run inside the cadre-host process, or as a separate sidecar invoked by the service manager?
  - In-process is simpler (one binary, one identity, one shutdown). But adds a GUI dependency to the service binary — bad on headless Linux servers. Sidecar is cleaner separation but adds a second managed process.
  - Lean: in-process, with the no-tray gating above. Headless installs simply pass `--no-tray`.
- Linux tray library: revisit at the time. Current Linux ecosystem state may have changed.

## Non-goals

- Notifications (toasts on update-available, node-stopped). Add only with a clear user signal that the dashboard isn't enough.
- A full GUI window. Anything beyond the icon + menu belongs in the web UI.
