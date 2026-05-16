// discover-phone-strand.js — Find the strand the phone created.
//
// After the phone taps "Create Strand", the drone (strandFilter:all) joins
// the phone's strand via control network sync. We poll /status until we see
// a strand whose Id != STRAND_ID (the drone's pre-created strand).
//
// Output: WORKING_STRAND_ID — the strand both nodes share at runtime.
//
// Reads from flow env: SIDECAR_URL, STRAND_ID (drone's pre-created strand)

const deadlineMs = 15000;
const intervalMs = 500;
const start = Date.now();

let found = null;
let lastStrands = [];

while (Date.now() - start < deadlineMs) {
	const res = http.get(`${SIDECAR_URL}/status`);
	if (res.status === 200) {
		const parsed = json.parse(res.body);
		lastStrands = parsed.strands || [];
		for (let i = 0; i < lastStrands.length; i++) {
			if (lastStrands[i].strandId !== STRAND_ID) {
				found = lastStrands[i].strandId;
				break;
			}
		}
	}
	if (found) break;
	const spinUntil = Date.now() + intervalMs;
	while (Date.now() < spinUntil) {
		// noop
	}
}

if (!found) {
	throw new Error(
		`Did not discover phone-created strand within ${deadlineMs}ms. ` +
		`Drone strands: ${json.stringify(lastStrands)}`,
	);
}

output.WORKING_STRAND_ID = found;
