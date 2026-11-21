// The anitabi pass-through (/api/v1/anitabi/*), with a fake anitabi upstream.

import { describe, expect, it } from 'vitest';

import { UpstreamTimeout, type Upstream } from './core.js';
import { handleApi } from './index.js';

function upstream(text: string, status = 200, error: Error | null = null) {
  const calls: Array<[string, number]> = [];
  return {
    calls,
    fetch: async (url: string, ttl: number): Promise<Upstream> => {
      calls.push([url, ttl]);
      if (error) throw error;
      return { status, text };
    },
  };
}

async function call(path: string, fake = upstream('[]')) {
  const resp = await handleApi('GET', `https://map.test/api/v1/anitabi${path}`, { fetch: fake.fetch });
  return { resp, fake };
}

describe('anitabi', () => {
  it('passes the index on as anitabi sends it, with its cache key', async () => {
    const index = '[[[1,"作品",0,"作品",null,"#ff0000"]],250,1700000000000]';
    const { resp, fake } = await call('/g.json?d=qpyd', upstream(index));
    expect(fake.calls).toEqual([['https://www.anitabi.cn/d/g.json?d=qpyd', 3600]]);
    expect(resp.status).toBe(200);
    expect(resp.body).toBe(index);
    expect(resp.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    });
  });

  it('passes chunks and the contributors on', async () => {
    expect((await call('/g12.json')).fake.calls[0][0]).toBe('https://www.anitabi.cn/d/g12.json');
    const { resp } = await call('/users.csv?d=qpyd', upstream('1000,卜卜口\n'));
    expect(resp.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(resp.body).toBe('1000,卜卜口\n');
  });

  it('answers 404 for a chunk anitabi does not have, which it answers with its page', async () => {
    const { resp } = await call('/g7.json?d=qpyd', upstream('<!DOCTYPE html><html></html>'));
    expect(resp.status).toBe(404);
    expect(JSON.parse(resp.body).error.code).toBe('not_found');
  });

  it('fetches only its own files', async () => {
    for (const path of ['/g.js', '/../g.json', '/gx.json', '/users.json', '/']) {
      const { resp, fake } = await call(path);
      expect(resp.status).toBe(404);
      expect(fake.calls).toEqual([]);
    }
    const { resp, fake } = await call('/g.json?d=Q/../x');
    expect(resp.status).toBe(400);
    expect(fake.calls).toEqual([]);
    expect((await call('/g.json?x=1')).resp.status).toBe(400);
  });

  it('reports anitabi failing', async () => {
    expect((await call('/g.json', upstream('', 500))).resp.status).toBe(502);
    expect((await call('/g.json', upstream('', 200, new UpstreamTimeout()))).resp.status).toBe(504);
  });
});
