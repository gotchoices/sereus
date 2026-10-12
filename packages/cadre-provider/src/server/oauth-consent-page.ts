/**
 * The built-in consent form (`auth.oauth.devConsentPage`) and the authorize endpoint's error
 * page. The form stands in for an operator's own account and checkout pages while an app is
 * developed against the provider: whoever opens it types a customer id, picks a plan and
 * approves, so it is served only with `allowInsecureNoAuth: true`. No templating dependency;
 * every value is escaped on the way in, since `client_id`, `state` and `redirect_uri` are the
 * caller's text.
 */

import type { BillingPlan } from '../types.js';

/** What the consent form shows and carries through to its own `POST`. */
export interface ConsentPageInput {
  /** Where the form posts: `<basePath>/oauth/authorize`. */
  action: string;
  clientId: string;
  /** The scopes the client asked for, already checked against its allowance. */
  scopes: string[];
  /** The plans the customer may pick from (`BillingService.listPlans()`). */
  plans: BillingPlan[];
  /** The authorize parameters, carried through as hidden fields so the `POST` re-validates them. */
  params: Record<string, string>;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` safe to place in element content or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px; background: #f6f6f6; color: #222; }
  main { max-width: 32rem; margin: 0 auto; background: #fff; padding: 24px; border-radius: 8px; }
  .warn { background: #fff4d6; padding: 8px 12px; border-radius: 4px; }
  label { display: block; margin: 12px 0; }
  input, select { font: inherit; width: 100%; box-sizing: border-box; padding: 6px 8px; }
  button { font: inherit; padding: 8px 16px; margin-right: 8px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function hiddenFields(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');
}

function planOptions(plans: BillingPlan[]): string {
  return plans
    .map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)} (${plan.pricePerHourCents} cents/hour)</option>`)
    .join('\n');
}

/** The consent form a browser sees at `GET /oauth/authorize` when no `authorizeCustomer` hook is installed. */
export function renderConsentPage(input: ConsentPageInput): string {
  const client = escapeHtml(input.clientId);
  const scopes = input.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join('\n');
  return page(
    `Sign in: ${input.clientId}`,
    `<h1>Authorize ${client}</h1>
<p class="warn">Development consent page: this provider has no account system attached. Anyone who opens this page can sign in as any customer id.</p>
<p><strong>${client}</strong> asks for:</p>
<ul>
${scopes}
</ul>
<form method="post" action="${escapeHtml(input.action)}">
${hiddenFields(input.params)}
<label>Customer id <input name="customer_id" required autocomplete="off"></label>
<label>Plan <select name="plan_id">
${planOptions(input.plans)}
</select></label>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}

/**
 * The page a browser sees when the authorize request cannot even be redirected: an unknown
 * client or an unregistered redirect URI. It names the problem and offers no link, since the
 * only place to send the browser would be the URI that was just refused.
 */
export function renderErrorPage(message: string): string {
  return page('Cannot sign in', `<h1>Cannot sign in</h1>
<p>${escapeHtml(message)}</p>`);
}
