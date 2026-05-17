/**
 * Service-host abstraction. The wizard picks a concrete impl by platform
 * (systemd / launchd / NSSM) and drives it through this common interface.
 */

export interface ServiceHostContext {
  /** Absolute path to node.exe / node. */
  nodePath: string;
  /** Absolute path to the cadre-host CLI entrypoint (dist/bin/host.js). */
  hostJs: string;
  /** Absolute path to the cadre-host data dir. */
  dataDir: string;
  /** Directory containing template files / PowerShell scripts. */
  serviceDir: string;
}

export interface ServiceHostStatus {
  installed: boolean;
  running: boolean;
}

export interface ServiceHost {
  /** Stable service name (used for status / logging). */
  readonly name: string;

  /** Render unit file(s) and register with the OS service manager. */
  install(ctx: ServiceHostContext): Promise<void>;

  /** Stop + deregister. Idempotent: no-op when not installed. */
  uninstall(ctx: ServiceHostContext): Promise<void>;

  /**
   * Restart the running service. Used by the update flow after `npm install -g`
   * to pick up the new binary. Throws if the OS service manager reports a
   * non-zero exit — callers are responsible for surfacing that as a warning
   * (the binary swap already succeeded).
   */
  restart(ctx: ServiceHostContext): Promise<void>;

  /** Cheap status read. */
  status(ctx: ServiceHostContext): Promise<ServiceHostStatus>;

  /**
   * Render the unit-file text without touching the OS. Surfaced for unit
   * tests; the install() path uses this internally too.
   */
  renderUnit(ctx: ServiceHostContext): string | null;
}
