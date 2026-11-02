import debug from 'debug';
import { toError } from './describe-thrown.js';
import type { AppSchemaOutcome, AppSchemaWait, SereusPluginResult } from '@serfab/quereus-plugin-sereus';

const log = debug('sereus:cadre:strand-app-schema');

/**
 * `StrandDatabase.appSchemaState()`: whether the database runs the `App` schema its launch was
 * given. `'waiting-for-queue'` while queued offline transactions refuse the apply (the database runs
 * the earlier schema); `'waiting-for-cohort'` while the strand's members cannot be reached; `'failed'`
 * when a later retry failed for another reason. docs/strands.md → "An app schema upgrade waits for the
 * queue or the cohort" says what the database runs in the cohort case, and when `'applied'` is not yet true.
 */
export type StrandAppSchemaState = 'applied' | 'waiting-for-queue' | 'waiting-for-cohort' | 'failed';

/** `strand:app-schema-deferred`: why the `App` schema apply was held back. */
export interface StrandAppSchemaDeferred {
  readonly strandId: string;
  /** `'queue'`: queued offline transactions refused it. `'cohort'`: the strand's members could not be reached. */
  readonly waitingFor: AppSchemaWait;
  /** The queued transactions that refused it; empty when {@link waitingFor} is `'cohort'`. */
  readonly transactionIds: readonly string[];
}

/**
 * Where a strand database reports its `App` schema apply. Retained with the launch config and handed
 * to every database built for the launch, so the reports outlive hibernation and every other rebuild.
 */
export interface StrandAppSchemaListeners {
  onAppSchemaDeferred?: (event: StrandAppSchemaDeferred) => void;
  onAppSchemaApplied?: (event: { strandId: string }) => void;
  onAppSchemaFailed?: (event: { strandId: string; error: Error }) => void;
}

const WAITING_STATE: Record<AppSchemaWait, StrandAppSchemaState> = {
  queue: 'waiting-for-queue',
  cohort: 'waiting-for-cohort'
};

/**
 * What one strand database reports about its `App` schema apply. Built once `connectToStrand` has
 * returned and released first when the database closes, so nothing from a closing connection reaches
 * the app. Events begin at publication, when the app gets the database: a retry that landed before
 * then is not announced, and one that failed before then is announced at publication.
 */
export class StrandAppSchemaReport {
  private state: StrandAppSchemaState;
  private error: Error | undefined;
  private wasPublished = false;
  private released = false;

  constructor(
    private readonly strandId: string,
    private readonly listeners: StrandAppSchemaListeners,
    private readonly result: Pick<SereusPluginResult, 'appSchema' | 'appSchemaWaitingFor' | 'appSchemaDeferredBy'>
  ) {
    // `appSchema` is absent without an `App` schema (a storage replica), which has nothing to defer.
    const waitingFor = result.appSchemaWaitingFor;
    this.state = waitingFor ? WAITING_STATE[waitingFor] : 'applied';
    if (waitingFor) {
      void result.appSchema?.then((outcome) => this.settle(outcome)).catch((error: unknown) => {
        log('strand %s: reporting the deferred app schema apply failed: %O', strandId, error);
      });
    }
  }

  appSchemaState(): StrandAppSchemaState {
    return this.state;
  }

  /** The database was handed to the app: report an apply still waiting or already failed. */
  published(): void {
    if (this.released || this.wasPublished) {
      return;
    }
    this.wasPublished = true;
    const waitingFor = this.result.appSchemaWaitingFor;
    if (waitingFor && this.state === WAITING_STATE[waitingFor]) {
      const event = { strandId: this.strandId, waitingFor, transactionIds: this.result.appSchemaDeferredBy ?? [] };
      this.forward('deferred', () => this.listeners.onAppSchemaDeferred?.(event));
    } else if (this.error) {
      this.reportFailed(this.error);
    }
  }

  release(): void {
    this.released = true;
  }

  /** A cancelled retry (the database closed first) reports nothing. */
  private settle(outcome: AppSchemaOutcome): void {
    if (this.released || outcome.state === 'cancelled') {
      return;
    }
    if (outcome.state === 'applied') {
      this.state = 'applied';
      if (this.wasPublished) {
        this.forward('applied', () => this.listeners.onAppSchemaApplied?.({ strandId: this.strandId }));
      }
      return;
    }
    this.state = 'failed';
    this.error = toError(outcome.error);
    log('strand %s: the deferred app schema apply failed; the database keeps the earlier schema: %O', this.strandId, outcome.error);
    if (this.wasPublished) {
      this.reportFailed(this.error);
    }
  }

  private reportFailed(error: Error): void {
    this.forward('failed', () => this.listeners.onAppSchemaFailed?.({ strandId: this.strandId, error }));
  }

  /** A listener's throw is logged, so it cannot stop {@link published}'s caller from finishing publication. */
  private forward(what: string, deliver: () => void): void {
    try {
      deliver();
    } catch (error) {
      log('strand %s: an app schema %s listener threw: %O', this.strandId, what, error);
    }
  }
}
