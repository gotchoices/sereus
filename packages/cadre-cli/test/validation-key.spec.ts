import { describe, it, expect } from 'vitest';
import {
  planAdd,
  planRemove,
  formatKeyList,
  applyAdd,
  applyRemove,
  validationKeyCommand,
  type ValidationKeyStore,
} from '../src/commands/validation-key.js';

/**
 * Pins the operator-facing half of `cadre validation-key`: the read-then-decide logic that
 * turns the enrolled set into "already enrolled" / "nothing to do" / "that was the last key",
 * and the commander wiring those decisions hang off.
 *
 * The node-side writes (`enrollValidationKey` / `removeValidationKey` / `listValidationKeys`)
 * are covered against a real control database by
 * `packages/cadre-core/test/validation-key-enrollment.spec.ts`; here the store is a fake, so
 * what is under test is exactly the branch selection and the wording an operator reads.
 */

const KEY_A = 'aaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaa';
const KEY_B = 'bbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbb';

/** A `ValidationKeyStore` over an in-memory set that records every write it is asked to make. */
function fakeStore(initial: string[] = []): ValidationKeyStore & { readonly writes: string[] } {
  const keys = new Set(initial);
  const writes: string[] = [];
  return {
    writes,
    listValidationKeys: async () => [...keys].sort(),
    enrollValidationKey: async (key: string) => {
      writes.push(`enroll:${key}`);
      keys.add(key);
    },
    removeValidationKey: async (key: string) => {
      writes.push(`remove:${key}`);
      keys.delete(key);
    },
  };
}

describe('planAdd', () => {
  it('plans a write when the key is absent', () => {
    const plan = planAdd([KEY_B], KEY_A);
    expect(plan.write).toBe(true);
    expect(plan.json).toEqual({ key: KEY_A, enrolled: true, changed: true });
    expect(plan.human).toContain('enrolled');
    expect(plan.warnings).toEqual([]);
  });

  it('plans no write when the key is already enrolled', () => {
    const plan = planAdd([KEY_A], KEY_A);
    expect(plan.write).toBe(false);
    expect(plan.json).toEqual({ key: KEY_A, enrolled: true, changed: false });
    expect(plan.human).toContain('already enrolled');
  });

  it('trims the key, so surrounding whitespace does not read as a different key', () => {
    // The node trims before writing; if the plan did not, ` KEY ` would miss the
    // already-enrolled branch and then fail on the primary-key constraint instead.
    const plan = planAdd([KEY_A], `  ${KEY_A}\n`);
    expect(plan.key).toBe(KEY_A);
    expect(plan.write).toBe(false);
  });
});

describe('planRemove', () => {
  it('plans no write when the key was never enrolled', () => {
    const plan = planRemove([KEY_B], KEY_A);
    expect(plan.write).toBe(false);
    expect(plan.json).toEqual({ key: KEY_A, enrolled: false, changed: false });
    expect(plan.human).toContain('nothing to do');
    expect(plan.warnings).toEqual([]);
  });

  it('plans a write with no warning while other keys remain', () => {
    const plan = planRemove([KEY_A, KEY_B], KEY_A);
    expect(plan.write).toBe(true);
    expect(plan.json).toEqual({ key: KEY_A, enrolled: false, changed: true, wasLastKey: false });
    expect(plan.warnings).toEqual([]);
  });

  it('warns when the removal empties the enrolled set', () => {
    const plan = planRemove([KEY_A], KEY_A);
    expect(plan.write).toBe(true);
    expect(plan.json.wasLastKey).toBe(true);
    expect(plan.warnings.join(' ')).toMatch(/last enrolled approver key/i);
    expect(plan.warnings.join(' ')).toMatch(/add-then-remove/i);
  });

  it('trims the key before deciding', () => {
    const plan = planRemove([KEY_A], ` ${KEY_A} `);
    expect(plan.key).toBe(KEY_A);
    expect(plan.write).toBe(true);
  });
});

describe('formatKeyList', () => {
  it('states the empty set rather than printing nothing', () => {
    expect(formatKeyList([])).toBe('No approver keys enrolled.');
  });

  it('prints one key per line', () => {
    expect(formatKeyList([KEY_A, KEY_B])).toBe(`${KEY_A}\n${KEY_B}`);
  });
});

describe('applyAdd', () => {
  it('enrolls a new key exactly once', async () => {
    const store = fakeStore();
    const plan = await applyAdd(store, KEY_A);
    expect(store.writes).toEqual([`enroll:${KEY_A}`]);
    expect(plan.json.changed).toBe(true);
    expect(await store.listValidationKeys()).toEqual([KEY_A]);
  });

  it('does NOT write when the key is already enrolled', async () => {
    const store = fakeStore([KEY_A]);
    const plan = await applyAdd(store, KEY_A);
    expect(store.writes).toEqual([]);
    expect(plan.json.changed).toBe(false);
  });

  it('writes the trimmed key, not the raw argument', async () => {
    const store = fakeStore();
    await applyAdd(store, `\t${KEY_A} `);
    expect(store.writes).toEqual([`enroll:${KEY_A}`]);
  });
});

describe('applyRemove', () => {
  it('removes an enrolled key and reports it was the last one', async () => {
    const store = fakeStore([KEY_A]);
    const plan = await applyRemove(store, KEY_A);
    expect(store.writes).toEqual([`remove:${KEY_A}`]);
    expect(plan.json.wasLastKey).toBe(true);
    expect(await store.listValidationKeys()).toEqual([]);
  });

  it('does NOT write when the key is not enrolled', async () => {
    const store = fakeStore([KEY_B]);
    const plan = await applyRemove(store, KEY_A);
    expect(store.writes).toEqual([]);
    expect(plan.json.changed).toBe(false);
    expect(await store.listValidationKeys()).toEqual([KEY_B]);
  });
});

describe('command wiring', () => {
  const subcommands = validationKeyCommand.commands.map(c => c.name());

  it('registers add, remove and list', () => {
    expect(subcommands.sort()).toEqual(['add', 'list', 'remove']);
  });

  it('gives every subcommand the shared config/json/debug options', () => {
    for (const sub of validationKeyCommand.commands) {
      const longs = sub.options.map(o => o.long);
      expect(longs).toEqual(expect.arrayContaining(['--config', '--json', '--debug']));
      expect(sub.options.find(o => o.long === '--config')?.defaultValue).toBe('cadre.yaml');
    }
  });

  it('requires a key argument on add and remove, and none on list', () => {
    const required = (name: string): boolean[] =>
      validationKeyCommand.commands.find(c => c.name() === name)!
        .registeredArguments.map(a => a.required);
    expect(required('add')).toEqual([true]);
    expect(required('remove')).toEqual([true]);
    expect(required('list')).toEqual([]);
  });
});
