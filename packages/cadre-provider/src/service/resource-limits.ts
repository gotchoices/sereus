/**
 * The one definition of what a container resource limit may look like. The config validator
 * rejects text these cannot read at provider start, and the Docker orchestrator turns accepted
 * text into the daemon's byte and nano-CPU counts — so what the validator lets through is
 * exactly what the orchestrator can apply.
 */

const MEMORY_UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** `512M`, `2G`, `1.5g`, or a bare byte count → bytes; `undefined` when the text is not a size. */
export function parseMemoryLimit(limit: string): number | undefined {
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*(B|K|M|G|T)?$/i);
  if (!match) return undefined;
  const [, num, unit] = match;
  return Math.floor(Number(num) * MEMORY_UNIT_BYTES[(unit ?? 'B').toUpperCase()]);
}

/** A CPU count such as `0.5` or `2` → Docker nano-CPUs; `undefined` when the text is not a number. */
export function parseCpuLimit(limit: string): number | undefined {
  const text = limit.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  return Math.floor(Number(text) * 1e9);
}
