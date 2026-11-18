// The data behind the build dashboard (/build-dashboard, a page of its own:
// build-dashboard/index.html): the state the data build keeps in the bucket
// under build/ (scripts/build/build.py), and its recent runs.

const STATE_KEY = 'build/state.json';
const RUNS_PREFIX = 'build/runs/';
const MAX_RUNS = 30;

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };

function json(body: unknown, status = 200, maxAge = 0) {
  const cache = maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store';
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'Cache-Control': cache } });
}

type Json = Record<string, unknown>;

// The state as the page gets it: without what it does not show. A step's
// record lists the hash of every repository file it read (hundreds for a
// check of the whole repository), of which only the number is kept, and a
// failed step's last lines of output, which stay private: the run's own log
// on GitHub has them with its secrets masked.
export function publicState(state: Json): Json {
  const steps = Object.fromEntries(
    Object.entries((state.steps ?? {}) as Record<string, Json>).map(([name, record]) => {
      const { inputs, attempt, ...rest } = record as { inputs?: Json; attempt?: Json };
      const slim: Json = { ...rest };
      if (inputs) {
        const { files, ...read } = inputs as { files?: Json };
        slim.inputs = { ...read, file_count: Object.keys(files ?? {}).length };
      }
      if (attempt) {
        const { log_tail: _, ...told } = attempt;
        slim.attempt = told;
      }
      return [name, slim];
    }),
  );
  return { ...state, steps };
}

async function stateResponse(env: Cloudflare.Env) {
  const object = await env.ORM_BUCKET.get(STATE_KEY);
  if (!object) return json({ error: 'no build has written its state yet' }, 404);
  const state = publicState((await object.json()) as Json);
  // Written after every step of a running build, so kept only briefly
  return json({ ...state, uploaded: object.uploaded.toISOString() }, 200, 15);
}

// The latest runs that left a report, newest first: the run's id (GitHub's)
// and when it finished
async function runsResponse(env: Cloudflare.Env) {
  const runs: Array<{ id: string; finished_at: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await env.ORM_BUCKET.list({ prefix: RUNS_PREFIX, cursor });
    for (const object of page.objects) {
      const id = object.key.slice(RUNS_PREFIX.length).replace(/\.json$/, '');
      runs.push({ id, finished_at: object.uploaded.toISOString() });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  runs.sort((a, b) => b.finished_at.localeCompare(a.finished_at));
  return json({ runs: runs.slice(0, MAX_RUNS) }, 200, 60);
}

// The dashboard's data requests; null for anything else under its path, which
// are the page's own files
export async function handleBuildDashboardRequest(request: Request, env: Cloudflare.Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === '/build-dashboard/state.json') return stateResponse(env);
  if (pathname === '/build-dashboard/runs.json') return runsResponse(env);
  return null;
}
