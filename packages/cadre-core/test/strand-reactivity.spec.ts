import { describe, it, expect } from 'vitest';
import { strandCohortTopicOption, type StrandReactivityConfig } from '../src/strand-reactivity.js';

/**
 * Only the three enabling shapes may put a `cohortTopic` key on a strand node's options, and
 * every other shape must leave the key out entirely — not `{ enabled: false }` — so db-p2p
 * builds the node exactly as it does with no option. Shapes a JS embedder could hand in
 * untyped are cast through `unknown`; they must fail closed.
 */
describe('strandCohortTopicOption', () => {
  const strandId = 'strand-a';
  const on = { cohortTopic: { enabled: true } };

  it.each<[string, StrandReactivityConfig | undefined, typeof on | Record<string, never>]>([
    ['enabled, strandIds absent: every strand', { enabled: true }, on],
    ['enabled, strandIds empty: every strand', { enabled: true, strandIds: [] }, on],
    ['enabled, strandIds names this strand', { enabled: true, strandIds: ['other', strandId] }, on],
    ['enabled, strandIds names other strands only', { enabled: true, strandIds: ['other', 'strand-a2'] }, {}],
    ['config absent', undefined, {}],
    ['enabled: false', { enabled: false }, {}],
    ['enabled: false with this strand named', { enabled: false, strandIds: [strandId] }, {}],
    ['enabled as the string \'true\'', { enabled: 'true' } as unknown as StrandReactivityConfig, {}],
    ['enabled as 1', { enabled: 1 } as unknown as StrandReactivityConfig, {}],
    ['strandIds present but not an array', { enabled: true, strandIds: strandId } as unknown as StrandReactivityConfig, {}],
    ['strandIds null', { enabled: true, strandIds: null } as unknown as StrandReactivityConfig, {}]
  ])('%s', (_label, config, expected) => {
    const result = strandCohortTopicOption(config, strandId);
    expect(result).toEqual(expected);
    expect('cohortTopic' in result).toBe(expected === on);
  });
});
