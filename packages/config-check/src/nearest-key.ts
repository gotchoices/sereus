/**
 * The "did you mean" suggestion shared by `objectOf`'s unknown-key message and any caller's own
 * name check (cadre-cli's unknown `CADRE_*` variables).
 */

/** The accepted name a typo most likely meant: a case-insensitive match, else within two edits. */
export function nearestKey(key: string, accepted: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  const byCase = accepted.find((candidate) => candidate.toLowerCase() === lower);
  if (byCase !== undefined) return byCase;

  let nearest: string | undefined;
  let nearestDistance = 3;
  for (const candidate of accepted) {
    const distance = editDistance(key, candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Levenshtein distance; names are short, so the plain quadratic table is fine. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}
