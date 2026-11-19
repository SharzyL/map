// What the build dashboard reads out of the build's state (the JSON
// data_builder/builder.py keeps, as src/worker/build-dashboard.ts passes it on):
// each step's standing, and how to say times, durations and sizes.

export type StepKind = 'build' | 'check' | 'deploy';

export interface GraphStep {
  about: string;
  sources: string[];
  needs: string[]; // "step/output"
  after: string[];
  outs: string[];
  kind?: StepKind;
  deploy?: boolean;
  cpus?: number;
  memory?: number;
}

export interface OutputRecord {
  hash: string;
  size: number;
  files?: Record<string, { hash: string; size: number | null }>;
}

export interface RunInfo {
  id: string;
  url: string;
  event?: string;
  commit?: string;
}

export interface Attempt {
  status: 'running' | 'ok' | 'failed' | 'adopted';
  at: string;
  duration_s?: number;
  reasons?: string[];
  error?: string;
  run?: RunInfo | null;
}

export interface StepRecord {
  fingerprint?: string;
  inputs?: {
    run: string;
    sources: Record<string, string>;
    needs: Record<string, string | null>;
    file_count?: number;
  };
  outputs?: Record<string, OutputRecord>;
  built_at?: string;
  duration_s?: number | null;
  attempt?: Attempt;
}

export interface SourcePin {
  version: string;
  checked_at: string;
  changed_at: string;
  probe_failed_at?: string;
}

export interface BuildState {
  saved_at: string;
  sources: Record<string, SourcePin>;
  steps: Record<string, StepRecord>;
  graph: {
    sources: Record<string, { about: string; manual: boolean }>;
    steps: Record<string, GraphStep>;
  };
}

// Where a step stands:
//   ok       it ran with what its inputs are now
//   running  a build is on it
//   failed   its last attempt failed (what it made before is still in use)
//   stopped  it was left running by a build that is gone
//   waiting  it ran, but a source or an input has changed since
//   never    it has not run
export type Standing = 'ok' | 'running' | 'failed' | 'stopped' | 'waiting' | 'never';

// A step still "running" after this long was cut off with its runner
// (GitHub ends a job at six hours)
const RUNNING_FOR_AT_MOST_MS = 6.5 * 3600_000;

export function stepKind(step: GraphStep): StepKind {
  return step.kind ?? (step.deploy ? 'deploy' : 'build');
}

// The hash the state has for "step/output", or for a file inside an output directory
export function outputHash(state: BuildState, need: string): string | null {
  const [step, ...rest] = need.split('/');
  const path = rest.join('/');
  const outputs = state.steps[step]?.outputs ?? {};
  if (outputs[path]) return outputs[path].hash;
  for (const [name, record] of Object.entries(outputs)) {
    if (path.startsWith(`${name}/`)) return record.files?.[path.slice(name.length + 1)]?.hash ?? null;
  }
  return null;
}

// What a step's inputs have moved on to since it ran: sources pinned to
// another version, and outputs of other steps that came out different. (The
// repository's files are not in the state, so a commit alone does not show.)
export function movedInputs(state: BuildState, name: string): string[] {
  const record = state.steps[name];
  const step = state.graph.steps[name];
  if (!record?.inputs || !step) return [];
  const moved: string[] = [];
  for (const source of step.sources) {
    const pinned = state.sources[source]?.version;
    if (pinned !== undefined && record.inputs.sources[source] !== pinned) moved.push(source);
  }
  for (const need of step.needs) {
    if ((record.inputs.needs[need] ?? null) !== outputHash(state, need)) moved.push(need);
  }
  return moved;
}

export function standing(state: BuildState, name: string, now = Date.now()): Standing {
  const record = state.steps[name];
  const attempt = record?.attempt;
  if (attempt?.status === 'running') {
    return now - Date.parse(attempt.at) > RUNNING_FOR_AT_MOST_MS ? 'stopped' : 'running';
  }
  if (attempt?.status === 'failed') return 'failed';
  if (!record?.fingerprint) return 'never';
  return movedInputs(state, name).length ? 'waiting' : 'ok';
}

const STANDING_WORDS: Record<Standing, Record<StepKind, string>> = {
  ok: { build: 'Built', check: 'Passed', deploy: 'Deployed' },
  running: { build: 'Building', check: 'Checking', deploy: 'Deploying' },
  failed: { build: 'Failed', check: 'Failed', deploy: 'Failed' },
  stopped: { build: 'Cut off', check: 'Cut off', deploy: 'Cut off' },
  waiting: { build: 'Out of date', check: 'To check again', deploy: 'To deploy' },
  never: { build: 'Not built', check: 'Not checked', deploy: 'Not deployed' },
};

export function standingWord(kind: StepKind, where: Standing): string {
  return STANDING_WORDS[where][kind];
}

// The steps in an order that puts each after the ones it depends on, as the
// state's graph lists them (the step file's own order, dependencies first)
export function stepNames(state: BuildState): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const visit = (name: string) => {
    if (seen.has(name) || !state.graph.steps[name]) return;
    seen.add(name);
    const step = state.graph.steps[name];
    for (const need of step.needs) visit(need.split('/')[0]);
    for (const other of step.after) visit(other);
    names.push(name);
  };
  Object.keys(state.graph.steps).forEach(visit);
  return names;
}

export interface Headline {
  tone: 'ok' | 'running' | 'failed' | 'waiting';
  text: string;
}

function listed(names: string[], most = 3): string {
  if (names.length <= most) return names.join(', ');
  return `${names.slice(0, most).join(', ')} and ${names.length - most} more`;
}

// The one sentence the page opens with
export function headline(state: BuildState, now = Date.now()): Headline {
  const names = stepNames(state);
  const by = (where: Standing) => names.filter((name) => standing(state, name, now) === where);
  const running = by('running');
  const failed = [...by('failed'), ...by('stopped')];
  const waiting = [...by('waiting'), ...by('never')];
  if (running.length) {
    const also = failed.length ? `; ${failed.length} failed` : '';
    return { tone: 'running', text: `A build is running: ${listed(running)}${also}` };
  }
  if (failed.length) {
    const verb = failed.length === 1 ? 'is failing' : 'are failing';
    return { tone: 'failed', text: `${listed(failed)} ${verb}; what they made before is still in use` };
  }
  if (waiting.length) {
    const noun = waiting.length === 1 ? 'step has' : 'steps have';
    return { tone: 'waiting', text: `${waiting.length} ${noun} yet to run: ${listed(waiting)}` };
  }
  return { tone: 'ok', text: 'Everything is built, checked and deployed' };
}

// ── Saying things ───────────────────────────────────────

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit += 1;
  } while (value >= 999.5 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// "5 minutes ago", "in 2 days": the nearest whole unit
export function formatAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const units: Array<[number, string]> = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
  ];
  let [size, word] = units[0];
  for (const unit of units) if (Math.abs(seconds) >= unit[0] * 0.95) [size, word] = unit;
  const count = Math.max(1, Math.round(Math.abs(seconds) / size));
  const span = `${count} ${word}${count === 1 ? '' : 's'}`;
  return seconds >= 0 ? `${span} ago` : `in ${span}`;
}

// A UTC time as the reader's own, to the minute
export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// A source's version, short enough for a table: digests keep their start
export function shortVersion(version: string): string {
  const digest = /^sha256:([0-9a-f]{12})[0-9a-f]+$/.exec(version);
  return digest ? `sha256:${digest[1]}…` : version;
}

// The total a step wrote, and how many files in its output directories
export function outputSize(record: StepRecord | undefined): number | null {
  const outputs = Object.values(record?.outputs ?? {});
  return outputs.length ? outputs.reduce((sum, output) => sum + output.size, 0) : null;
}
