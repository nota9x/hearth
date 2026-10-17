export function dashboard(
  accountId: string | undefined,
  type:
    | 'account'
    | 'domains'
    | 'workers'
    | 'worker'
    | 'observability'
    | 'database'
    | 'bucket'
    | 'bucket-settings'
    | 'widget'
    | 'routes' = 'account',
  id = '',
) {
  const base = accountId
    ? `https://dash.cloudflare.com/${encodeURIComponent(accountId)}`
    : 'https://dash.cloudflare.com/';
  const resource = encodeURIComponent(id);
  switch (type) {
    case 'account': {
      return base;
    }
    case 'domains': {
      return `${base}/domains/overview`;
    }
    case 'workers':
    case 'routes': {
      return `${base}/workers-and-pages`;
    }
    case 'worker': {
      return `${base}/workers/services/view/${resource}/production`;
    }
    case 'observability': {
      return `${base}/workers/services/view/${resource}/production/observability`;
    }
    case 'database': {
      return `${base}/workers/d1/databases/${resource}`;
    }
    case 'bucket': {
      return `${base}/r2/default/buckets/${resource}`;
    }
    case 'bucket-settings': {
      return `${base}/r2/default/buckets/${resource}/settings`;
    }
    case 'widget': {
      return `${base}/turnstile/widget/${resource}`;
    }
  }
}
