/**
 * strand-selection.ts — deterministic active-strand derivation.
 *
 * The chat screen must render a single, stable strand even when several are
 * attached (e.g. the drone's pre-created strand auto-joins over the control
 * network while the phone creates its own). `cadre.strands` is a `Map` whose
 * iteration order is insertion order — a race between the local create and the
 * inbound control-sync — so picking `strands.values().next()` is
 * non-deterministic. This helper removes the order dependency.
 */

/**
 * Decide which strand the chat should render. Deterministic and independent of
 * Map insertion order, so it never depends on the create-vs-control-sync race.
 *
 *  - explicit selection that still exists  -> that id
 *  - otherwise                             -> lexicographically smallest id
 *  - empty set                             -> null
 */
export function pickActiveStrandId(
  strandIds: readonly string[],
  selectedId: string | null,
): string | null {
  if (selectedId !== null && strandIds.includes(selectedId)) {
    return selectedId;
  }
  if (strandIds.length === 0) {
    return null;
  }
  // Lexicographically smallest id — stable regardless of array/Map order.
  let smallest = strandIds[0];
  for (const id of strandIds) {
    if (id < smallest) smallest = id;
  }
  return smallest;
}
