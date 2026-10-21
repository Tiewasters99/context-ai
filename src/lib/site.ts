// The site's public address and name, in one place (browser side).
//
// The twin of lib/site.mjs. VITE_SITE_ORIGIN is read at build time; set it to
// the same value as the server's SITE_ORIGIN. The default stays on the current
// production domain, so nothing changes until that variable is set.
//
// `import.meta.env` is read defensively: node harnesses import this module
// directly (scripts/_node-src-loader.mjs), and under plain node it is undefined.

const DEFAULT_SITE_ORIGIN = 'https://www.contextspaces.ai';

function clean(origin: unknown): string {
  return String(origin ?? '').trim().replace(/\/+$/, '');
}

const configured = clean(
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SITE_ORIGIN,
);

/** https://www.<domain>, no trailing slash. */
export const SITE_ORIGIN: string = configured || DEFAULT_SITE_ORIGIN;

/** SITE_ORIGIN without the scheme, for display: www.contextspaces.ai. */
export const SITE_HOST: string = SITE_ORIGIN.replace(/^https?:\/\//, '');

/** The product's name as a person reads it. */
export const SITE_NAME = 'Equazia.ai';

/** An absolute URL on the site: siteUrl('/api/mcp'). */
export function siteUrl(path = '/'): string {
  const p = String(path || '/');
  return SITE_ORIGIN + (p.startsWith('/') ? p : `/${p}`);
}

/** True when this page is served from one of our own domains (old or new). */
export function isOwnHostname(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (h === SITE_HOST.toLowerCase()) return true;
  return /(^|\.)(contextspaces|equazia)\.ai$/.test(h);
}
