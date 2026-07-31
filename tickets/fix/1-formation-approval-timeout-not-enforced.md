description: When an outside approval service accepts a connection and then goes silent, our node is supposed to give up after ten seconds — but occasionally it waits five minutes instead, because the cancellation it sends is sometimes ignored by the networking layer. A single stalled or hostile approval service can therefore hold up someone joining for far longer than intended.
files: packages/cadre-core/src/formation-approval.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/integration-tests/test/formation-approval-real-fetch.spec.ts
difficulty: medium
----

# The approval client's timeout is not actually a bound

## What happens

`createHttpFormationApprover()` (`packages/cadre-core/src/formation-approval.ts`) enforces its
`timeoutMs` budget in exactly one way: it starts a timer and calls `AbortController.abort()` when
the timer fires, then trusts `fetch` to reject. Against Node's real `fetch` (undici) that trust is
misplaced. When the abort lands while the response *body* is being read, the abort is sometimes
dropped: the pending read neither rejects nor resolves. It stays pending until undici's own
300-second body timeout fires, and only then rejects with `TypeError: terminated`.

Measured on win32 / Node v24.2.0, no Sereus code in the loop (raw `fetch`, see repro below):
roughly 1 occurrence per 100–150 attempts standalone; abort fired at 59 ms, the read settled at
306,850 ms.

Consequence: a hook that accepts the connection, sends headers, and then goes quiet can hold a
formation responder for ~5 minutes on a 10-second budget. The client's own comments state the
opposite guarantee ("Abort the request after this long, INCLUDING the body read", "a hook that
stalls must not stall formation"), and the responder's provisioning budget is sized against it.
The same weakness applies to the caller's cancellation signal, which is relayed through the same
`AbortController`.

## Expected behavior

`requestApproval` must reject with an `unavailable` `FormationApprovalError` no later than
roughly `timeoutMs` after the request starts, whatever the runtime's `fetch` does with the abort —
and likewise must reject promptly when the caller's `signal` aborts. Aborting the request stays
necessary (it releases the socket), but it can no longer be the only thing standing between a
silent hook and an unbounded wait. Whatever is left behind by a `fetch` that never settles must
not leak a live timer or a checked-out connection.

Constraint from the existing design: this client commits to global `fetch` + `AbortController`
only, no `node:` imports and no `AbortSignal.any` — it runs in browsers and React Native as well
as Node, so any fix has to stay on that footing.

## How it was found

`packages/integration-tests/test/formation-approval-real-fetch.spec.ts` (added by
`debt-formation-approval-real-fetch-coverage`) drives the client against a real `node:http` server
with the real `globalThis.fetch`. Its case *"times out a real socket that answers headers and then
never sends a body"* fails roughly 1 whole-file run in 10, as a 60-second vitest timeout. That
test is correct and asserts the intended contract — **it must not be skipped, loosened, or given a
longer timeout to make it green.** It goes deterministic once this defect is fixed. It is recorded
in `tickets/.pre-existing-known.md` pointing at this ticket so nobody re-triages it.

The stub-based suite (`packages/cadre-core/test/formation-approval.spec.ts`) cannot see this: its
`fetchImpl` stub rejects on abort by construction.

## Repro (no Sereus code)

Node script; prints a `LATE rejection ... elapsed=306850ms` line when it hits the race. Expect to
run a few hundred rounds.

```js
import { createServer } from 'node:http';

function startServer() {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.flushHeaders(); // headers only, then silence
		});
		const sockets = new Set();
		server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
		server.listen(0, '127.0.0.1', () => resolve({
			url: `http://127.0.0.1:${server.address().port}/hook`,
			close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); })
		}));
	});
}

for (let i = 0; i < 400; i++) {
	const server = await startServer();
	const controller = new AbortController();
	const t0 = Date.now();
	const timer = setTimeout(() => controller.abort(), 50);
	let phase = 'fetch';
	try {
		const response = await fetch(server.url, { method: 'POST', body: '{}', signal: controller.signal });
		phase = 'read';
		await response.body.getReader().read();
	} catch (error) {
		const elapsed = Date.now() - t0;
		if (elapsed > 1_000) console.log(`round ${i}: LATE phase=${phase} elapsed=${elapsed}ms ${error.name}: ${error.message}`);
	} finally {
		clearTimeout(timer);
		await server.close();
	}
}
```

## Coverage this needs

- A test that pins the bound without depending on the race actually occurring — i.e. one that
  drives the client with a `fetchImpl` whose response body never settles and never honours the
  abort at all, and asserts the client still rejects `unavailable` within its budget. That case is
  deterministic and belongs in the stub suite; today's stub always rejects on abort, so it proves
  nothing about this path.
- The same for a caller `signal` abort that the fetch implementation ignores.
- The real-fetch case in `formation-approval-real-fetch.spec.ts` should stop being intermittent —
  worth re-running that file ~20 times after the fix rather than once.
