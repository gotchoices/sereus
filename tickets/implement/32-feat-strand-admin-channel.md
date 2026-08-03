description: The always-on cadre node lets a local manager app read and change party membership over a private channel, but that channel says nothing about the shared networks the party takes part in — add the two operations needed to list them and leave one.
files: packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/test/admin-server.spec.ts, packages/cadre-core/src/cadre-node.ts, docs/cadre-host.md, docs/architecture.md
difficulty: medium
----

# A `strands` resource on the node admin channel

## Why

`cadre strand list|remove` (landed, `tickets/complete/5.1-feat-strand-removal-cli.md`) is the only
way to leave a strand. It works by connecting a one-shot `CadreNode` and calling
`CadreNode.unpublishStrand`. The self-hosted manager (`cadre-host`) holds **no** in-process
`CadreNode` — it spawns the owner node as a child and reaches it over the loopback admin channel
(`packages/cadre-cli/src/server/admin-server.ts`, class `AdminServer`). That channel has an
`invites` resource, a `members` resource, an `add-drone` route — and nothing at all about strands.

This ticket adds the node-side half only. The manager-side API is
`feat-cadre-host-strand-api`; the owner-facing screen is
`feat-cadre-host-strand-removal-screen`.

## What the channel gains

Two routes under the existing `/admin` prefix, same bearer auth and same
`{ ok: true, data }` / `{ ok: false, error: { code, message } }` envelope as every other route.

### `GET /admin/strands`

```ts
{
  strands: Array<{
    /** The `CadreControl.Strand` row id — what `remove` takes. */
    id: string;
    /** 'o' = open, 'c' = closed (the row carries this party's membership secret). */
    type: 'o' | 'c';
    /** True when this node currently has a running instance for the id. */
    running: boolean;
    /** The instance's `StrandStatus` when running, else null. */
    status: string | null;
  }>;
  /** Open control-network connections right now — 0 means a write commits local-only. */
  controlConnections: number;
}
```

**The list comes from the control database, not from the running instances.** Source is
`node.getControlDatabase()?.queryStrands()` (`packages/cadre-core/src/control-database.ts:593`),
with `node.getStrands()` (`cadre-node.ts:565`) overlaid to fill `running`/`status`. Doing it the
other way round would hide exactly the rows an owner most needs to see: a strand this node's
`strandFilter` excluded, or one whose launch failed, is still this party's participation and is
still removable.

**`MemberPrivateKey` must never appear in a response.** `StrandRow` carries it
(`packages/cadre-core/src/types.ts:580`); it is this party's membership secret for a closed
strand and is stored nowhere else. Project to the four fields above and nothing more.

**No forced watcher poll.** The CLI's `list` calls `forceStrandPoll()` because a one-shot node
has only just connected. The owner node here is long-lived with a watcher already polling every
5 s, so this stays a side-effect-free GET.

### `DELETE /admin/strands/:id?confirm=1`

```ts
{
  strandId: string;      // the trimmed id the call was about
  published: boolean;    // was a row found before the write
  type: 'o' | 'c' | null;// the found row's type, null when absent
  removed: boolean;      // did this call issue the delete
  alone: boolean;        // 0 control connections sampled right after the write
}
```

Read the row (`ControlDatabase.queryStrand`), decide, then write — the same read→decide→write
shape as `applyRemove` in `packages/cadre-cli/src/commands/strands.ts`, and for the same reason:
`unpublishStrand` is a silent no-op on an absent row, so "was not published" and "removed" are
indistinguishable after the fact.

| Row state | `confirm` | Outcome |
|---|---|---|
| absent | either | no write, **200**, `{ published: false, removed: false, type: null }` |
| `type='o'` | either | `unpublishStrand`, **200**, `removed: true` |
| `type='c'` | absent/other | **no write**, **428**, code `confirmation_required` |
| `type='c'` | `1` or `true` | `unpublishStrand`, **200**, `removed: true` |

Absent → 200 rather than 404, mirroring the CLI's exit 0: the caller asked for the row to be
gone and it is gone. The response says `published: false` so a caller that cares can tell.

`confirm` accepts exactly `1` and `true`. Anything else — including `yes`, `on`, an empty value —
counts as not confirmed. A guessy parser here would turn a typo into a destroyed secret.

`removed: true` means *this call issued the delete*, not that the row was observed to vanish.
`unpublishStrand` returns `void`, and the read and the write are not atomic — a concurrent
removal landing in between makes this one a no-op that still reports `removed: true`. That is the
same window the CLI documents, and harmless for the same reason: the caller gets the outcome
they asked for.

### New admin error code

`AdminErrorCode` gains `confirmation_required`, mapped to **428 Precondition Required** in
`STATUS_BY_CODE`. 400 would work but collapses "you sent something malformed" into "you must say
out loud that you mean this", and the manager needs to tell those apart to show the right screen.

### New cadre-core accessor

```ts
/**
 * Open control-network connections. A lower-bound proxy for replication reach:
 * 0 connections ⇒ a control write commits local-only. Read-only reporting.
 */
getControlConnectionCount(): number
```

One line on `CadreNode`, returning `this.controlNode?.getConnections().length ?? 0` — the same
expression the private `committedAlone()` already uses (`cadre-node.ts:2083`). It exists so the
manager can warn an owner *before* a removal that this machine currently sees none of its
siblings, and report *after* one that the delete may not have travelled. Without it the UI would
have to show that warning unconditionally, which trains people to ignore it.

Sampling `alone` after the write is a slightly wider window than `committedAlone()`'s sample
inside `unpublishStrand`, and both are approximations of the precise signal (the block's cluster
size). Say so in the doc comment; do not pretend to more.

## Edge cases & interactions

- **Secret leakage.** Assert on the raw response body string that `MemberPrivateKey` and the key
  value itself appear nowhere, for both routes.
- **Ids containing `/`.** `route()` splits the path on `/`, so `strands/a/b` yields a fourth
  segment. Reject `segments.length > 3` with `bad_request` naming the limitation ("strand ids
  containing `/` are not addressable over this channel; use `cadre strand remove`"). Do not try
  to reassemble the id — a half-baked reconstruction is worse than a clear refusal.
- **Blank or whitespace-only id.** `bad_request`, before any read. A blank id would find no row
  and report the reassuring `published: false` when what happened is that the caller sent nothing.
- **Node not attached / not started / no control database.** `not_ready` (503), not `internal`.
  `classifyError` already routes cadre-core's "not initialized"/"not running" messages there;
  the explicit `getControlDatabase() === null` branch needs its own `not_ready` throw.
- **Signer is not an enrolled owner.** `unpublishStrand` throws when the schema's
  `Strand.AuthorizedDelete` rejects the write. That is not `not_ready`, so it classifies as
  `internal` — acceptable, but the node's message must reach the caller intact so an owner sees
  *why*. Assert the message passes through.
- **Rejection does not imply the row survived.** `unpublishStrand`'s own doc warns that the local
  stop runs *after* the control-plane delete has committed, so a throw can sit on top of a
  completed removal. Don't add a "so the strand is still there" claim to the error path.
- **`confirm` on an open strand** is accepted and ignored. Harmless; a caller that always sends
  it is not punished.
- **Query strings on the other routes** must keep working — `route()` already parses via `URL`
  and reads only `pathname`; adding a query read must not change that.
- **Bearer missing/wrong** → 401 on both new routes, like every other route.
- **`GET /admin/strands` with an id** (`/admin/strands/x`) is not a route — `bad_request`.

## TODO

### Phase 1 — cadre-core accessor

- Add `getControlConnectionCount()` to `CadreNode` next to the other read-only accessors
  (`getStrands`, `getControlDatabase`), with the doc comment above naming it a proxy.
- Cross-reference the private `committedAlone()` so the two do not drift apart.

### Phase 2 — admin channel routes

- Widen `AdminErrorCode` with `confirmation_required` and add `428` to `STATUS_BY_CODE`.
- Add the `strands` resource to `AdminServer.route()`: `GET` list, `DELETE` remove.
- Factor the list projection and the remove decision into small named functions rather than
  inlining them in the `route()` if-chain — `route()` is already long.
- Update the class doc comment's route list and the error-code line.

### Phase 3 — tests (`packages/cadre-cli/test/admin-server.spec.ts`)

Drive a real `AdminServer` over a fake node, as the existing spec does:

- `GET /admin/strands` lists a published-but-not-running row alongside a running one, with
  `running`/`status` correct for each.
- The `GET` body contains no `MemberPrivateKey` key and no key value.
- `GET` reports `controlConnections` from the node accessor.
- `GET` on a node with no control database → 503 `not_ready`.
- `DELETE` open strand, no `confirm` → 200, `removed: true`, `unpublishStrand` called once.
- `DELETE` closed strand, no `confirm` → **428 `confirmation_required`**, `unpublishStrand`
  **not** called (this is the security-relevant assertion).
- `DELETE` closed strand, `confirm=1` → 200, called once. Same for `confirm=true`.
- `DELETE` closed strand, `confirm=yes` / `confirm=` / `confirm=0` → 428, not called.
- `DELETE` absent id → 200, `published: false`, `removed: false`, not called.
- `DELETE` blank id and `DELETE /admin/strands/a/b` → 400 `bad_request`.
- `alone: true` when the connection count is 0; `false` when it is non-zero.
- Both routes → 401 without a bearer token.
- A node whose `unpublishStrand` rejects surfaces the rejection message in the envelope.

### Phase 4 — docs

- `docs/cadre-host.md`: add both routes to the `/admin` route table, and add
  `confirmation_required` → 428 to the error-code line above it.
- `docs/architecture.md`: extend the `cadre strand list|remove` paragraph (around line 1334) with
  one sentence that the same read→decide→write and closed-strand gate are now also reachable over
  the node admin channel, so the manager UI enforces the same rule.

### Verification

- `yarn build`
- `yarn lint`
- `yarn dep-check`
- `yarn --cwd packages/cadre-cli test 2>&1 | tee /tmp/cli-test.log`
- `yarn --cwd packages/cadre-core test 2>&1 | tee /tmp/core-test.log`
