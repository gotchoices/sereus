// assert-monotonic-timestamps.js — Verify that the drone-side message list
// has non-decreasing Timestamps.
//
// Reads from flow env: SIDECAR_URL, STRAND_ID

const res = http.get(`${SIDECAR_URL}/messages/${STRAND_ID}`);
if (res.status !== 200) {
	throw new Error(`messages query failed (${res.status}): ${res.body}`);
}

const parsed = json.parse(res.body);
const messages = parsed.messages || [];
let prev = '';
for (let i = 0; i < messages.length; i++) {
	const ts = messages[i].Timestamp;
	if (prev && ts < prev) {
		throw new Error(`Timestamps not monotonic at index ${i}: ${prev} > ${ts}`);
	}
	prev = ts;
}
