import { describe, it, expect } from 'vitest';
import { NODE_ROLE_PRESETS, resolveNodeRoles, type NodeRoles } from '../src/node-roles.js';
import type { NodeClass } from '../src/node-class.js';

/**
 * **What this protects: the one mapping from a node class to what the node does.**
 *
 * Every consumer — the FRET tier, Ring Zulu, the relay-server default, the published
 * `CadrePeer.Profile`, the storage-replica default and the cohort-topic host profile — reads the
 * resolved roles and nothing else, so this resolution is the only branching behind all of them.
 * Two properties have to hold: a role left unset takes its preset's value, and a role that is
 * misnamed or set outside its own set throws instead of resolving to the preset (a config typo
 * must not quietly leave a node doing the opposite of what was asked for).
 *
 * The wiring from here into each build site is pinned beside that site
 * (`cadre-node-control-node-options.spec.ts`, `strand-instance-manager-*.spec.ts`,
 * `relay-server.spec.ts`, `strand-reactivity.spec.ts`), not here.
 */
describe('resolveNodeRoles', () => {
  it.each<[NodeClass, NodeRoles]>([
    ['device', { alwaysOn: false, overlayTier: 'edge', reactivity: 'forwarder', strandCohortMember: true }],
    ['server', { alwaysOn: true, overlayTier: 'core', reactivity: 'forwarder', strandCohortMember: true }]
  ])('%s with no overrides is its preset', (nodeClass, expected) => {
    expect(resolveNodeRoles(nodeClass)).toEqual(expected);
    expect(resolveNodeRoles(nodeClass, {})).toEqual(expected);
  });

  it.each<[string, NodeClass, Partial<NodeRoles>, Partial<NodeRoles>]>([
    ['a device told it is always on', 'device', { alwaysOn: true }, { alwaysOn: true, overlayTier: 'edge' }],
    ['a server told it is not', 'server', { alwaysOn: false }, { alwaysOn: false, overlayTier: 'core' }],
    ['a server held at the edge tier', 'server', { overlayTier: 'edge' }, { overlayTier: 'edge', alwaysOn: true }],
    ['a device raised to the core tier', 'device', { overlayTier: 'core' }, { overlayTier: 'core', alwaysOn: false }],
    ['a phone that only receives notifications', 'device', { reactivity: 'subscriber' }, { reactivity: 'subscriber' }],
    ['strand cohort membership stated explicitly', 'device', { strandCohortMember: true }, { strandCohortMember: true }],
    ['a role present as undefined keeps the preset', 'server', { overlayTier: undefined }, { overlayTier: 'core' }]
  ])('%s', (_label, nodeClass, overrides, expected) => {
    expect(resolveNodeRoles(nodeClass, overrides)).toEqual({ ...NODE_ROLE_PRESETS[nodeClass], ...expected });
  });

  // Values a JavaScript embedder can hand in untyped, from a config file or an environment
  // variable; cast through `unknown` because TypeScript would refuse them at the call. One row
  // per REJECTION, not per role: the two string roles share `checkedOneOf` and the two boolean
  // roles share `checkedBoolean`, so a second role through the same checker proves nothing.
  it.each<[string, Partial<NodeRoles>]>([
    ['a string role outside its set', { overlayTier: 'fast' } as unknown as Partial<NodeRoles>],
    ['a string role that is not a string', { overlayTier: null } as unknown as Partial<NodeRoles>],
    ['a boolean role as the string \'true\'', { alwaysOn: 'true' } as unknown as Partial<NodeRoles>]
  ])('%s throws', (_label, overrides) => {
    expect(() => resolveNodeRoles('device', overrides)).toThrow(/^Invalid roles\./);
  });

  // A key typo is the likelier half of the same failure the rows above cover: TypeScript catches
  // it in an object literal, nothing catches it in a config file.
  it('a misnamed role throws rather than resolving to the preset', () => {
    expect(() => resolveNodeRoles('device', { alwaysON: true } as unknown as Partial<NodeRoles>))
      .toThrow(/^Unknown roles 'alwaysON'/);
  });

  it('an unknown node class throws rather than resolving to nothing', () => {
    expect(() => resolveNodeRoles('drone' as unknown as NodeClass)).toThrow(/Unknown nodeClass/);
  });
});
