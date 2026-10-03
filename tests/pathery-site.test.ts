import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMapCode } from '../src/engine/mapcode';
import {
  fetchSiteDay,
  fetchSiteMap,
  parseSiteMapKey,
  patheryDate,
  SiteError,
  siteMapKey,
} from '../src/game/pathery';
import type { SiteMapInfo } from '../src/game/pathery';
import { GameStorage } from '../src/game/storage';
import { PatherySite } from '../tools/pathery-site';
import type { FetchText } from '../tools/pathery-site';

const API = path.join(__dirname, '..', 'reference', 'original', 'api');
const mapText = (id: number) => fs.readFileSync(path.join(API, `map_${id}.json`), 'utf8');

describe('patheryDate', () => {
  it('rolls over at midnight US Eastern', () => {
    // EDT (UTC-4): map files for 2026-10-03 expire at 2026-10-04T04:00Z.
    expect(patheryDate(new Date('2026-10-04T03:59:59Z'))).toBe('2026-10-03');
    expect(patheryDate(new Date('2026-10-04T04:00:00Z'))).toBe('2026-10-04');
    // EST (UTC-5)
    expect(patheryDate(new Date('2026-01-15T04:59:59Z'))).toBe('2026-01-14');
    expect(patheryDate(new Date('2026-01-15T05:00:00Z'))).toBe('2026-01-15');
  });

  it('matches the expiry of a saved daily map', () => {
    const m = JSON.parse(mapText(23462)) as { dateExpires: number };
    expect(patheryDate(new Date(m.dateExpires * 1000 - 1))).not.toBe(
      patheryDate(new Date(m.dateExpires * 1000)),
    );
  });
});

describe('site map keys', () => {
  it('round-trips and rejects other keys', () => {
    expect(siteMapKey(23445)).toBe('pathery-23445');
    expect(parseSiteMapKey('pathery-23445')).toBe(23445);
    expect(parseSiteMapKey(' Pathery-7 ')).toBe(7);
    expect(parseSiteMapKey('complex-123456')).toBeNull();
    expect(parseSiteMapKey('pathery-')).toBeNull();
    expect(parseSiteMapKey('pathery-1x')).toBeNull();
  });
});

describe('PatherySite (server side)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup(pages: Record<string, string>) {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathery-site-'));
    dirs.push(cacheDir);
    const urls: string[] = [];
    const fetchText: FetchText = async (url) => {
      urls.push(url);
      const rel = url.replace('https://www.pathery.com/', '');
      const text = pages[rel];
      return text === undefined ? { status: 404, text: 'nope' } : { status: 200, text };
    };
    const site = new PatherySite({
      cacheDir,
      fetchText,
      delayMs: 0,
      now: () => new Date('2026-10-03T18:00:00Z'),
    });
    return { site, urls, cacheDir };
  }

  it("downloads today's list and maps once, then serves them from disk", async () => {
    const pages = {
      'a/mapsbydate/2026-10-03.js': '[23462,23445]',
      'a/map/23462.js': mapText(23462),
      'a/map/23445.js': mapText(23445),
    };
    const { site, urls, cacheDir } = setup(pages);
    const day = await site.today();
    expect(day.date).toBe('2026-10-03');
    expect(day.maps.map((m) => [m.id, m.name])).toEqual([
      [23462, 'Simple'],
      [23445, 'Ultra Complex Unlimited'],
    ]);
    for (const m of day.maps) expect(parseMapCode(m.code).width).toBeGreaterThan(0);
    expect(urls).toHaveLength(3);

    expect(await site.today()).toEqual(day);
    expect(urls).toHaveLength(3);

    // A fresh instance (server restart) reads the disk cache too.
    const again = new PatherySite({
      cacheDir,
      fetchText: () => Promise.reject(new Error('no network')),
      now: () => new Date('2026-10-03T18:00:00Z'),
    });
    expect(await again.today()).toEqual(day);
  });

  it("doesn't cache an empty list (maps not posted yet)", async () => {
    const pages: Record<string, string> = { 'a/mapsbydate/2026-10-03.js': '[]' };
    const { site, urls } = setup(pages);
    expect((await site.today()).maps).toEqual([]);
    pages['a/mapsbydate/2026-10-03.js'] = '[23462]';
    pages['a/map/23462.js'] = mapText(23462);
    expect((await site.today()).maps.map((m) => m.id)).toEqual([23462]);
    expect(urls).toHaveLength(3);
  });

  it('reports HTTP errors and bad files without caching them', async () => {
    const { site, cacheDir } = setup({ 'a/map/5.js': mapText(23462) });
    await expect(site.map(4)).rejects.toThrow('a/map/4.js: HTTP 404');
    await expect(site.map(5)).rejects.toThrow('unexpected map file for 5');
    expect(fs.existsSync(path.join(cacheDir, 'maps'))).toBe(false);
  });

  it('downloads one at a time', async () => {
    let active = 0;
    let most = 0;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathery-site-'));
    dirs.push(cacheDir);
    const site = new PatherySite({
      cacheDir,
      delayMs: 0,
      fetchText: async (url) => {
        most = Math.max(most, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        const id = Number(/(\d+)\.js$/.exec(url)![1]);
        return { status: 200, text: mapText(id) };
      },
    });
    await Promise.all([23462, 23463, 23464, 23465].map((id) => site.map(id)));
    expect(most).toBe(1);
  });
});

describe('client fetch', () => {
  const info: SiteMapInfo = { id: 1, name: 'Simple', code: '3.1.0.Simple...:,s1.,f1.', expires: 9 };
  const respond = (status: number, body: string) => async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

  it('returns valid responses', async () => {
    const day = { date: '2026-10-03', maps: [info] };
    expect(await fetchSiteDay(respond(200, JSON.stringify(day)))).toEqual(day);
    expect(await fetchSiteMap(1, respond(200, JSON.stringify(info)))).toEqual(info);
  });

  it('explains a missing local server and passes on upstream errors', async () => {
    await expect(fetchSiteDay(respond(404, '<!doctype html>'))).rejects.toThrow(/npm run dev/);
    await expect(fetchSiteDay(respond(200, '<!doctype html>'))).rejects.toThrow(/npm run dev/);
    await expect(
      fetchSiteMap(1, respond(502, JSON.stringify({ error: 'a/map/1.js: HTTP 500' }))),
    ).rejects.toThrow('pathery.com: a/map/1.js: HTTP 500');
    await expect(
      fetchSiteDay(() => Promise.reject(new TypeError('offline'))),
    ).rejects.toBeInstanceOf(SiteError);
    await expect(fetchSiteMap(1, respond(200, '{"id":1}'))).rejects.toBeInstanceOf(SiteError);
  });
});

describe('GameStorage site maps', () => {
  it('saves maps and days, and only returns complete days', () => {
    const s = new GameStorage(null);
    const a: SiteMapInfo = { id: 10, name: 'Simple', code: 'x:', expires: 1 };
    const b: SiteMapInfo = { id: 11, name: 'Normal', code: 'y:', expires: 1 };
    expect(s.getSiteDay('2026-10-03')).toBeNull();
    s.putSiteDay({ date: '2026-10-03', maps: [a, b] });
    expect(s.getSiteDay('2026-10-03')).toEqual({ date: '2026-10-03', maps: [a, b] });
    expect(s.getSiteMap(11)).toEqual(b);
    expect(s.getSiteMap(12)).toBeNull();
  });
});
