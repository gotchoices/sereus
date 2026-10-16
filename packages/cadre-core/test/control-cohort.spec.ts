import { describe, it, expect } from 'vitest';
import { selectControlCohortDials } from '../src/control-cohort.js';
import type { CohortPeerRow } from '../src/strand-cohort.js';
import type { NodeProfile } from '../src/types.js';

function row(peerId: string, profile: NodeProfile | null): CohortPeerRow {
  return { peerId, multiaddr: null, profile };
}

describe('selectControlCohortDials', () => {
  it('dials every always-on sibling past the degree cap and fills the rest up to it in peer id order', () => {
    // A phone and a sibling that has not published a profile yet are both non-backbone.
    const siblings = [
      row('phone-c', 'transaction'),
      row('server-b', 'storage'),
      row('unpublished-a', null),
      row('server-a', 'storage'),
      row('phone-b', 'transaction'),
    ];

    const sel = selectControlCohortDials(siblings, 1);

    expect(sel.dials.map((d) => d.peerId)).toEqual(['server-a', 'server-b', 'phone-b']);
    expect(sel.cappedNonBackbone).toBe(2);
  });

  it('is deterministic across input orderings (stable backbone + fill)', () => {
    const siblings = [
      row('e', 'transaction'), row('a', 'storage'), row('d', null),
      row('b', 'transaction'), row('f', 'storage'), row('c', 'transaction'),
    ];

    const a = selectControlCohortDials(siblings, 2);
    const b = selectControlCohortDials([...siblings].reverse(), 2);

    expect(a.dials.map((d) => d.peerId)).toEqual(b.dials.map((d) => d.peerId));
    expect(a.cappedNonBackbone).toBe(b.cappedNonBackbone);
  });

  it('treats a negative targetDegree as zero (backbone-only)', () => {
    const sel = selectControlCohortDials([row('server', 'storage'), row('phone', 'transaction')], -5);
    expect(sel.dials.map((d) => d.peerId)).toEqual(['server']);
    expect(sel.cappedNonBackbone).toBe(1);
  });
});
