// drone-insert.js — POST a message to the drone sidecar.
// Reads from per-step env: CONTENT, MEMBER_ID
// Reads from flow env: SIDECAR_URL, STRAND_ID

const url = `${SIDECAR_URL}/message/insert`;
const body = json.stringify({
	strandId: STRAND_ID,
	memberId: MEMBER_ID,
	content: CONTENT,
});

const res = http.post(url, {
	headers: { 'Content-Type': 'application/json' },
	body,
});

if (res.status !== 200) {
	throw new Error(`drone-insert failed (${res.status}): ${res.body}`);
}

const parsed = json.parse(res.body);
output.LAST_INSERT_ID = String(parsed.message.Id);
