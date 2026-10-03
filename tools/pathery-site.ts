/**
 * Vite plugin: dev / preview server routes that download maps from pathery.com for the app
 * (the site sends no CORS headers, so the browser can't fetch them itself).
 *
 *   GET /api/pathery/today      -> SiteDay: pathery.com's maps for its current date
 *   GET /api/pathery/map/{id}   -> SiteMapInfo
 *   errors                      -> { error: string } with HTTP 502
 *
 * Politeness, as in reference/scripts/fetch-history.js: one request at a time with a pause
 * between them, and nothing downloaded twice. Responses are cached in `.cache/pathery/` (map files
 * don't change; a date's map list is cached once it is non-empty).
 */
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { patheryDate } from '../src/game/pathery.ts';
import type { SiteDay, SiteMapInfo } from '../src/game/pathery.ts';

const BASE = 'https://www.pathery.com/';
const UA = 'pathery-local-replica/0.1 (personal offline test corpus; low rate)';
const DELAY_MS = 1000;

export type FetchText = (url: string) => Promise<{ status: number; text: string }>;

const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  return { status: res.status, text: await res.text() };
};

export interface PatherySiteOptions {
  cacheDir: string;
  fetchText?: FetchText;
  /** Pause before each download after the first. */
  delayMs?: number;
  now?: () => Date;
}

export class PatherySite {
  private readonly cacheDir: string;
  private readonly fetchText: FetchText;
  private readonly delayMs: number;
  private readonly now: () => Date;
  /** Downloads run one after another on this chain. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastDownload = 0;
  requests = 0;

  constructor(o: PatherySiteOptions) {
    this.cacheDir = o.cacheDir;
    this.fetchText = o.fetchText ?? fetchText;
    this.delayMs = o.delayMs ?? DELAY_MS;
    this.now = o.now ?? (() => new Date());
  }

  async today(): Promise<SiteDay> {
    const date = patheryDate(this.now());
    const maps: SiteMapInfo[] = [];
    for (const id of await this.mapIds(date)) maps.push(await this.map(id));
    return { date, maps };
  }

  /** The map IDs pathery.com lists for `date` (`[]` if none yet). */
  async mapIds(date: string): Promise<number[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date "${date}"`);
    const file = `mapsbydate/${date}.json`;
    const cached = await this.readCache(file);
    const text = cached ?? (await this.download(`a/mapsbydate/${date}.js`));
    const ids: unknown = JSON.parse(text);
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new Error(`unexpected map list for ${date}`);
    }
    if (cached === null && ids.length > 0) await this.writeCache(file, text);
    return ids as number[];
  }

  async map(id: number): Promise<SiteMapInfo> {
    const file = `maps/${id}.json`;
    const cached = await this.readCache(file);
    const text = cached ?? (await this.download(`a/map/${id}.js`));
    const json = JSON.parse(text) as Record<string, unknown>;
    const info: SiteMapInfo = {
      id: Number(json.ID),
      name: String(json.name ?? ''),
      code: String(json.code ?? ''),
      expires: Number(json.dateExpires),
    };
    if (info.id !== id || !info.code.includes(':') || !Number.isFinite(info.expires)) {
      throw new Error(`unexpected map file for ${id}`);
    }
    if (cached === null) await this.writeCache(file, text);
    return info;
  }

  private download(rel: string): Promise<string> {
    const run = async () => {
      const wait = this.lastDownload + this.delayMs - Date.now();
      if (this.requests > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.requests++;
      try {
        const res = await this.fetchText(BASE + rel);
        if (res.status !== 200) throw new Error(`${rel}: HTTP ${res.status}`);
        return res.text;
      } finally {
        this.lastDownload = Date.now();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readCache(file: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.cacheDir, file), 'utf8');
    } catch {
      return null;
    }
  }

  private async writeCache(file: string, text: string): Promise<void> {
    const p = path.join(this.cacheDir, file);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Connect middleware for the routes above; anything else goes to `next`. */
export function patheryRoutes(site: PatherySite) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = (req.url ?? '').split('?')[0]!;
    if (!url.startsWith('/api/pathery/') || req.method !== 'GET') return next();
    const m = /^\/api\/pathery\/map\/(\d{1,9})$/.exec(url);
    const work = url === '/api/pathery/today' ? site.today() : m ? site.map(Number(m[1])) : null;
    if (!work) return send(res, 404, { error: 'unknown route' });
    work.then(
      (body) => send(res, 200, body),
      (e: unknown) => send(res, 502, { error: e instanceof Error ? e.message : String(e) }),
    );
  };
}

export function patheryDaily(): Plugin {
  let site: PatherySite;
  return {
    name: 'pathery-daily',
    configResolved(config) {
      site = new PatherySite({ cacheDir: path.join(config.root, '.cache', 'pathery') });
    },
    configureServer(server) {
      server.middlewares.use(patheryRoutes(site));
    },
    configurePreviewServer(server) {
      server.middlewares.use(patheryRoutes(site));
    },
  };
}
