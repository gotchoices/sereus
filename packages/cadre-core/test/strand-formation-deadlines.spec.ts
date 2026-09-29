import { describe, it, expect } from 'vitest';
import { formationDeadlines } from '../src/strand-formation-deadlines.js';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from '../src/formation-approval.js';

describe('formationDeadlines', () => {
  it('keeps every layer strictly inside the one above it at any declared link', () => {
    // The ordering the listener and dialer comments call load-bearing — each layer can fail
    // and report before the layer above it gives up — was hand-set numbers before; now it is
    // arithmetic over one declaration, so it has to hold at a fast link, the default, and a
    // link far slower than sereus supports. The approval hook is the flat floor: the work
    // budget must outlast it so a dead hook is reported as such, not as a provisioning timeout.
    for (const linkRoundTripMs of [1, 100, 3500, 10_000]) {
      const d = formationDeadlines(linkRoundTripMs);
      expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBeLessThan(d.provisionWorkMs);
      expect(d.provisionWorkMs).toBeLessThan(d.provisionWorkMs + d.provisionGraceMs);
      expect(d.provisionWorkMs + d.provisionGraceMs).toBeLessThan(d.initiatorAwaitResponseMs);
      expect(d.initiatorAwaitResponseMs).toBeLessThan(d.sessionMs);
      // The responder's whole path, from handler start to the result frame written.
      expect(d.awaitContactMs + d.validationMs + d.provisionWorkMs + d.provisionGraceMs).toBeLessThan(d.sessionMs);
    }
  });
});
