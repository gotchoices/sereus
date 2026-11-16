description: Every node offers a "member enrollment service" that can never enroll a member, because it is built without the two parts it needs and gives no way to add them; a developer who finds it and calls it gets a quiet refusal.
architecture: docs/api.md#enrollmentservice-and-member-registration
files: packages/cadre-core/src/cadre-node.ts (`getEnrollmentService`, the `enrollmentService` field and its construction), packages/cadre-core/src/enrollment.ts (`EnrollmentService`), packages/cadre-core/test/cadre-node.spec.ts, docs/api.md
difficulty: easy
tradeoffs: The accessor is harmless and the API guide now warns about it, so removing it is tidiness that touches a public method and a test for no change in behaviour.
----

# `CadreNode.getEnrollmentService()` returns a service that cannot register a member

`CadreNode`'s constructor builds `new EnrollmentService()` with no options and `getEnrollmentService()` returns it, under the comment "Get the enrollment service for adding new peers".

`EnrollmentService.registerMember` and `validateMemberRegistration` need a `memberVerifier` and a `memberRegistry`. Both are constructor options stored in `readonly` fields, so the instance the node returns can never be given them. Its `registerMember` always resolves `{ success: false, reason: 'MemberVerifier not configured' }`. It does not throw, so a caller that does not inspect the result believes a member was registered.

The one method that works on that instance is `createCadrePeer()`, which generates a node identity key pair and uses no state of the service or the node. cadre-cli calls it on a service it constructs itself (`commands/init.ts`, `commands/enroll.ts`). Nothing in any package's `src` calls `getEnrollmentService()`; its only caller is one case in `cadre-node.spec.ts`.

A working service is built over one strand's database, as `docs/api.md` → "`EnrollmentService` and member registration" shows (`new EnrollmentService({ memberVerifier: new StrandMemberVerifier(db), memberRegistry: new StrandMemberRegistry(db, …) })`), and the node's own joins do not go through the service at all.

## Wanted

The node stops offering an instance that cannot do what its name says. The plain form is to remove `getEnrollmentService()` and the field, and let `createCadrePeer` be reached as a function or through a service the caller constructs. If an accessor is kept, it takes the strand id and returns a service wired to that strand's database, or it is renamed for the one thing it does.

A refusal for missing configuration that is returned as an ordinary result, where the caller's mistake is a programming error, is a second thing to settle in `EnrollmentService` itself: throwing would make the mistake visible.
