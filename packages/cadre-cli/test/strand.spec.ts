import { describe, it, expect } from 'vitest';
import type { StrandRow } from '@serfab/cadre-core';
import {
  planRemove,
  applyRemove,
  strandCommand,
  type StrandStore,
} from '../src/commands/strands.js';

/**
 * Pins the operator-facing half of `cadre strand`: the read-then-decide logic that turns a
 * `Strand` row into "nothing to do" / "refusing without --yes" / "removed", and the commander
 * wiring those decisions hang off.
 *
 * The node-side write (`unpublishStrand`) is covered against a real control database by
 * `packages/cadre-core/test/strand-unpublish.spec.ts`; here the store is a fake, so what is
 * under test is exactly the branch selection, the `--yes` gate on a closed strand, and the
 * wording an operator reads before destroying a membership key.
 */

const STRAND_ID = 'strand-alpha';

const openRow = (Id = STRAND_ID): StrandRow => ({ Id, MemberPrivateKey: null, Type: 'o' });
const closedRow = (Id = STRAND_ID): StrandRow => ({ Id, MemberPrivateKey: 'secret-key', Type: 'c' });

/** A `StrandStore` over an in-memory map that records every write it is asked to make. */
function fakeStore(initial: StrandRow[] = []): StrandStore & { readonly writes: string[] } {
  const rows = new Map(initial.map((row) => [row.Id, row]));
  const writes: string[] = [];
  return {
    writes,
    queryStrand: async (strandId: string) => rows.get(strandId) ?? null,
    unpublishStrand: async (strandId: string) => {
      writes.push(`unpublish:${strandId}`);
      rows.delete(strandId);
    },
  };
}

describe('planRemove', () => {
  it('plans no write when the strand was never published', () => {
    const plan = planRemove(null, STRAND_ID, {});
    expect(plan.write).toBe(false);
    expect(plan.refuse).toBeFalsy();
    expect(plan.json).toEqual({ strandId: STRAND_ID, published: false, changed: false });
    expect(plan.human).toContain('nothing to do');
  });

  it('says "not published" is only this node\'s view, so it does not read as "does not exist"', () => {
    // Control reads are pull-on-read with no wait; a just-connected one-shot node can miss a
    // row that exists in the party, and exit 0 would otherwise look like proof of absence.
    const warnings = planRemove(null, STRAND_ID, {}).warnings.join(' ');
    expect(warnings).toMatch(/without waiting for sync/i);
  });

  it('plans a write for an open strand without --yes', () => {
    const plan = planRemove(openRow(), STRAND_ID, {});
    expect(plan.write).toBe(true);
    expect(plan.refuse).toBeFalsy();
    expect(plan.json).toEqual({ strandId: STRAND_ID, published: true, type: 'o', changed: true });
    expect(plan.human).toContain('removed');
  });

  it('warns that an open-strand removal is party-wide and may not survive being alone', () => {
    const warnings = planRemove(openRow(), STRAND_ID, {}).warnings.join(' ');
    expect(warnings).toMatch(/party-wide/i);
    expect(warnings).toMatch(/other parties in the strand are unaffected/i);
    expect(warnings).toMatch(/local-only/i);
    // Nothing was destroyed — the closed-strand warning must not leak onto an open one.
    expect(warnings).not.toMatch(/membership key/i);
  });

  it('REFUSES a closed strand without --yes, and writes nothing', () => {
    const plan = planRemove(closedRow(), STRAND_ID, {});
    expect(plan.write).toBe(false);
    expect(plan.refuse).toBe(true);
    expect(plan.json).toEqual({
      strandId: STRAND_ID,
      published: true,
      type: 'c',
      changed: false,
      refused: true,
      reason: 'closed-strand-requires-yes',
    });
  });

  it('names the consequence and the escape hatch when it refuses', () => {
    const human = planRemove(closedRow(), STRAND_ID, {}).human;
    expect(human).toMatch(/membership key/i);
    expect(human).toMatch(/stored nowhere else/i);
    expect(human).toMatch(/--yes/);
  });

  it('plans a write for a closed strand with --yes, and warns the key is unrecoverable', () => {
    const plan = planRemove(closedRow(), STRAND_ID, { yes: true });
    expect(plan.write).toBe(true);
    expect(plan.refuse).toBeFalsy();
    expect(plan.json).toEqual({ strandId: STRAND_ID, published: true, type: 'c', changed: true });
    const warnings = plan.warnings.join(' ');
    expect(warnings).toMatch(/unrecoverable/i);
    expect(warnings).toMatch(/never admit another member/i);
    // The general warnings still apply on top of the closed-strand one.
    expect(warnings).toMatch(/party-wide/i);
  });

  it('does not require --yes for an open strand, so the gate is closed-strand-only', () => {
    expect(planRemove(openRow(), STRAND_ID, { yes: true }).write).toBe(true);
    expect(planRemove(openRow(), STRAND_ID, {}).write).toBe(true);
  });
});

describe('applyRemove', () => {
  it('unpublishes a published open strand exactly once', async () => {
    const store = fakeStore([openRow()]);
    const plan = await applyRemove(store, STRAND_ID, {});
    expect(store.writes).toEqual([`unpublish:${STRAND_ID}`]);
    expect(plan.json.changed).toBe(true);
    expect(await store.queryStrand(STRAND_ID)).toBeNull();
  });

  it('does NOT write when the strand is not published', async () => {
    const store = fakeStore([openRow('other')]);
    const plan = await applyRemove(store, STRAND_ID, {});
    expect(store.writes).toEqual([]);
    expect(plan.json.changed).toBe(false);
  });

  it('does NOT write a closed strand without --yes, leaving the row intact', async () => {
    const store = fakeStore([closedRow()]);
    const plan = await applyRemove(store, STRAND_ID, {});
    expect(store.writes).toEqual([]);
    expect(plan.refuse).toBe(true);
    expect(await store.queryStrand(STRAND_ID)).not.toBeNull();
  });

  it('writes a closed strand once --yes is given', async () => {
    const store = fakeStore([closedRow()]);
    await applyRemove(store, STRAND_ID, { yes: true });
    expect(store.writes).toEqual([`unpublish:${STRAND_ID}`]);
  });

  it('queries and removes the trimmed id, not the raw argument', async () => {
    const store = fakeStore([openRow()]);
    const plan = await applyRemove(store, `\t${STRAND_ID} \n`, {});
    expect(plan.strandId).toBe(STRAND_ID);
    expect(store.writes).toEqual([`unpublish:${STRAND_ID}`]);
  });

  it('rejects a blank id instead of reporting the reassuring "nothing to do"', async () => {
    const store = fakeStore([openRow()]);
    await expect(applyRemove(store, '   ', {})).rejects.toThrow(/strand id is required/i);
    expect(store.writes).toEqual([]);
  });
});

describe('command wiring', () => {
  it('registers list and remove under a `strand` group', () => {
    expect(strandCommand.name()).toBe('strand');
    expect(strandCommand.commands.map((c) => c.name()).sort()).toEqual(['list', 'remove']);
  });

  it('still resolves the documented `strands` name, so the rename breaks no scripts', () => {
    expect(strandCommand.aliases()).toContain('strands');
  });

  it('gives every subcommand the shared config/json/debug options', () => {
    for (const sub of strandCommand.commands) {
      const longs = sub.options.map((o) => o.long);
      expect(longs).toEqual(expect.arrayContaining(['--config', '--json', '--debug']));
      expect(sub.options.find((o) => o.long === '--config')?.defaultValue).toBe('cadre.yaml');
    }
  });

  it('requires a strand id on remove, and none on list', () => {
    const required = (name: string): boolean[] =>
      strandCommand.commands.find((c) => c.name() === name)!
        .registeredArguments.map((a) => a.required);
    expect(required('remove')).toEqual([true]);
    expect(required('list')).toEqual([]);
  });

  it('carries --yes on remove only', () => {
    const longs = (name: string): (string | undefined)[] =>
      strandCommand.commands.find((c) => c.name() === name)!.options.map((o) => o.long);
    expect(longs('remove')).toContain('--yes');
    expect(longs('list')).not.toContain('--yes');
  });

  it('parses --yes as a bare boolean flag, not something taking a value', () => {
    const yes = strandCommand.commands.find((c) => c.name() === 'remove')!
      .options.find((o) => o.long === '--yes')!;
    expect(yes.required).toBe(false);
    expect(yes.optional).toBe(false);
    expect(yes.attributeName()).toBe('yes');
    // Absent until passed — `planRemove` must see `undefined`, not a truthy default.
    expect(yes.defaultValue).toBeUndefined();
  });
});
