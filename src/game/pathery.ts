/**
 * Maps from pathery.com: today's daily maps and single maps by ID, downloaded through the dev /
 * preview server (pathery.com sends no CORS headers; see tools/pathery-site.ts). They are played
 * under `pathery-{id}` keys, next to the generated `{type}-{seed}` ones.
 */

/** What the app keeps of a pathery.com map file (`a/map/{id}.js`). */
export interface SiteMapInfo {
  id: number;
  name: string;
  /** Map code (`parseMapCode`). */
  code: string;
  /** When the map stops being current, in Unix seconds. */
  expires: number;
}

/** The maps pathery.com lists for one of its days. */
export interface SiteDay {
  date: string;
  maps: SiteMapInfo[];
}

/** pathery.com's days start at midnight US Eastern (map files expire at 04:00 or 05:00 UTC). */
export const SITE_TIME_ZONE = 'America/New_York';

/** pathery.com's date at `d` as `YYYY-MM-DD`. */
export function patheryDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function siteMapKey(id: number): string {
  return `pathery-${id}`;
}

/** The map ID of a `pathery-{id}` key, or null. */
export function parseSiteMapKey(key: string): number | null {
  const m = /^pathery-(\d{1,9})$/.exec(key.trim().toLowerCase());
  return m ? Number(m[1]) : null;
}

export function isSiteMapInfo(v: unknown): v is SiteMapInfo {
  const m = v as SiteMapInfo;
  return (
    !!m &&
    typeof m === 'object' &&
    Number.isSafeInteger(m.id) &&
    m.id > 0 &&
    typeof m.name === 'string' &&
    typeof m.code === 'string' &&
    Number.isFinite(m.expires)
  );
}

export function isSiteDay(v: unknown): v is SiteDay {
  const d = v as SiteDay;
  return (
    !!d &&
    typeof d === 'object' &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(d.date)) &&
    Array.isArray(d.maps) &&
    d.maps.every(isSiteMapInfo)
  );
}

/** A download failed; `message` is ready to show. */
export class SiteError extends Error {}

const API = '/api/pathery';

async function getJson(path: string, fetchFn: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(API + path);
  } catch {
    throw new SiteError("Couldn't reach the local server to download from pathery.com.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && body !== null) return body;
  const error = (body as { error?: unknown } | null)?.error;
  // A static build has no /api routes: the request falls through to a 404 or the index page.
  if (typeof error !== 'string') {
    throw new SiteError(
      'Downloading from pathery.com needs the local server (npm run dev or npm run preview).',
    );
  }
  throw new SiteError(`pathery.com: ${error}`);
}

/** Today's daily maps (pathery.com's today). `maps` is empty if the site hasn't posted them yet. */
export async function fetchSiteDay(fetchFn: typeof fetch = fetch): Promise<SiteDay> {
  const body = await getJson('/today', fetchFn);
  if (!isSiteDay(body)) throw new SiteError('pathery.com sent a map list this app can’t read.');
  return body;
}

export async function fetchSiteMap(
  id: number,
  fetchFn: typeof fetch = fetch,
): Promise<SiteMapInfo> {
  const body = await getJson(`/map/${id}`, fetchFn);
  if (!isSiteMapInfo(body)) {
    throw new SiteError(`pathery.com sent a map ${id} this app can’t read.`);
  }
  return body;
}
