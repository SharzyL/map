import { describe, expect, it } from 'vitest';
import { handleBuildDashboardRequest, publicState } from './build-dashboard.js';

// A bucket of JSON objects, as far as the dashboard's requests read one
function bucket(objects: Record<string, { body: unknown; uploaded: string }>) {
  const entry = (key: string) => ({
    key,
    uploaded: new Date(objects[key].uploaded),
    json: async () => objects[key].body,
  });
  return {
    get: async (key: string) => (objects[key] ? entry(key) : null),
    list: async ({ prefix }: { prefix: string }) => ({
      objects: Object.keys(objects)
        .filter((key) => key.startsWith(prefix))
        .map(entry),
      truncated: false,
    }),
  };
}

const call = async (path: string, objects: Parameters<typeof bucket>[0]) => {
  const env = { ORM_BUCKET: bucket(objects) } as unknown as Cloudflare.Env;
  return handleBuildDashboardRequest(new Request(`https://map.test${path}`), env);
};

describe('publicState', () => {
  it('keeps the number of files read and drops the last lines of output', () => {
    const state = {
      saved_at: 'now',
      steps: {
        tested: {
          fingerprint: 'f',
          inputs: { run: 'pnpm test', sources: {}, needs: {}, files: { 'a.ts': 'h1', 'b.ts': 'h2' } },
          attempt: { status: 'failed', error: 'exit code 1', log_tail: ['secret?'] },
        },
        never: {},
      },
    };
    expect(publicState(state)).toEqual({
      saved_at: 'now',
      steps: {
        tested: {
          fingerprint: 'f',
          inputs: { run: 'pnpm test', sources: {}, needs: {}, file_count: 2 },
          attempt: { status: 'failed', error: 'exit code 1' },
        },
        never: {},
      },
    });
  });
});

describe('handleBuildDashboardRequest', () => {
  it('passes the state on, briefly cached', async () => {
    const resp = await call('/build-dashboard/state.json', {
      'build/state.json': { body: { saved_at: 'then', steps: {} }, uploaded: '2026-11-18T05:00:00Z' },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('cache-control')).toBe('public, max-age=15');
    expect(await resp.json()).toEqual({ saved_at: 'then', steps: {}, uploaded: '2026-11-18T05:00:00.000Z' });
  });

  it('says so when no build has reported', async () => {
    const resp = await call('/build-dashboard/state.json', {});
    expect(resp.status).toBe(404);
    expect(resp.headers.get('cache-control')).toBe('no-store');
  });

  it('lists the runs that left a report, newest first', async () => {
    const resp = await call('/build-dashboard/runs.json', {
      'build/runs/100.json': { body: {}, uploaded: '2026-11-17T05:00:00Z' },
      'build/runs/300.json': { body: {}, uploaded: '2026-11-18T05:00:00Z' },
      'build/runs/200.json': { body: {}, uploaded: '2026-11-18T01:00:00Z' },
      'build/state.json': { body: {}, uploaded: '2026-11-18T05:00:00Z' },
    });
    expect(((await resp.json()) as { runs: Array<{ id: string }> }).runs.map((run) => run.id)).toEqual([
      '300',
      '200',
      '100',
    ]);
  });

  it('leaves the page itself to the static assets', async () => {
    expect(await call('/build-dashboard/', {})).toBeNull();
  });
});
