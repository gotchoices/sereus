# reference-app-ns Maestro flows

This folder holds no flow files. `scripts/run-e2e.mjs` runs the React Native app's flows, in `packages/reference-app-rn/maestro/`, against the NativeScript app, changing only the application id. The folder receives the run's log and report.

The requirements for a run, the shared setup and how to read a failed run are in [Maestro flows](../../../docs/contributing/device-testing.md#maestro-flows).

## Invoking

```bash
yarn workspace @serfab/reference-app-ns test:e2e
```

It needs the app built and installed on a running Android emulator (`yarn workspace @serfab/reference-app-ns android`), and `adb` and the Maestro CLI on `PATH`. The optional environment variables are listed in the [package README](../README.md#environment-variables).

The script does the following:

1. Starts the React Native package's test drone, `../reference-app-rn/test-fixture/start.mjs`, with that package as its working directory.
2. Waits up to 30 seconds for the drone's HTTP sidecar to answer `GET /health` on port 4080.
3. Reads `../reference-app-rn/test-fixture/test-data.json`, which the drone wrote. It holds `strandId` (a strand the drone created), `ownerGrant` and `cadreInvitation`.
4. Runs `adb reverse` for ports 4002 and 4080, so the emulator reaches the drone on the host.
5. Runs `maestro test` over `../reference-app-rn/maestro/flows/`, passing `JOIN_CODE` (the machine invitation), `STRAND_ID`, `SIDECAR_URL` and `MAESTRO_APP_ID` with `-e`. It also passes `PARTY_ID` and `BOOTSTRAP_ADDR`, which no flow reads and which carry the text `undefined`, because the drone writes no such fields.
6. Stops the drone and removes the `adb reverse` rules.

To run one flow without the script or the drone:

```bash
maestro test -e MAESTRO_APP_ID=org.gotchoices.sereus.chat.ns \
  ../reference-app-rn/maestro/flows/4-solo-create-strand.yaml
```

## The flows

| Flow | What it does | Against this app |
|---|---|---|
| `1-connect-and-send.yaml` | runs `_setup.yaml`, sends a message, expects to see it | cannot pass |
| `2-drone-to-phone.yaml` | runs `_setup.yaml`; the drone inserts a message through its sidecar; expects it on the phone within 5 seconds | cannot pass |
| `3-round-trip.yaml` | runs `_setup.yaml`; checks a message in each direction and that the drone's timestamps increase | cannot pass |
| `4-solo-create-strand.yaml` | no drone: connects alone, taps Create Chat Strand, expects "Strand created" within 60 seconds | uses only elements this app has |

`_setup.yaml` launches the app with cleared state, joins the drone's cadre, creates a strand, waits for the drone to report that strand (`_helpers/discover-phone-strand.js`) and returns to Chat. The helpers under `_helpers/` talk to the drone's sidecar.

## Limits

- **Flows 1 to 3 cannot pass against this app.** `_setup.yaml` follows the React Native app's screens. It waits for the first-launch join button (`btn-first-launch-join`) and the join result (`text-join-flow`, `btn-join-flow-ok`), which this app does not have; this app shows its join field only after Connect. It returns to Chat by tapping the tab label "Chat", and this app has no tabs. It ends by asserting `chat-strand-label`, which this app's Chat page does not render. The script runs the whole flow directory, so a full run reports those three as failed. (ticket `debt-ns-maestro-flow-parity-gaps`)
- **Element ids are exposed differently.** The flows select elements with Maestro's `id:` selector. This app sets each id from `src/test-ids.ts` as `automationText`, which Android reports as the content description and iOS as the accessibility identifier, where React Native sets `testID`. Whether `id:` matches these on a NativeScript build is not established.
- **The join credential is a machine invitation.** The React Native run passes the drone's owner grant as `JOIN_CODE`; this app's join field takes no owner grant. (ticket `feat-reference-app-ns-owner-grant-join`)

## Giving this app its own flows

Copy `_setup.yaml`, `_helpers/` and `flows/` from `packages/reference-app-rn/maestro/` into this folder and point `FLOWS_DIR` in `scripts/run-e2e.mjs` at the copy. The drone and its sidecar have no React Native dependency and can stay shared.

## Artifacts

Both are ignored by git.

- `.fixture.log`: the drone's output.
- `.maestro-junit.xml`: Maestro's JUnit report.
