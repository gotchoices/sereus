import { describe, it, expect } from 'vitest';
import { selectControlCohortDials } from '../src/control-cohort.js';
import type { ControlCohortSibling } from '../src/control-cohort.js';

function row(peerId: string, alwaysOn: boolean | null): ControlCohortSibling {
  return { peerId, multiaddr: null, alwaysOn };
}

describe('selectControlCohortDials', () => {
  it('dials every always-on sibling past the degree cap and fills the rest up to it in peer id order', () => {
    // A phone and a sibling that has not published its class yet are both non-backbone.
    const siblings = [
      row('phone-c', false),
      row('server-b', true),
      row('unpublished-a', null),
      row('server-a', true),
      row('phone-b', false),
    ];

    const sel = selectControlCohortDials(siblings, 1);

    expect(sel.dials.map((d) => d.peerId)).toEqual(['server-a', 'server-b', 'phone-b']);
    expect(sel.cappedNonBackbone).toBe(2);
  });

  it('is deterministic across input orderings (stable backbone + fill)', () => {
    const siblings = [
      row('e', false), row('a', true), row('d', null),
      row('b', false), row('f', true), row('c', false),
    ];

    const a = selectControlCohortDials(siblings, 2);
    const b = selectControlCohortDials([...siblings].reverse(), 2);

    expect(a.dials.map((d) => d.peerId)).toEqual(b.dials.map((d) => d.peerId));
    expect(a.cappedNonBackbone).toBe(b.cappedNonBackbone);
  });

  it('treats a negative targetDegree as zero (backbone-only)', () => {
    const sel = selectControlCohortDials([row('server', true), row('phone', false)], -5);
    expect(sel.dials.map((d) => d.peerId)).toEqual(['server']);
    expect(sel.cappedNonBackbone).toBe(1);
  });
});
