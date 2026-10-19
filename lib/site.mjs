// The site's public address and name, in one place (server side).
//
// Every absolute URL the server writes down — an OAuth redirect URI, a link in
// an email, the MCP server's website and icons, a fallback when a request
// carries no Host header — comes from SITE_ORIGIN here. Moving the product to
// a new domain is then a change to one environment variable (SITE_ORIGIN in
// Vercel), not a code change.
//
// The default stays on the current production domain, so nothing changes until
// that variable is set. The browser's twin is src/lib/site.ts
// (VITE_SITE_ORIGIN); set both to the same value.

const DEFAULT_SITE_ORIGIN = 'https://www.contextspaces.ai';

// Hand-typed values are forgiven: surrounding spaces, a trailing slash, and a
// missing scheme (www.example.ai becomes https://www.example.ai). A value this
// module cannot use never throws; it falls back to the default.
export function cleanOrigin(origin) {
  const v = String(origin || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  return /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(withScheme) ? withScheme : '';
}

/** https://www.<domain>, no trailing slash. */
export const SITE_ORIGIN = cleanOrigin(process.env.SITE_ORIGIN) || DEFAULT_SITE_ORIGIN;

/** SITE_ORIGIN's host name, e.g. www.contextspaces.ai. */
export const SITE_HOST = SITE_ORIGIN.replace(/^https?:\/\//i, '');

/** The product's name as a person reads it. */
export const SITE_NAME = 'Equazia.ai';

/** An absolute URL on the site: siteUrl('/app/connections'). */
export function siteUrl(path = '/') {
  const p = String(path || '/');
  return SITE_ORIGIN + (p.startsWith('/') ? p : `/${p}`);
}

/**
 * Host names that are ours: the current domain, the domain it is moving to,
 * their subdomains, and SITE_ORIGIN's own host. Used where a request's Host
 * header is trusted only if it names us.
 */
export function isOwnHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === SITE_HOST.toLowerCase()) return true;
  return /^([a-z0-9-]+\.)*(contextspaces|equazia)\.ai$/.test(h);
}
