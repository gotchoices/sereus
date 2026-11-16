# Formation approval hook

A formation invitation may carry a `validationUrl`: an HTTP endpoint run by an approver outside the party, which is asked whether one particular redemption may proceed. This document specifies the contract that endpoint implements and what the inviting party sets up to use it. It is for whoever writes or operates an approver service, in any language.

Related: [strand formation](strands/formation.md) · [cadre-core API guide](api.md) · [cadre-cli README](../packages/cadre-cli/README.md) for the `cadre validation-key` commands · [glossary](concepts.md#glossary)

## Enrolling an approver

The inviting party's node calls the hook, never the joiner, so the answer reaches the row the party writes without passing through the joiner. [The formation protocol](strands/formation.md#the-formation-protocol) says where the call falls in a redemption.

To use a hook, an owner enrolls the approver's public key with `enrollValidationKey(key)` and publishes the invitation with `validationUrl` set; `removeValidationKey(key)` and `listValidationKeys()` complete the set. Enroll before handing out invitations: a machine that the enrollment has not replicated to refuses the redemption. To replace a key, enroll the new one and then remove the old one. Removing a key does not undo joins it already approved.

`@serfab/cadre-core` exports the client the node uses (`createHttpFormationApprover`), the signing helpers (`signFormationApproval`, `verifyFormationApproval`) and `FormationApprovalError`.

## Request

The node sends `POST <validationUrl>` with `content-type: application/json` and `accept: application/json`. The body is exactly the five fields the approver signs. No owner keys, addresses or membership keys are sent.

```json
{
	"token": "the invitation token",
	"usageStampId": "the single-use nonce of this redemption, chosen by the joiner",
	"strandId": "the strand being joined",
	"peerKey": "base64url Ed25519 public key of the joiner",
	"disclosure": "the text that will be stored as the redemption's disclosure"
}
```

`peerKey` is the joiner's membership key for this strand, generated for this formation. The same joiner presents a different key for every strand, so a hook that keeps an allow-list must match on something in `disclosure`. The joiner has signed its consent over the same nonce, which proves that the holder of `peerKey` asked to join.

## Response

Approve with status `200` and this body:

```json
{ "validationKey": "base64url Ed25519 public key", "validationSignature": "base64url signature" }
```

The signature covers the five request fields, so it authorizes that one redemption only. In TypeScript, produce it with `signFormationApproval`. In another language, build the same bytes as `formationVouchMessage` in [`control-database.ts`](../packages/cadre-core/src/control-database.ts). Sign the `disclosure` string exactly as received, without re-serializing it.

## Outcomes

The node classifies the hook's answer by HTTP status first, so a `403` with a well-formed approval in its body is still a refusal. The joiner does not see the failure category, only the [formation rejection code](strands/formation.md#formation-rejection-codes) the node maps it to. Of the three codes only `approval-unavailable` is retryable.

| Hook answer | `FormationApprovalError.failure` | Code the joiner receives |
| --- | --- | --- |
| `200` with both fields present and not blank | none: approval | none |
| `401` or `403`, whatever the body | `refused` | `approval-refused` |
| Any other non-2xx status, a network error, a timeout, a redirect | `unavailable` | `approval-unavailable` |
| A 2xx response that is not a JSON object, lacks a field or has a blank one, or is larger than 64 KiB | `malformed` | `approval-invalid` |
| An approval whose `validationKey` is not enrolled | `unenrolled` | `approval-invalid` |
| A `validationUrl` that is not `http:` or `https:`, or a runtime with no `fetch` | `misconfigured` | `approval-invalid` |

None of these records a use, so a rejected redemption does not consume the invitation and the same token can be presented again.

## Limits

- **Disclosure size.** `disclosure` is at most 8 KiB of UTF-8. A larger one is rejected (`disclosure-too-large`) before the hook is called.
- **Time.** The node abandons the whole exchange, body included, after 10 seconds by default (`createHttpFormationApprover({ timeoutMs })`).
- **Redirects.** The node does not follow redirects. Publish a new invitation with the new URL when a hook moves.

## A hook in TypeScript

```ts
import express from 'express';
import { signFormationApproval, type FormationVouchFields } from '@serfab/cadre-core';

// The approver's Ed25519 seed and public key, base64url. The public key must be enrolled
// with enrollValidationKey in the inviting party's cadre.
const privateKey = process.env['APPROVER_KEY']!;
const validationKey = process.env['APPROVER_PUBLIC_KEY']!;

express().use(express.json()).post('/approve', (req, res) => {
	// FormationVouchFields is the posted body: the five signed fields.
	const fields = req.body as FormationVouchFields;

	if (!mayJoin(fields.disclosure)) {
		res.status(403).json({ error: 'not on the roster' });
		return;
	}

	res.json(signFormationApproval(fields, validationKey, privateKey));
}).listen(8080);
```

`mayJoin` is the approver's own decision.

## Limits and accepted tradeoffs

- **Plain HTTP.** `http:` is accepted for a hook on a local network, but it sends the disclosure unencrypted. Use `https:` for a hook reached over the internet.
- **The hook can redeem the invitation.** It receives the invitation token, a bearer credential, so its operator could redeem the invitation instead of approving the joiner. An enrolled approver can already admit anyone, so this adds no new trust, but a hook is the party's infrastructure and not a public endpoint.
