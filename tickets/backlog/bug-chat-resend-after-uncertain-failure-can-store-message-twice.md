description: In both reference chat apps, sending a message again after a send that failed with an uncertain outcome can post the same message twice, because each send gets a brand-new message id.
files:
  - packages/reference-app-web/src/lib/chat-dml.ts (~46–61, `crypto.randomUUID()` at ~55)
  - packages/reference-app-web/src/lib/cadre-web.ts (~916, `writeChatMessage`)
  - packages/reference-app-rn/src/chat-operations.ts (~130–158, `uuid()` at ~144)
  - packages/reference-app-rn/app/index.tsx (~36–46, draft cleared before send)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: These are reference apps, the failure needs a write that fails and may still land (a torn write the library cannot settle, or a lost commit response), and the fix changes how the UI holds its draft, so a maintainer may reasonably defer it behind real product work.
----

# A resent chat message can be stored twice

Each chat send inserts an `App.Message` row keyed by a fresh random id minted inside the send call: `crypto.randomUUID()` in the web app, `uuid()` in the React Native app. Neither app retries automatically. The web app keeps the typed text on failure so the user can press Send again. The React Native app clears the draft before sending, so a failed message is lost and the user re-types it.

The database library can report a failed write whose outcome is unknown. Optimystic's `TornActionError` with `final: false` means "the write may already be saved, or may land later", and a commit whose response was lost is similar. If the first send actually landed, the user's resend gets a new id, and the chat now shows the message twice. Nothing in the primary key can catch it.

Expected: resending the same draft cannot create a second row. One shape that would do it: mint the message id when the draft is created, keep it with the draft across failed sends, and treat a primary-key conflict on resend as "already sent". The React Native app would also need to keep the draft until the send succeeds. The UI may also want to say "may already have been sent" when the failure is the uncertain kind.

Found by the fix pass of `degraded-cohort-rerun-after-upstream-dead-pend-fix` while checking whether any sereus code re-submits strand writes. The automatic strand-write re-runs (membership reconciler, strand-watcher relaunch) are safe because their rows are keyed deterministically. The chat sends are the only strand writes a user re-submits by hand. To confirm it, make a send throw after its commit lands (for example, a test double that commits and then rejects), resend, and count the rows.
