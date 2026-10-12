/**
 * The removal on record: `<nodeStateDir>/removed.<encoded partyId>.json`, written when the node
 * learns that an owner removed it from its cadre (`cadre:removed`), and read at every start.
 *
 * cadre-core reports a removal only to a node object that saw its own live membership row
 * earlier in the same process (`CadreNode.removedFromCadre`), so a restarted node never learns
 * it again and would run against a cadre that refuses it. With the marker on record, `cadre
 * start` does not start the node at all. The file is named like the node-local stores beside it
 * (`trusted-owners.<encoded partyId>.json`), so a node that moves to another party is not held
 * by the old party's removal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFileSafeComponent, type CadreRemoval } from '@serfab/cadre-core';
import { writePrivateFile } from './private-file.js';

export function removalMarkerPath(nodeStateDir: string, partyId: string): string {
  return join(nodeStateDir, `removed.${encodeFileSafeComponent(partyId)}.json`);
}

/** Write the marker for `removal.partyId` and return its path. */
export function writeRemovalMarker(nodeStateDir: string, removal: CadreRemoval): string {
  const path = removalMarkerPath(nodeStateDir, removal.partyId);
  const { partyId, stampId, signerKey, at } = removal;
  writePrivateFile(path, JSON.stringify({ partyId, stampId, signerKey, at }, null, 2));
  return path;
}

/**
 * The removal on record for `partyId`, or `undefined` when there is none. A file that is present
 * but unreadable or malformed throws, naming the file: a damaged marker must not let a removed
 * node start.
 */
export function readRemovalMarker(nodeStateDir: string, partyId: string): CadreRemoval | undefined {
  const path = removalMarkerPath(nodeStateDir, partyId);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return undefined;
    throw new Error(`The removal marker ${path} is present but unreadable`, { cause: err });
  }
  return parseRemovalMarker(text, path, partyId);
}

function parseRemovalMarker(text: string, path: string, partyId: string): CadreRemoval {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`The removal marker ${path} is not valid JSON; this node was removed from its cadre and must not start. Delete the file deliberately to start it again`, { cause: err });
  }
  const { partyId: recorded, stampId, signerKey, at } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (recorded !== partyId || typeof stampId !== 'string' || (signerKey !== null && typeof signerKey !== 'string') || typeof at !== 'number') {
    throw new Error(`The removal marker ${path} is malformed; this node was removed from cadre ${partyId} and must not start. Delete the file deliberately to start it again`);
  }
  return { partyId, stampId, signerKey, at };
}
