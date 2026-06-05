/**
 * uuid.ts — tiny v4-style UUID generator for the RN reference app.
 *
 * Uses Math.random rather than `crypto.randomUUID()`: React Native's Hermes
 * runtime does not expose `crypto.randomUUID` (the bundled
 * `react-native-get-random-values` polyfill only patches
 * `crypto.getRandomValues`). This is "good enough for demo" identifiers —
 * strand IDs and chat message primary keys — where the only requirement is
 * collision-freedom across concurrent peers, not cryptographic strength.
 */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
