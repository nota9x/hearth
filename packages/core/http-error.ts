import {
  brandStyles,
  escapeHtml,
  instanceName,
  renderBrand,
} from './branding-view';
import { motionStyles } from './motion';

export type ErrorContext = 'page' | 'image';
interface ErrorContent {
  heading: string;
  description: string;
  reasons: readonly string[];
}
const serverError: ErrorContent = {
  heading: 'Something went wrong on our end',
  description: 'Please try again in a moment.',
  reasons: [
    'The service may be experiencing a temporary problem.',
    'A part of the service may be unavailable.',
  ],
};
const clientError: ErrorContent = {
  heading: "We couldn't open this page",
  description: 'Check the address or return home to continue.',
  reasons: [
    'The request may not be supported.',
    'The link may no longer be available.',
  ],
};
const content: Record<number, ErrorContent> = {
  400: {
    heading: "We couldn't understand that request",
    description: 'Check the address and try again.',
    reasons: [
      'The link may be incomplete.',
      'The request may contain unsupported information.',
    ],
  },
  401: {
    heading: 'Please sign in to continue',
    description: 'Sign in to your account to open this page.',
    reasons: [
      'Your session may have ended.',
      'This page may require you to sign in.',
    ],
  },
  403: {
    heading: "You don't have access to this page",
    description: 'Return home to continue using your account.',
    reasons: [
      'This page may require additional permissions.',
      'Your account may not have access to this area.',
    ],
  },
  404: {
    heading: "We couldn't find that page",
    description: 'The page you’re looking for may no longer be available.',
    reasons: [
      'The link may have been entered incorrectly.',
      'The page may have moved or been removed.',
      'The link may no longer be available.',
    ],
  },
  405: {
    heading: "That request isn't supported here",
    description: 'Return home and open the page again.',
    reasons: [
      'The request may use an unsupported method.',
      'The link may belong to a different part of the service.',
    ],
  },
  408: {
    heading: 'That request took too long',
    description: 'Please try again when you’re ready.',
    reasons: [
      'Your connection may have been interrupted.',
      'The service may be taking longer than usual to respond.',
    ],
  },
  413: {
    heading: 'That request is too large',
    description: 'Try again with a smaller request.',
    reasons: [
      'The submitted content may exceed the allowed size.',
      'The request may include more data than this page supports.',
    ],
  },
  421: {
    heading: 'This address can’t open the application',
    description: 'Go home to open the configured application address.',
    reasons: [
      'The address may point to a different part of the service.',
      'The application address may have changed.',
    ],
  },
  429: {
    heading: 'Let’s give it a moment',
    description: 'Please wait a little before trying again.',
    reasons: [
      'Several requests may have arrived close together.',
      'Other people on your network may be using the service too.',
    ],
  },
  500: serverError,
  502: {
    heading: 'We’re having trouble connecting',
    description: 'Please try again in a moment.',
    reasons: [
      'A part of the service may be temporarily unreachable.',
      'The service may be recovering from an interruption.',
    ],
  },
  503: {
    heading: 'This service is temporarily unavailable',
    description: 'Please try again in a little while.',
    reasons: [
      'The service may be undergoing maintenance.',
      'A temporary interruption may be affecting the service.',
    ],
  },
};
const imageNotFound: ErrorContent = {
  heading: "We couldn't find that image",
  description: "The image you're looking for may no longer be available.",
  reasons: [
    'The link may have been entered incorrectly.',
    'The image may have been removed.',
    'The image or share link may have expired.',
    'The link may no longer be available.',
  ],
};

export function httpErrorContent(
  status: number,
  context: ErrorContext = 'page',
): ErrorContent {
  if (status === 404 && context === 'image') return imageNotFound;
  if (status === 405 && context === 'image')
    return {
      ...content[405],
      description: 'Try opening the link directly in your browser.',
    };
  return content[status] ?? (status >= 500 ? serverError : clientError);
}
function appOrigin(value: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

// Shared between SvelteKit and standalone delivery documents, scoped to the error surface.
export const httpErrorStyles = `${brandStyles}${motionStyles}
.http-error{--page:#161311;--surface:#1e1b18;--border:#e8d5bc18;--muted:#b1a291;--accent:#c4714a;box-sizing:border-box;display:flex;flex-direction:column;min-height:100vh;min-height:100svh;padding:48px 24px 24px;background:var(--page);color:#e8ddd0;color-scheme:dark;font-family:'Bitter Variable',Georgia,serif;font-synthesis:none;font-size:15px;line-height:1.6}
.http-error *{box-sizing:border-box}
.http-error__content{width:min(100%,520px);margin:auto;padding:24px 0 56px;text-align:center}
.http-error__message{text-align:center}
.http-error__code{margin:0 0 24px;color:var(--accent);font-size:clamp(7rem,22vw,11rem);font-weight:650;line-height:1;letter-spacing:-.065em;font-variant-numeric:lining-nums}
.http-error h1{margin:0 0 16px;font-size:clamp(1.6rem,4.5vw,2.1rem);font-weight:550;line-height:1.25;letter-spacing:-.04em;text-wrap:balance}
.http-error__description{margin:0 auto;color:var(--muted);max-width:390px;text-wrap:pretty}
.http-error__actions{display:flex;justify-content:center;flex-wrap:wrap;gap:10px;margin:28px 0 0}
.http-error__action{--control-hover:#312820;--control-pressed:color-mix(in srgb,var(--control-hover) 92%,white);display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 20px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:inherit;text-decoration:none;font-weight:500;transition:background-color var(--motion-state) var(--motion-enter),border-color var(--motion-state) var(--motion-enter)}
.http-error__action:hover{background:var(--control-hover);border-color:#e8d5bc30}
.http-error__action--primary{--control-hover:#d88960;--control-pressed:color-mix(in srgb,var(--control-hover) 94%,white);background:var(--accent);color:#160e09;border-color:transparent;font-weight:650}
.http-error__action--primary:hover{border-color:transparent}
.http-error__action:active{background:var(--control-pressed);transition-duration:var(--motion-press)}
.http-error :is(a,summary):focus-visible{outline:2px solid #e6a479;outline-offset:4px}
.http-error details{max-width:390px;margin:32px auto 0;text-align:left}
.http-error summary{display:flex;align-items:center;justify-content:center;gap:9px;width:fit-content;min-height:44px;margin:0 auto;padding:8px 4px;list-style:none;cursor:pointer;color:var(--muted);font-size:.88rem;font-weight:550;border-radius:4px;transition:color var(--motion-state) var(--motion-enter)}
.http-error summary::-webkit-details-marker{display:none}
.http-error summary:hover{color:#e8ddd0}
.http-error__chevron{width:18px;height:18px;flex-shrink:0;color:var(--muted);transition:transform var(--motion-state) var(--motion-enter),color var(--motion-state) var(--motion-enter)}
.http-error details[open] .http-error__chevron{transform:rotate(180deg);color:var(--accent)}
.http-error__reasons{margin:0;padding:16px 0 0 20px;color:var(--muted);font-size:.88rem}
.http-error__reasons li{padding-left:3px}
.http-error__reasons li::marker{color:var(--accent)}
.http-error__reasons li+li{margin-top:9px}
.http-error details::details-content{opacity:0;transition:opacity var(--motion-disclosure-out) var(--motion-exit),content-visibility var(--motion-disclosure-out) allow-discrete}
.http-error details[open]::details-content{opacity:1;transition-duration:var(--motion-disclosure-in);transition-timing-function:var(--motion-enter)}
@supports(interpolate-size:allow-keywords){.http-error details{interpolate-size:allow-keywords}.http-error details::details-content{block-size:0;overflow:hidden;transition:opacity var(--motion-disclosure-out) var(--motion-exit),block-size var(--motion-disclosure-out) var(--motion-exit),content-visibility var(--motion-disclosure-out) allow-discrete}.http-error details[open]::details-content{block-size:auto;transition-duration:var(--motion-disclosure-in);transition-timing-function:var(--motion-enter)}}
.http-error__brand{--brand-gap:9px;display:flex;justify-content:center;width:min(100%,520px);margin:0 auto;text-align:center;color:var(--muted);font-size:1.15rem;line-height:1.3}
@media(max-width:420px){.http-error{padding:32px 20px 20px}.http-error__content{padding-top:12px;padding-bottom:40px}.http-error__code{margin-bottom:20px}}
@media(prefers-reduced-motion:reduce){.http-error *{transition:none!important}}
@supports selector(::details-content){@media(prefers-reduced-motion:reduce){.http-error details::details-content{transition:none!important}}}
`;

export function renderHttpError(
  status: number,
  context: ErrorContext = 'page',
  name = '',
  origin = '',
) {
  const copy = httpErrorContent(status, context);
  const home = `${appOrigin(origin)}/`;
  const retry = status === 408 || status === 429 || status >= 500;
  const primary =
    status === 401
      ? `<a class="http-error__action http-error__action--primary" href="${escapeHtml(home)}login">Sign in</a>`
      : retry
        ? '<a class="http-error__action http-error__action--primary" href="" data-sveltekit-reload>Try again</a>'
        : '';
  const actions = `${primary}${context === 'page' ? `<a class="http-error__action${primary ? '' : ' http-error__action--primary'}" href="${escapeHtml(home)}">Go home</a>` : ''}`;
  return `<section class="http-error" aria-labelledby="http-error-heading"><div class="http-error__content"><div class="http-error__message"><p class="http-error__code" aria-label="Error ${status}">${status}</p><h1 id="http-error-heading">${escapeHtml(copy.heading)}</h1><p class="http-error__description">${escapeHtml(copy.description)}</p>${actions ? `<nav class="http-error__actions" aria-label="Recovery actions">${actions}</nav>` : ''}</div><details><summary>Possible reasons<svg class="http-error__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary><ul class="http-error__reasons">${copy.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></details></div><footer class="http-error__brand">${renderBrand(name)}</footer></section>`;
}
export function renderHttpErrorDocument(
  status: number,
  context: ErrorContext = 'page',
  name = '',
  origin = '',
) {
  const font = `${appOrigin(origin)}/fonts/bitter-latin.woff2`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#161311"><title>${status} · ${escapeHtml(instanceName(name))}</title><style>@font-face{font-family:'Bitter Variable';font-style:normal;font-weight:100 900;font-display:swap;src:url('${escapeHtml(font)}') format('woff2')}html,body{margin:0;background:#161311}${httpErrorStyles}</style></head><body><main id="main">${renderHttpError(status, context, name, origin)}</main></body></html>`;
}
export function acceptsErrorHtml(request: Request) {
  const destination = request.headers.get('sec-fetch-dest');
  if (destination !== null && destination !== 'document') return false;
  const accepted = (request.headers.get('accept') ?? '')
    .toLowerCase()
    .split(',')
    .map((item) => {
      const [type, ...parameters] = item.trim().split(';');
      const parameter = parameters.find((value) =>
        value.trimStart().startsWith('q='),
      );
      const quality = parameter ? Number(parameter.trim().slice(2)) : 1;
      return {
        type,
        quality:
          Number.isFinite(quality) && quality >= 0 && quality <= 1
            ? quality
            : 0,
      };
    });
  const html = accepted.find((item) => item.type === 'text/html')?.quality ?? 0;
  return (
    html > 0 &&
    (destination === 'document' ||
      accepted.every(
        (item) =>
          !(
            ['application/json', 'text/plain'].includes(item.type) &&
            item.quality > html
          ),
      ))
  );
}
export function httpErrorHeaders(origin = '') {
  const fontOrigin = appOrigin(origin);
  return new Headers({
    'Content-Type': 'text/html;charset=UTF-8',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'${fontOrigin ? ` ${fontOrigin}` : ''}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    Vary: 'Accept, Sec-Fetch-Dest',
  });
}
