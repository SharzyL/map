// anitabi's anime pilgrimage spots (www.anitabi.cn), loaded the way its own
// map loads them. Experimental.
//
// - g.json is the index: every work with the position and priority of each of
//   its spots, works newest edit first, and the time of the latest edit.
// - g0.json, g1.json, ... hold the spots' details (name, screenshot, episode,
//   where the find came from), `pageSize` works each, in the index's order.
// - The whole merged list is kept in IndexedDB. The next load draws from it
//   at once, then asks for the index: nothing newer, and it is done;
//   otherwise it fetches chunks only until it reaches a work whose details
//   are unchanged since the copy, since everything after it is older.
//
// Every file goes through the Worker (/api/v1/anitabi/*, as anitabi sends no
// CORS headers) with anitabi's own cache key, `d`, which turns over every 24
// minutes, so the edge shares its copies with anitabi's other readers.

export const ANITABI_API = '/api/v1/anitabi';
export const ANITABI_ORIGIN = 'https://www.anitabi.cn';
const IMAGE_ORIGIN = 'https://img-tc.anitabi.cn/';

export type AnitabiPoint = {
  id: string;
  // [lat, lng]
  geo: [number, number];
  // Higher shows from further out (ANITABI_PRIORITY_FILTER)
  priority: number;
  name?: string;
  cn?: string;
  image?: string;
  ep?: string | number;
  // Seconds into the episode
  s?: number;
  mark?: string;
  origin?: string;
  originLink?: string;
  // Google My Maps map the spot came from
  mid?: string;
  uid?: number;
  folder?: string;
};

export type AnitabiWork = {
  id: number;
  cn?: string;
  en?: string;
  title?: string;
  city?: string;
  color?: string;
  cover?: string;
  cat?: string;
  // [lat, lng]
  geo?: [number, number];
  zoom?: number;
  tags: string[];
  priority: number;
  points: AnitabiPoint[];
  // When the work's details were last edited; missing until a chunk gave them
  modified?: number;
};

export type AnitabiData = { works: AnitabiWork[]; modified: number };

type Raw = unknown[];

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

// A contributor's id; 0 or nothing is none
function contributor(value: unknown) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : num(value);
  return id ? id : undefined;
}

// anitabi's own cache key (`d` on every file): base 36 of 24-minute periods.
export function anitabiKey(now = Date.now()) {
  return (Math.floor(now / 1e3 / 60 / 24) + 6).toString(36);
}

// The index: [works, pageSize, modified], each work
// [id, cn, en, title, city, color, cover, fade, cat, lat, lng, zoom,
//  [pid, lat, lng, priority, pid, lat, lng, priority, ...], abbr, tags, priority, icon, tAbbr].
export function parseIndex(raw: unknown): { works: AnitabiWork[]; pageSize: number; modified: number } {
  if (!Array.isArray(raw) || !Array.isArray(raw[0])) throw new Error('anitabi index is not in the expected form');
  const works: AnitabiWork[] = [];
  for (const row of raw[0] as Raw[]) {
    if (!Array.isArray(row) || typeof row[0] !== 'number') continue;
    const flat = Array.isArray(row[12]) ? row[12] : [];
    const points: AnitabiPoint[] = [];
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const lat = num(flat[i + 1]);
      const lng = num(flat[i + 2]);
      if (typeof flat[i] !== 'string' || lat === undefined || lng === undefined) continue;
      points.push({ id: flat[i] as string, geo: [lat, lng], priority: num(flat[i + 3]) || 999 });
    }
    const lat = num(row[9]);
    const lng = num(row[10]);
    works.push({
      id: row[0] as number,
      cn: str(row[1]),
      en: str(row[2]),
      title: str(row[3]),
      city: str(row[4]),
      color: str(row[5]),
      cover: str(row[6]),
      cat: str(row[8]),
      geo: lat !== undefined && lng !== undefined ? [lat, lng] : undefined,
      zoom: num(row[11]),
      tags: Array.isArray(row[14]) ? row[14].filter((tag): tag is string => typeof tag === 'string') : [],
      priority: num(row[15]) || 999,
      points,
    });
  }
  return { works, pageSize: num(raw[1]) || 250, modified: num(raw[2]) || 0 };
}

type PointDetail = Omit<AnitabiPoint, 'geo' | 'priority'>;
export type AnitabiChunkWork = { id: number; points: PointDetail[]; modified: number };

// A chunk: works [id, theme, points, modified], each point
// [id, name, cn, isFolder, mid, uid, image, fid, ep, s, mark, origin, originLink, folder, density].
export function parseChunk(raw: unknown): AnitabiChunkWork[] {
  if (!Array.isArray(raw)) throw new Error('anitabi chunk is not in the expected form');
  const works: AnitabiChunkWork[] = [];
  for (const row of raw as Raw[]) {
    if (!Array.isArray(row) || typeof row[0] !== 'number' || !Array.isArray(row[2])) continue;
    const points: PointDetail[] = [];
    for (const p of row[2] as Raw[]) {
      if (!Array.isArray(p) || typeof p[0] !== 'string') continue;
      const ep = typeof p[8] === 'number' ? p[8] : str(p[8]);
      points.push({
        id: p[0],
        name: str(p[1]),
        cn: str(p[2]),
        mid: str(p[4]),
        uid: contributor(p[5]),
        image: str(p[6]),
        ep: ep === 0 ? undefined : ep,
        s: num(p[9]) || undefined,
        mark: str(p[10]),
        origin: str(p[11]),
        originLink: str(p[12]),
        folder: str(p[13]),
      });
    }
    works.push({ id: row[0], points, modified: num(row[3]) || 0 });
  }
  return works;
}

// A work's spots as the index places them, with what details give of each.
// A spot the details lack keeps only its place.
export function withDetails(positions: AnitabiPoint[], details: PointDetail[]): AnitabiPoint[] {
  const byId = new Map(details.map((point) => [point.id, point]));
  return positions.map((position) => ({ ...byId.get(position.id), ...position }));
}

export type AnitabiCache = {
  read(): Promise<AnitabiData | null>;
  write(data: AnitabiData): Promise<void>;
};

export type LoadProgress = {
  // Chunks fetched so far and in all; 0 of 0 while the index loads
  done: number;
  total: number;
  fromCache: boolean;
};

export type LoadOptions = {
  fetchJson(file: string, key: string): Promise<unknown>;
  cache?: AnitabiCache;
  // The works as they stand: from the cache, after the index, after each chunk
  onData?(works: AnitabiWork[], progress: LoadProgress): void;
  now?: number;
};

export async function loadAnitabi({ fetchJson, cache, onData, now }: LoadOptions): Promise<AnitabiData> {
  const cached = cache ? await cache.read().catch((): null => null) : null;
  if (cached) onData?.(cached.works, { done: 0, total: 0, fromCache: true });
  const key = anitabiKey(now);

  let index: ReturnType<typeof parseIndex>;
  try {
    index = parseIndex(await fetchJson('g.json', key));
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
  if (cached && cached.modified >= index.modified) return cached;

  // The index's places stay; the cached details carry over until a chunk
  // replaces them.
  const previous = new Map((cached?.works || []).map((work) => [work.id, work]));
  const positions = new Map(index.works.map((work) => [work.id, work.points]));
  const byId = new Map<number, AnitabiWork>();
  for (const work of index.works) {
    const old = previous.get(work.id);
    if (old?.modified !== undefined) {
      work.points = withDetails(work.points, old.points);
      work.modified = old.modified;
    }
    byId.set(work.id, work);
  }
  const total = Math.ceil(index.works.length / index.pageSize);
  onData?.(index.works, { done: 0, total, fromCache: false });

  for (let chunk = 0; chunk < total; chunk++) {
    const details = parseChunk(await fetchJson(`g${chunk}.json`, key));
    let reachedCopy = false;
    for (const detail of details) {
      const work = byId.get(detail.id);
      if (!work) continue;
      if (previous.get(detail.id)?.modified === detail.modified) {
        reachedCopy = true;
        continue;
      }
      work.points = withDetails(positions.get(work.id), detail.points);
      work.modified = detail.modified;
    }
    onData?.(index.works, { done: chunk + 1, total, fromCache: false });
    // Chunks run newest edit first: past an unchanged work, all is as cached.
    if (reachedCopy) break;
  }

  const data = { works: index.works, modified: index.modified };
  await cache?.write(data).catch(() => {});
  return data;
}

// users.csv: "id,nickname" lines
export function parseUsers(text: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const comma = line.indexOf(',');
    if (comma > 0 && /^\d+$/.test(line.slice(0, comma))) users.set(Number(line.slice(0, comma)), line.slice(comma + 1));
  }
  return users;
}

// anitabi's image paths: /images/... are on its image host, which also
// serves smaller versions (`plan`, e.g. h160 or h360).
export function anitabiImageUrl(path: string | undefined, plan?: string): string | undefined {
  if (!path) return undefined;
  let url = path;
  if (url.startsWith('/images/')) {
    url = IMAGE_ORIGIN + url.slice('/images/'.length);
    if (plan) url += `${url.includes('?') ? '&' : '?'}plan=${plan}`;
    return url;
  }
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`;
  if (url.startsWith('/')) return ANITABI_ORIGIN + url;
  return url;
}

export function bangumiUrl(workId: number) {
  return `https://bgm.tv/subject/${workId}`;
}

export function anitabiMapUrl(workId: number, pointId?: string) {
  const query = new URLSearchParams({ bangumiId: String(workId) });
  if (pointId) query.set('pid', pointId);
  return `${ANITABI_ORIGIN}/map?${query}`;
}

// Where a spot was found: its source's link, else the Google My Maps map it
// came from.
export function originUrl(point: AnitabiPoint): string | undefined {
  if (point.originLink) return point.originLink;
  if (point.mid) {
    const [lat, lng] = point.geo;
    return `https://www.google.com/maps/d/viewer?mid=${encodeURIComponent(point.mid)}&ll=${lat}%2C${lng}&z=16`;
  }
  return undefined;
}

// --- IndexedDB -----------------------------------------------------------

const DB_NAME = 'atlas-realm-anitabi';
const STORE = 'data';
const RECORD = 'spots-v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// The merged list, kept between visits; missing or failing storage only costs
// a full download.
export function indexedDbCache(): AnitabiCache {
  return {
    async read() {
      const db = await openDb();
      try {
        return await new Promise<AnitabiData | null>((resolve, reject) => {
          const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
          request.onsuccess = () => {
            const value = request.result as AnitabiData | undefined;
            resolve(value && Array.isArray(value.works) && typeof value.modified === 'number' ? value : null);
          };
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    },
    async write(data) {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE, 'readwrite');
          transaction.objectStore(STORE).put(data, RECORD);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
  };
}
