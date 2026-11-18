import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatBytes,
  formatDuration,
  headline,
  movedInputs,
  outputHash,
  shortVersion,
  standing,
  stepNames,
  type BuildState,
  type GraphStep,
} from './model.js';

const NOW = Date.parse('2026-11-18T06:00:00Z');

// feed ── fetch ── pack ── publish, with a check publish waits for
function state(): BuildState {
  const step = (over: Partial<GraphStep>): GraphStep => ({
    about: '',
    sources: [],
    needs: [],
    after: [],
    outs: [],
    ...over,
  });
  const at = '2026-11-18T05:00:00Z';
  return {
    saved_at: at,
    sources: { feed: { version: '2', checked_at: at, changed_at: at } },
    graph: {
      sources: { feed: { about: 'A feed', manual: false } },
      steps: {
        publish: step({ kind: 'deploy', needs: ['pack/out.txt'], after: ['tested'] }),
        pack: step({ kind: 'build', needs: ['fetch/data/a.csv'], outs: ['out.txt'] }),
        fetch: step({ kind: 'build', sources: ['feed'], outs: ['data'] }),
        tested: step({ kind: 'check' }),
      },
    },
    steps: {
      fetch: {
        fingerprint: 'f1',
        inputs: { run: '', sources: { feed: '2' }, needs: {} },
        outputs: {
          data: {
            hash: 'd1',
            size: 30,
            files: { 'a.csv': { hash: 'a1', size: 10 }, 'b.csv': { hash: 'b1', size: 20 } },
          },
        },
        built_at: at,
        duration_s: 12,
        attempt: { status: 'ok', at, duration_s: 12 },
      },
      pack: {
        fingerprint: 'p1',
        inputs: { run: '', sources: {}, needs: { 'fetch/data/a.csv': 'a1' } },
        outputs: { 'out.txt': { hash: 'o1', size: 5 } },
        built_at: at,
        duration_s: 3,
        attempt: { status: 'ok', at, duration_s: 3 },
      },
      publish: {
        fingerprint: 'u1',
        inputs: { run: '', sources: {}, needs: { 'pack/out.txt': 'o1' } },
        built_at: at,
        duration_s: 1,
        attempt: { status: 'ok', at, duration_s: 1 },
      },
      tested: {
        fingerprint: 't1',
        inputs: { run: '', sources: {}, needs: {} },
        built_at: at,
        attempt: { status: 'ok', at },
      },
    },
  };
}

describe('standing', () => {
  it('is ok for a step built from what its inputs are now', () => {
    const s = state();
    expect(stepNames(s).map((name) => standing(s, name, NOW))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(headline(s, NOW)).toEqual({ tone: 'ok', text: 'Everything is built, checked and deployed' });
  });

  it('is waiting once a source or an input has moved on', () => {
    const s = state();
    s.sources.feed.version = '3';
    expect(standing(s, 'fetch', NOW)).toBe('waiting');
    expect(movedInputs(s, 'fetch')).toEqual(['feed']);
    // A file inside an output directory is followed by its own hash
    expect(outputHash(s, 'fetch/data/a.csv')).toBe('a1');
    s.steps.fetch.outputs.data.files['b.csv'].hash = 'b2';
    expect(standing(s, 'pack', NOW)).toBe('ok');
    s.steps.fetch.outputs.data.files['a.csv'].hash = 'a2';
    expect(standing(s, 'pack', NOW)).toBe('waiting');
    expect(headline(s, NOW).text).toBe('2 steps have yet to run: fetch, pack');
  });

  it('tells running, failed and cut off apart', () => {
    const s = state();
    s.steps.pack.attempt = { status: 'running', at: '2026-11-18T05:50:00Z' };
    s.steps.tested.attempt = { status: 'failed', at: '2026-11-18T05:40:00Z', error: 'exit code 1' };
    expect(standing(s, 'pack', NOW)).toBe('running');
    expect(standing(s, 'tested', NOW)).toBe('failed');
    expect(headline(s, NOW)).toEqual({ tone: 'running', text: 'A build is running: pack; 1 failed' });
    // Left running by a runner that is long gone
    expect(standing(s, 'pack', NOW + 7 * 3600_000)).toBe('stopped');
    delete s.steps.publish;
    expect(standing(s, 'publish', NOW)).toBe('never');
  });

  it('lists steps after what they depend on', () => {
    const names = stepNames(state());
    expect(names.indexOf('fetch')).toBeLessThan(names.indexOf('pack'));
    expect(names.indexOf('pack')).toBeLessThan(names.indexOf('publish'));
    expect(names.indexOf('tested')).toBeLessThan(names.indexOf('publish'));
  });
});

describe('formats', () => {
  it('says durations in the units that matter', () => {
    expect([0.4, 9.96, 46, 60, 324, 4820, 7200].map(formatDuration)).toEqual([
      '0.4 s',
      '10.0 s',
      '46 s',
      '1 min',
      '5 min 24 s',
      '1 h 20 min',
      '2 h',
    ]);
    expect(formatDuration(null)).toBe('');
  });

  it('says sizes in decimal units', () => {
    expect([61, 93293, 32632791, 695516130, 3424630296].map(formatBytes)).toEqual([
      '61 B',
      '93.3 KB',
      '32.6 MB',
      '696 MB',
      '3.4 GB',
    ]);
  });

  it('says how long ago', () => {
    const ago = (seconds: number) => formatAgo(new Date(NOW - seconds * 1000).toISOString(), NOW);
    expect([10, 90, 3600, 5400, 86400 * 3].map(ago)).toEqual([
      'just now',
      '2 minutes ago',
      '1 hour ago',
      '2 hours ago',
      '3 days ago',
    ]);
  });

  it('shortens digests only', () => {
    expect(shortVersion('sha256:737990d1528dcfcd378bdb48a4a04b1f73544262c745b45e0e831a8c24dfd8a0')).toBe(
      'sha256:737990d1528d…',
    );
    expect(shortVersion('planet-261109.osm.pbf')).toBe('planet-261109.osm.pbf');
  });
});
