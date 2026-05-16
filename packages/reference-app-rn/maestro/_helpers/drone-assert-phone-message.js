// drone-assert-phone-message.js — Polls the drone sidecar for a phone-sent
// message to appear in the strand DB.  Verifies phone→drone replication.
//
// Reads from per-step env: EXPECT_CONTENT
// Reads from flow env: SIDECAR_URL, STRAND_ID

const deadlineMs = 5000;
const intervalMs = 500;
const start = Date.now();

let found = false;
let lastBody = '';
let lastStatus = 0;

while (Date.now() - start < deadlineMs) {
	const res = http.get(`${SIDECAR_URL}/messages/${STRAND_ID}`);
	lastStatus = res.status;
	lastBody = res.body;
	if (res.status === 200) {
		const parsed = json.parse(res.body);
		const messages = parsed.messages || [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].Content === EXPECT_CONTENT) {
				found = true;
				break;
			}
		}
	}
	if (found) break;
	// Busy-wait — Maestro GraalJS has no setTimeout, so spin with a HTTP gap.
	const spinUntil = Date.now() + intervalMs;
	while (Date.now() < spinUntil) {
		// noop
	}
}

if (!found) {
	throw new Error(
		`Drone never saw phone message "${EXPECT_CONTENT}" within ${deadlineMs}ms (last status ${lastStatus}, body: ${lastBody.slice(0, 200)})`,
	);
}
