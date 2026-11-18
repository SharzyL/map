// The build dashboard (/build-dashboard): the data build's graph, when each
// data source last changed, and how long each step took, from the state the
// build keeps (/build-dashboard/state.json, src/worker/build-dashboard.ts).
// The page asks again while it is open, sooner while a build is running.

import './style.css';
import { edgePath, layoutGraph, related, SOURCE_PREFIX, type Layout, type LayoutNode } from './layout.js';
import {
  formatAgo,
  formatBytes,
  formatDuration,
  formatTime,
  headline,
  movedInputs,
  outputSize,
  shortVersion,
  standing,
  standingWord,
  stepKind,
  stepNames,
  type BuildState,
  type Standing,
  type StepKind,
} from './model.js';

const STATE_URL = '/build-dashboard/state.json';
const RUNS_URL = '/build-dashboard/runs.json';
const REFRESH_MS = 60_000;
const REFRESH_RUNNING_MS = 15_000;
// Room around the graph for the markers and the labels under them
const PAD = { left: 76, top: 22, right: 84, bottom: 62 };

type Run = { id: string; finished_at: string };
type KindFilter = 'all' | StepKind;

const view: {
  state: BuildState | null;
  runs: Run[];
  selected: string | null;
  filter: KindFilter;
  error: string | null;
} = {
  state: null,
  runs: [],
  selected: decodeURIComponent(location.hash.slice(1)) || null,
  filter: 'all',
  error: null,
};

const app = document.getElementById('app');

const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// ── Markers ─────────────────────────────────────────────

// What a node is shows in its shape (a source a block, a build step a disc, a
// check a diamond, a deploy a ringed disc); where it stands in its fill and
// the sign inside, so neither rests on colour alone.
const SHAPES: Record<LayoutNode['kind'], string> = {
  source: '<rect class="shape" x="2.5" y="2.5" width="13" height="13" rx="3"/>',
  build: '<circle class="shape" cx="9" cy="9" r="6.5"/>',
  check: '<path class="shape" d="M9 1.6 16.4 9 9 16.4 1.6 9Z"/>',
  deploy: '<circle class="ring" cx="9" cy="9" r="7.6"/><circle class="shape" cx="9" cy="9" r="4.6"/>',
};
const SIGNS: Partial<Record<Standing, string>> = {
  ok: '<path class="sign" d="M5.6 9.3l2.3 2.3 4.6-5"/>',
  failed: '<path class="sign" d="M6.3 6.3l5.4 5.4M11.7 6.3l-5.4 5.4"/>',
  stopped: '<path class="sign" d="M6.3 6.3l5.4 5.4M11.7 6.3l-5.4 5.4"/>',
  running: '<circle class="sign-dot" cx="9" cy="9" r="1.9"/>',
};

function marker(kind: LayoutNode['kind'], where: Standing | 'source') {
  // The ringed disc is too small inside for a sign; its ring carries the standing
  const sign = where === 'source' || kind === 'deploy' ? '' : (SIGNS[where] ?? '');
  return `<svg class="marker" data-kind="${kind}" data-standing="${where}" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">${SHAPES[kind]}${sign}</svg>`;
}

function nodeStanding(state: BuildState, node: LayoutNode): Standing | 'source' {
  if (node.kind !== 'source') return standing(state, node.name);
  return state.sources[node.name]?.probe_failed_at ? 'failed' : 'source';
}

// ── The graph ───────────────────────────────────────────

function graphHtml(state: BuildState, layout: Layout) {
  const width = layout.width + PAD.left + PAD.right;
  const height = layout.height + PAD.top + PAD.bottom;
  const edges = layout.edges
    .map((edge) => {
      const points = edge.points.map(([x, y]): [number, number] => [x + PAD.left, y + PAD.top]);
      return `<path class="edge edge-${edge.kind}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" d="${edgePath(points)}"/>`;
    })
    .join('');
  const nodes = layout.nodes
    .map((node) => {
      const where = nodeStanding(state, node);
      const record = state.steps[node.name];
      let note: string;
      if (node.kind === 'source') {
        note = shortVersion(state.sources[node.name]?.version ?? 'not pinned');
      } else if (where === 'ok') {
        note = formatDuration(record?.duration_s) || standingWord(node.kind, 'ok');
      } else {
        note = standingWord(node.kind, where as Standing);
      }
      const label =
        node.kind === 'source' ? `Source ${node.name}` : `${node.name}, ${standingWord(node.kind, where as Standing)}`;
      return (
        `<button type="button" class="node" data-id="${esc(node.id)}" aria-label="${esc(label)}" ` +
        `style="left:${node.x + PAD.left}px;top:${node.y + PAD.top}px">` +
        `${marker(node.kind, where)}<span class="node-name">${esc(node.name)}</span>` +
        `<span class="node-note">${esc(note)}</span></button>`
      );
    })
    .join('');
  return (
    `<div class="graph" style="width:${width}px;height:${height}px">` +
    `<svg class="edges" width="${width}" height="${height}" aria-hidden="true">${edges}</svg>${nodes}</div>`
  );
}

const LEGEND =
  '<ul class="legend" aria-label="Legend">' +
  `<li>${marker('source', 'source')}Data source</li>` +
  `<li>${marker('build', 'ok')}Build step</li>` +
  `<li>${marker('check', 'ok')}Check</li>` +
  `<li>${marker('deploy', 'ok')}Deploy</li>` +
  '<li class="legend-gap" aria-hidden="true"></li>' +
  `<li>${marker('build', 'ok')}Done</li>` +
  `<li>${marker('build', 'running')}Running</li>` +
  `<li>${marker('build', 'failed')}Failed</li>` +
  `<li>${marker('build', 'waiting')}Inputs changed since</li>` +
  `<li>${marker('build', 'never')}Not run yet</li>` +
  '<li class="legend-gap" aria-hidden="true"></li>' +
  '<li><svg class="legend-edge" width="30" height="8" aria-hidden="true"><path class="edge edge-reads" d="M0,4 L30,4"/></svg>reads</li>' +
  '<li><svg class="legend-edge" width="30" height="8" aria-hidden="true"><path class="edge edge-after" d="M0,4 L30,4"/></svg>waits for</li>' +
  '</ul>';

// ── A node's details ────────────────────────────────────

function runLink(run: { id: string; url: string } | null | undefined) {
  return run ? `<a href="${esc(run.url)}" rel="noopener">run ${esc(run.id)}</a>` : 'a build on a developer’s machine';
}

function stepLink(name: string) {
  return `<a href="#${encodeURIComponent(name)}" data-select="${esc(name)}">${esc(name)}</a>`;
}

function sourceDetail(state: BuildState, name: string) {
  const pin = state.sources[name];
  const about = state.graph.sources[name];
  const readers = stepNames(state).filter((step) => state.graph.steps[step].sources.includes(name));
  const rows = pin
    ? `<dt>Version in use</dt><dd><code>${esc(pin.version)}</code></dd>` +
      `<dt>Changed</dt><dd>${esc(formatAgo(pin.changed_at))} <span class="quiet">${esc(formatTime(pin.changed_at))}</span></dd>` +
      `<dt>Last asked</dt><dd>${esc(formatAgo(pin.checked_at))} <span class="quiet">${esc(formatTime(pin.checked_at))}</span></dd>` +
      (pin.probe_failed_at
        ? `<dt>Could not be asked</dt><dd>${esc(formatAgo(pin.probe_failed_at))}; the version above stays in use</dd>`
        : '')
    : '<dt>Version in use</dt><dd>none yet</dd>';
  return (
    `<h3>${marker('source', pin?.probe_failed_at ? 'failed' : 'source')}${esc(name)}</h3>` +
    `<p>${esc(about?.about)}${about?.manual ? ' It has no version to ask for, so it changes only when a build is told to refresh it.' : ''}</p>` +
    `<dl>${rows}<dt>Read by</dt><dd>${readers.map(stepLink).join(', ') || 'no step'}</dd></dl>`
  );
}

function stepDetail(state: BuildState, name: string) {
  const step = state.graph.steps[name];
  const record = state.steps[name] ?? {};
  const kind = stepKind(step);
  const where = standing(state, name);
  const attempt = record.attempt;
  const rows: string[] = [];

  let stands = standingWord(kind, where);
  if (where === 'running') stands += `, started ${formatAgo(attempt?.at)} by ${runLink(attempt?.run)}`;
  else if (where === 'failed' || where === 'stopped') {
    stands += ` ${formatAgo(attempt?.at)} in ${runLink(attempt?.run)}${attempt?.error ? `: ${esc(attempt.error)}` : ''}`;
  }
  rows.push(`<dt>Now</dt><dd>${stands}</dd>`);
  if (record.built_at) {
    const took = formatDuration(record.duration_s);
    const by = attempt?.status === 'ok' ? `, by ${runLink(attempt.run)}` : '';
    rows.push(
      `<dt>Last ${kind === 'build' ? 'built' : kind === 'check' ? 'passed' : 'deployed'}</dt>` +
        `<dd>${esc(formatAgo(record.built_at))} <span class="quiet">${esc(formatTime(record.built_at))}</span>` +
        `${took ? `, in ${esc(took)}` : ''}${by}</dd>`,
    );
  }
  if (attempt?.reasons?.length) {
    const reasons = attempt.reasons.map((reason) => (reason === 'never built' ? 'it had not run before' : reason));
    rows.push(`<dt>It ran because</dt><dd>${reasons.map(esc).join('; ')}</dd>`);
  }
  const moved = where === 'waiting' ? movedInputs(state, name) : [];
  if (moved.length) rows.push(`<dt>Changed since</dt><dd>${moved.map(esc).join(', ')}</dd>`);

  const reads = [
    ...step.sources.map((source) => {
      const used = record.inputs?.sources[source];
      return `<li><a href="#${encodeURIComponent(SOURCE_PREFIX + source)}" data-select="${esc(SOURCE_PREFIX + source)}">${esc(source)}</a>${used ? ` at <code>${esc(shortVersion(used))}</code>` : ''}</li>`;
    }),
    ...step.needs.map((need) => {
      const [from, ...path] = need.split('/');
      return `<li>${stepLink(from)} <span class="quiet">${esc(path.join('/'))}</span></li>`;
    }),
  ];
  const files = record.inputs?.file_count;
  if (files) reads.push(`<li>${files} file${files === 1 ? '' : 's'} of the repository</li>`);
  if (reads.length) rows.push(`<dt>Reads</dt><dd><ul>${reads.join('')}</ul></dd>`);
  if (step.after.length) rows.push(`<dt>Waits for</dt><dd>${step.after.map(stepLink).join(', ')}</dd>`);

  const outputs = Object.entries(record.outputs ?? {});
  if (outputs.length) {
    const items = outputs.map(([out, o]) => {
      const count = o.files ? `, ${Object.keys(o.files).length} files` : '';
      return `<li>${esc(out)} <span class="quiet">${esc(formatBytes(o.size))}${count}, hash ${esc(o.hash.slice(0, 8))}</span></li>`;
    });
    rows.push(`<dt>Wrote</dt><dd><ul>${items.join('')}</ul></dd>`);
  } else if (step.outs.length) {
    rows.push(`<dt>Writes</dt><dd>${step.outs.map(esc).join(', ')}</dd>`);
  }
  const readers = stepNames(state).filter((other) =>
    state.graph.steps[other].needs.some((n) => n.split('/')[0] === name),
  );
  if (readers.length) rows.push(`<dt>Read by</dt><dd>${readers.map(stepLink).join(', ')}</dd>`);

  return `<h3>${marker(kind, where)}${esc(name)}</h3><p>${esc(step.about)}</p><dl>${rows.join('')}</dl>`;
}

function detailHtml(state: BuildState, id: string | null) {
  if (id?.startsWith(SOURCE_PREFIX) && state.graph.sources[id.slice(SOURCE_PREFIX.length)]) {
    return sourceDetail(state, id.slice(SOURCE_PREFIX.length));
  }
  if (id && state.graph.steps[id]) return stepDetail(state, id);
  return '<p class="quiet">Point at a step or a source to trace what it depends on and what depends on it; select one to read about it here.</p>';
}

// ── Tables ──────────────────────────────────────────────

function sourcesHtml(state: BuildState) {
  const rows = Object.entries(state.graph.sources)
    .map(([name, about]) => {
      const pin = state.sources[name];
      const failed = pin?.probe_failed_at
        ? ` <span class="flag">could not be asked ${esc(formatAgo(pin.probe_failed_at))}</span>`
        : '';
      return (
        `<tr data-id="${esc(SOURCE_PREFIX + name)}"><th scope="row"><div class="name">${marker('source', pin?.probe_failed_at ? 'failed' : 'source')}` +
        `<span><a href="#${encodeURIComponent(SOURCE_PREFIX + name)}" data-select="${esc(SOURCE_PREFIX + name)}">${esc(name)}</a>` +
        `<small>${esc(about.about)}</small></span></div></th>` +
        `<td><code title="${esc(pin?.version)}">${esc(pin ? shortVersion(pin.version) : 'not pinned')}</code></td>` +
        `<td title="${esc(formatTime(pin?.changed_at))}">${esc(formatAgo(pin?.changed_at))}</td>` +
        `<td title="${esc(formatTime(pin?.checked_at))}">${about.manual ? 'only by hand' : esc(formatAgo(pin?.checked_at))}${failed}</td></tr>`
      );
    })
    .join('');
  return (
    '<div class="table-scroll"><table class="sources"><thead><tr><th scope="col">Source</th><th scope="col">Version in use</th>' +
    '<th scope="col">Changed</th><th scope="col">Last asked</th></tr></thead>' +
    `<tbody>${rows}</tbody></table></div>`
  );
}

// The steps in the graph's reading order: by column, then down each column
function stepsHtml(state: BuildState, layout: Layout, filter: KindFilter) {
  const names = layout.nodes
    .filter((node) => node.kind !== 'source' && (filter === 'all' || node.kind === filter))
    .sort((a, b) => a.layer - b.layer || a.y - b.y)
    .map((node) => node.name);
  const longest = Math.max(1, ...names.map((name) => state.steps[name]?.duration_s ?? 0));
  const rows = names
    .map((name) => {
      const step = state.graph.steps[name];
      const record = state.steps[name] ?? {};
      const kind = stepKind(step);
      const where = standing(state, name);
      const when = where === 'ok' || where === 'waiting' ? record.built_at : record.attempt?.at;
      const seconds = record.duration_s ?? null;
      // The bar's length is the time against the longest step shown
      const bar =
        seconds === null
          ? ''
          : `<span class="bar" style="width:${Math.max(0.6, (seconds / longest) * 100).toFixed(1)}%"></span>`;
      const run = record.attempt?.run;
      return (
        `<tr data-id="${esc(name)}"><th scope="row"><div class="name">${marker(kind, where)}<span>${stepLink(name)}<small>${esc(step.about)}</small></span></div></th>` +
        `<td>${esc(standingWord(kind, where))}${when ? ` <span class="quiet" title="${esc(formatTime(when))}">${esc(formatAgo(when))}</span>` : ''}</td>` +
        `<td class="took"><span class="bar-track">${bar}</span><span class="num">${esc(formatDuration(seconds))}</span></td>` +
        `<td class="num">${esc(formatBytes(outputSize(record)))}</td>` +
        `<td>${run ? `<a href="${esc(run.url)}" rel="noopener">${esc(run.id)}</a>` : record.attempt ? '<span class="quiet">local</span>' : ''}</td></tr>`
      );
    })
    .join('');
  const chips = (['all', 'build', 'check', 'deploy'] as const)
    .map((kind) => {
      const label = { all: 'All steps', build: 'Build', check: 'Checks', deploy: 'Deploys' }[kind];
      return `<button type="button" class="chip" data-filter="${kind}" aria-pressed="${kind === filter}">${label}</button>`;
    })
    .join('');
  return (
    `<div class="filters" role="group" aria-label="Kinds of steps">${chips}</div>` +
    '<div class="table-scroll"><table class="steps"><thead><tr><th scope="col">Step</th><th scope="col">Now</th><th scope="col">Took</th>' +
    '<th scope="col" class="num">Wrote</th><th scope="col">Last run</th></tr></thead>' +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function runsHtml(state: BuildState, runs: Run[]) {
  if (!runs.length) return '<p class="quiet">No run on CI has reported yet.</p>';
  // The runs' pages are where every run in the state links to
  const some = Object.values(state.steps).find((record) => record.attempt?.run)?.attempt.run;
  const base = some ? some.url.slice(0, some.url.lastIndexOf('/') + 1) : null;
  const items = runs
    .map((run) => {
      const name = base
        ? `<a href="${esc(base + run.id)}" rel="noopener">Run ${esc(run.id)}</a>`
        : `Run ${esc(run.id)}`;
      return `<li>${name} <span class="quiet">finished ${esc(formatAgo(run.finished_at))}, ${esc(formatTime(run.finished_at))}</span></li>`;
    })
    .join('');
  return `<ol class="runs">${items}</ol>`;
}

// ── The page ────────────────────────────────────────────

const HEADLINE_MARK: Record<string, Standing> = { ok: 'ok', running: 'running', failed: 'failed', waiting: 'waiting' };

function render() {
  const { state, error } = view;
  const home = '<a class="home" href="/">Sharzy’s Map</a>';
  if (!state) {
    const text = error ?? 'Reading the build’s state…';
    app.innerHTML = `<header>${home}<h1>Map build</h1><p class="headline" data-tone="waiting">${esc(text)}</p></header>`;
    return;
  }
  const layout = layoutGraph(state.graph);
  if (view.selected && !layout.nodes.some((node) => node.id === view.selected)) view.selected = null;
  const top = headline(state);
  const scroll = app.querySelector('.graph-scroll')?.scrollLeft ?? 0;
  // The page is drawn anew; the node the keyboard was on gets the focus back
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.node')?.dataset.id;
  app.innerHTML =
    `<header>${home}<h1>Map build</h1>` +
    `<p class="headline" data-tone="${top.tone}">${marker('build', HEADLINE_MARK[top.tone])}<span>${esc(top.text)}</span></p>` +
    `<p class="quiet">The build last wrote its state ${esc(formatAgo(state.saved_at))}, ${esc(formatTime(state.saved_at))}.` +
    `${error ? ` <span class="flag">${esc(error)}</span>` : ''}</p></header>` +
    `<section aria-labelledby="graph-title"><h2 id="graph-title">From sources to the map</h2>${LEGEND}` +
    `<div class="graph-scroll" tabindex="0" role="group" aria-label="The build graph">${graphHtml(state, layout)}</div>` +
    `<div class="detail" aria-live="polite">${detailHtml(state, view.selected)}</div></section>` +
    `<section aria-labelledby="sources-title"><h2 id="sources-title">Data sources</h2>${sourcesHtml(state)}</section>` +
    `<section aria-labelledby="steps-title"><h2 id="steps-title">Steps</h2>${stepsHtml(state, layout, view.filter)}</section>` +
    `<section aria-labelledby="runs-title"><h2 id="runs-title">Recent runs</h2>${runsHtml(state, view.runs)}</section>`;
  app.querySelector('.graph-scroll').scrollLeft = scroll;
  wire(layout);
  if (focused)
    app.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  trace(layout, view.selected, true);
}

// Lights the node, everything it depends on and everything depending on it
function trace(layout: Layout, id: string | null, pinned = false) {
  const graph = app.querySelector('.graph');
  if (!graph) return;
  const lit = id ? related(layout, id) : null;
  graph.classList.toggle('tracing', Boolean(lit));
  for (const node of graph.querySelectorAll<HTMLElement>('.node')) {
    node.classList.toggle('lit', Boolean(lit?.has(node.dataset.id)));
    node.classList.toggle('focus', node.dataset.id === id);
    if (pinned) node.setAttribute('aria-pressed', String(node.dataset.id === id));
  }
  for (const edge of graph.querySelectorAll<SVGPathElement>('.edge')) {
    edge.classList.toggle('lit', Boolean(lit?.has(edge.dataset.from) && lit.has(edge.dataset.to)));
  }
  for (const row of app.querySelectorAll<HTMLElement>('tr[data-id]')) {
    row.classList.toggle('selected', row.dataset.id === view.selected);
  }
}

function select(id: string | null, reveal = false) {
  view.selected = id;
  history.replaceState(null, '', id ? `#${encodeURIComponent(id)}` : location.pathname + location.search);
  render();
  if (reveal && id) {
    app
      .querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function wire(layout: Layout) {
  for (const node of app.querySelectorAll<HTMLElement>('.node')) {
    const id = node.dataset.id;
    node.addEventListener('pointerenter', () => trace(layout, id));
    node.addEventListener('pointerleave', () => trace(layout, view.selected));
    node.addEventListener('focus', () => trace(layout, id));
    node.addEventListener('blur', () => trace(layout, view.selected));
    node.addEventListener('click', () => select(view.selected === id ? null : id));
  }
  for (const row of app.querySelectorAll<HTMLElement>('tr[data-id]')) {
    row.addEventListener('pointerenter', () => trace(layout, row.dataset.id));
    row.addEventListener('pointerleave', () => trace(layout, view.selected));
  }
  for (const link of app.querySelectorAll<HTMLElement>('[data-select]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      select(link.dataset.select, true);
    });
  }
  for (const chip of app.querySelectorAll<HTMLElement>('[data-filter]')) {
    chip.addEventListener('click', () => {
      view.filter = chip.dataset.filter as KindFilter;
      render();
    });
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && view.selected) select(null);
});

async function load() {
  try {
    const [stateResponse, runsResponse] = await Promise.all([fetch(STATE_URL), fetch(RUNS_URL)]);
    if (stateResponse.status === 404)
      throw new Error('No build has reported yet. The first run of the Build workflow writes its state here.');
    if (!stateResponse.ok) throw new Error(`The build’s state could not be read (HTTP ${stateResponse.status}).`);
    view.state = (await stateResponse.json()) as BuildState;
    view.runs = runsResponse.ok ? ((await runsResponse.json()) as { runs: Run[] }).runs : [];
    view.error = null;
  } catch (error) {
    // What was read before stays on the page, with the trouble said
    view.error =
      error instanceof TypeError
        ? 'The build’s state could not be reached; this may be out of date.'
        : (error as Error).message;
  }
  render();
  const running = view.state && stepNames(view.state).some((name) => standing(view.state, name) === 'running');
  setTimeout(load, running ? REFRESH_RUNNING_MS : REFRESH_MS);
}

void load();
