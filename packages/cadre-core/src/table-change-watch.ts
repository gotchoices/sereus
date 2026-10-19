/**
 * One way for cadre-core to be told that a control or strand table changed, so an idle loop
 * can wait for a change instead of re-reading on a timer. Built on Quereus's
 * `Database.watch`, which hears both a commit made on this `Database` and, through the
 * Optimystic plugin's `notifyExternalChange` bridge, every change this node's storage takes
 * in from elsewhere: a consensus commit it took part in as a cohort member, a block-transfer
 * push such as join backfill, and a read-repair landing. Events are table-wide; there are no
 * row keys.
 *
 * The consumer's `onChange` never runs inside a commit. The watch handler only sets flags
 * and arms a timer, and runs are single-flight: changes inside the coalescing window share
 * one run, a change during a run produces exactly one follow-up run, and a consumer's own
 * `trigger` (start, retry backoff) and the backstop go through the same rule.
 * `docs/architecture.md` → "Table change subscriptions" says what the seam does not hear,
 * which is why consumers keep a backstop.
 */
import debug from 'debug';
import type { ChangeScope, Database, Subscription, TableWatch, WatchEvent } from '@quereus/quereus';
import { defaultTimeoutScheduler } from './timeout-scheduler.js';
import type { TimeoutScheduler } from './timeout-scheduler.js';

const log = debug('sereus:cadre:table-watch');

/**
 * Default coalescing window. One local commit fires the watch twice (Quereus's own
 * post-commit dispatch, then the plugin's storage event); this folds both into one run.
 */
export const TABLE_CHANGE_COALESCE_MS = 50;

export interface TableChangeWatchOptions {
  /** Short label for log lines (e.g. 'strand-watcher'). */
  label: string;
  /** Coalescing window after the first change; default {@link TABLE_CHANGE_COALESCE_MS}. */
  coalesceMs?: number;
  /**
   * Run anyway this long after the last run settled, change or not. Omit for none.
   * The path for a change that arrives without a storage event (see the module doc).
   */
  backstopMs?: number;
  /**
   * Called inline, synchronously, from the watch handler — inside the committing call,
   * possibly with the control write lock held — once per changed table per event, with the
   * name as the consumer passed it. Only for setting a flag (cache invalidation). Must not
   * read, write or await.
   */
  onInvalidate?: (qualifiedTable: string) => void;
  /** Timer seam; default real, unref'd timers. */
  scheduler?: TimeoutScheduler;
}

export interface TableChangeWatch {
  /** Schedule a run after `delayMs` (default 0) through the same single-flight rule; an earlier pending run wins. */
  trigger(delayMs?: number): void;
  /** Stop: unsubscribe, clear timers; no run starts afterwards. Idempotent. Does not wait for a run in flight. */
  dispose(): void;
}

/**
 * Subscribe `onChange` to changes in `tables` (qualified `'Schema.Table'` names, e.g.
 * `'CadreControl.Strand'`). Throws synchronously on a name that is not qualified, or a table
 * that does not exist.
 *
 * NOTE: the plugin arms its storage bridge for a table on that table's first full
 * initialization on this `Database`, so a table not yet touched hears local commits only,
 * not replicated ones. Consumers' start runs touch their tables; the seam does not, because
 * touching a never-written collection consults the network.
 *
 * NOTE: Quereus silently disposes a subscription whose table is dropped or altered. Control
 * and strand schemas are fixed for a database's life (an app-schema attach adds `App` tables
 * and alters no `Strand` one), so nothing re-subscribes; revisit if that stops holding.
 */
export function watchTables(
  db: Database,
  tables: readonly string[],
  onChange: () => Promise<void>,
  options: TableChangeWatchOptions,
): TableChangeWatch {
  return new TableChangeWatcher(db, tables, onChange, options);
}

/**
 * The subscriptions one database owner has handed out, so its `close()` can dispose those
 * still live — synchronously, ahead of its own awaits, so nothing a closing commit does
 * schedules a run. (`Database.close()` disposes them too, but only after its own awaits.)
 */
export class TableWatchRegistry {
  private readonly live = new Set<TableChangeWatch>();

  watch(
    db: Database,
    tables: readonly string[],
    onChange: () => Promise<void>,
    options: TableChangeWatchOptions,
  ): TableChangeWatch {
    const inner = watchTables(db, tables, onChange, options);
    const tracked: TableChangeWatch = {
      trigger: delayMs => inner.trigger(delayMs),
      dispose: () => {
        this.live.delete(tracked);
        inner.dispose();
      },
    };
    this.live.add(tracked);
    return tracked;
  }

  disposeAll(): void {
    for (const watch of [...this.live]) {
      watch.dispose();
    }
  }
}

/** One armed timer; an object of its own so the scheduler's handles need not be unique. */
interface Wake {
  handle: unknown;
}

class TableChangeWatcher implements TableChangeWatch {
  private readonly subscription: Subscription;
  /** The consumer's name for each watched table, by Quereus's lowercased `schema.table` key. */
  private readonly names = new Map<string, string>();
  private readonly scheduler: TimeoutScheduler;
  private readonly coalesceMs: number;
  /**
   * Every armed timer: the coalescing window, `trigger` delays and the backstop. Whichever
   * fires first starts the run, and starting a run clears the rest.
   */
  private readonly wakes = new Set<Wake>();
  /** The coalescing window, while armed: a change joins it instead of extending it. */
  private coalesceWake: Wake | undefined;
  private running = false;
  /** A timer fired while a run was in flight: one more run, a window after it settles. */
  private rerun = false;
  private disposed = false;
  private warnedThenable = false;

  constructor(
    db: Database,
    tables: readonly string[],
    private readonly onChange: () => Promise<void>,
    private readonly options: TableChangeWatchOptions,
  ) {
    this.scheduler = options.scheduler ?? defaultTimeoutScheduler;
    this.coalesceMs = options.coalesceMs ?? TABLE_CHANGE_COALESCE_MS;
    const watches = tables.map(fullTableWatch);
    watches.forEach((watch, i) => this.names.set(tableKey(watch), tables[i]));
    const scope: ChangeScope = { watches, nonDeterministicSources: [], unboundParameters: [] };
    // Returns undefined, so Quereus never awaits consumer work inside a commit.
    this.subscription = db.watch(scope, event => this.handleChange(event));
    this.armBackstop();
  }

  trigger(delayMs = 0): void {
    if (!this.disposed) {
      this.arm(delayMs);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.subscription.unsubscribe();
    this.clearWakes();
  }

  /** Runs inside the committing call, possibly under the control write lock: flags and a timer only. */
  private handleChange(event: WatchEvent): void {
    if (this.disposed) {
      return;
    }
    this.coalesceWake ??= this.arm(this.coalesceMs);
    for (const { watch } of event.matched) {
      this.invalidate(this.names.get(tableKey(watch)) ?? tableKey(watch));
    }
  }

  private invalidate(table: string): void {
    let result: unknown;
    try {
      result = this.options.onInvalidate?.(table);
    } catch (err) {
      log('%s: onInvalidate threw for %s: %O', this.options.label, table, err);
      return;
    }
    if (!this.warnedThenable && isThenable(result)) {
      this.warnedThenable = true;
      log('%s: misuse — onInvalidate returned a promise for %s; it is never awaited, and must only set a flag', this.options.label, table);
    }
  }

  private arm(delayMs: number): Wake {
    const wake: Wake = { handle: undefined };
    wake.handle = this.scheduler.setTimeout(() => this.fire(wake), delayMs);
    this.wakes.add(wake);
    return wake;
  }

  private armBackstop(): void {
    if (this.options.backstopMs !== undefined) {
      this.arm(this.options.backstopMs);
    }
  }

  private clearWakes(): void {
    for (const wake of this.wakes) {
      this.scheduler.clearTimeout(wake.handle);
    }
    this.wakes.clear();
    this.coalesceWake = undefined;
  }

  private fire(wake: Wake): void {
    if (!this.wakes.delete(wake)) {
      return;
    }
    if (wake === this.coalesceWake) {
      this.coalesceWake = undefined;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.clearWakes();
    this.rerun = false;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      await this.onChange();
    } catch (err) {
      log('%s: change run failed: %O', this.options.label, err);
    }
    this.running = false;
    this.settled();
  }

  private settled(): void {
    if (this.disposed) {
      return;
    }
    if (this.rerun) {
      this.coalesceWake ??= this.arm(this.coalesceMs);
    }
    this.armBackstop();
  }
}

function fullTableWatch(qualifiedTable: string): TableWatch {
  const [schema, table, ...rest] = qualifiedTable.split('.');
  if (!schema || !table || rest.length > 0) {
    throw new Error(`watchTables: '${qualifiedTable}' is not a qualified 'Schema.Table' name`);
  }
  return { table: { schema, table }, columns: 'all', scope: { kind: 'full' } };
}

/** Quereus's own matching key for a watched table. */
function tableKey(watch: TableWatch): string {
  return `${watch.table.schema}.${watch.table.table}`.toLowerCase();
}

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}
