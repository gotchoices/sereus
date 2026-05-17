/**
 * Tiny `@TOKEN@` substitution. Used to render systemd / launchd unit
 * files. Throws if any tokens are left after substitution to catch
 * typos at install time rather than at service-startup time.
 */

const TOKEN_RE = /@([A-Z][A-Z0-9_]*)@/g;

export function renderTemplate(template: string, tokens: Readonly<Record<string, string>>): string {
  const rendered = template.replace(TOKEN_RE, (full, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) {
      throw new Error(`renderTemplate: missing value for token ${full}`);
    }
    return tokens[key];
  });
  const leftover = rendered.match(TOKEN_RE);
  if (leftover) {
    throw new Error(`renderTemplate: unresolved tokens: ${leftover.join(', ')}`);
  }
  return rendered;
}
