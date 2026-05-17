/**
 * /api/settings — host-level settings UI surface.
 *
 * The persisted shape is `host.config.json` (managed by the installer).
 * This route is a thin passthrough plus a write-whitelist:
 *
 *   - uiPort        rejected (restart required; only edit at install time)
 *   - libp2pPort    rejected (restart required)
 *   - upnpEnabled   accepted → also propagated to NatService.putSettings
 *   - updates.autoApply  accepted → propagated to UpdateService.putSettings
 *   - updates.manifestUrl accepted → propagated to UpdateService.putSettings
 *   - anything else 400 invalid_setting
 *
 * GET returns the full `HostConfigFile` (the SPA wants the full shape so it
 * can render a read-only view of the rejected keys).
 */

import type { FastifyInstance } from 'fastify';

import type { NatService } from '../../nat/index.js';
import type { UpdateService } from '../../update/index.js';
import type { HostSettingsStore } from '../settings-store.js';

const FORBIDDEN_KEYS = new Set<string>(['uiPort', 'libp2pPort', 'dataDir', 'identityPath', 'installId', 'installedAt', 'installerVersion', 'version']);

const WRITABLE_TOP_KEYS = new Set<string>(['upnpEnabled', 'updates']);
const WRITABLE_UPDATES_KEYS = new Set<string>(['autoApply', 'manifestUrl']);

export interface SettingsRoutesOptions {
  settingsStore: HostSettingsStore;
  nat: NatService;
  update?: UpdateService;
}

export function registerSettingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions): void {
  const { settingsStore, nat, update } = opts;

  app.get('/api/settings', async () => {
    return { ok: true, data: settingsStore.read() };
  });

  app.put('/api/settings', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const validation = validatePatch(body);
    if (validation.error) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'invalid_setting', message: validation.error },
      });
    }

    const current = settingsStore.read();
    const patch: { upnpEnabled?: boolean; updates?: typeof current.updates } = {};

    if ('upnpEnabled' in body) {
      patch.upnpEnabled = body.upnpEnabled as boolean;
      // Propagate UPnP toggle into the running NatService so the change
      // takes effect immediately. NatService persists into nat.json — that's
      // independent of host.config.json's `upnpEnabled` (which the installer
      // uses on first run to seed nat.json). Update both for consistency.
      await nat.putSettings({ upnpEnabled: body.upnpEnabled as boolean });
    }
    if ('updates' in body) {
      const updates = body.updates as { autoApply?: boolean; manifestUrl?: string };
      const nextUpdates = { ...current.updates };
      if ('autoApply' in updates) nextUpdates.autoApply = updates.autoApply as boolean;
      if ('manifestUrl' in updates) nextUpdates.manifestUrl = updates.manifestUrl as string;
      patch.updates = nextUpdates;
      if (update) {
        const propagate: { autoApply?: boolean; manifestUrl?: string } = {};
        if ('autoApply' in updates) propagate.autoApply = updates.autoApply as boolean;
        if ('manifestUrl' in updates) propagate.manifestUrl = updates.manifestUrl as string;
        await update.putSettings(propagate);
      }
    }

    const next = settingsStore.update(patch);
    return { ok: true, data: next };
  });
}

function validatePatch(body: Record<string, unknown>): { error?: string } {
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { error: `Setting "${key}" is not editable at runtime; change it in host.config.json and restart cadre-host.` };
    }
    if (!WRITABLE_TOP_KEYS.has(key)) {
      return { error: `Unknown setting "${key}"` };
    }
  }
  if ('upnpEnabled' in body && typeof body.upnpEnabled !== 'boolean') {
    return { error: '"upnpEnabled" must be a boolean' };
  }
  if ('updates' in body) {
    if (!body.updates || typeof body.updates !== 'object') {
      return { error: '"updates" must be an object' };
    }
    const updates = body.updates as Record<string, unknown>;
    for (const key of Object.keys(updates)) {
      if (!WRITABLE_UPDATES_KEYS.has(key)) {
        return { error: `Unknown setting "updates.${key}"` };
      }
    }
    if ('autoApply' in updates && typeof updates.autoApply !== 'boolean') {
      return { error: '"updates.autoApply" must be a boolean' };
    }
    if (
      'manifestUrl' in updates &&
      typeof updates.manifestUrl !== 'string'
    ) {
      return { error: '"updates.manifestUrl" must be a string' };
    }
  }
  return {};
}
