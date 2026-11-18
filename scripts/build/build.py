#!/usr/bin/env python3
"""Builds the map's data and deploys what changed.

Usage: build.py plan [target ...] [--checks] [--refresh SOURCES] [--force STEPS]
                     [--deploy] [--cpus N] [--memory GB]
       build.py run [target ...] [--checks] [--refresh SOURCES] [--force STEPS]
                    [--deploy] [--cpus N] [--memory GB] [--report SECONDS]
       build.py prune
       build.py adopt step ...

The steps are declared in steps.toml next to this script. A step runs a
command that writes its outputs into a directory of its own, and names
everything the command reads:

  files    files of this repository (glob patterns, `!pattern` excludes;
           only files git tracks or would add count)
  sources  data from outside (a timetable, the OSM planet, ...), by name
  needs    outputs of other steps, as "step/output"

A step is up to date when the hash of its command and of all of these is the
one it was last built with. Hashes are of content, so a step that runs again
and writes the same output leaves the steps reading it up to date.

A source has a probe, a command printing its current version. The version in
use is pinned in the state: a build reads the pins, and only --refresh probes
the sources again (`all`, or names; a source without a probe changes only when
named). So a build after a commit rebuilds what the commit touched, and a
scheduled build with --refresh all what changed outside.

Steps marked `check` write no output either: they are the tests (formatting,
types, unit and end-to-end tests), up to date like any step while what they
read is unchanged, so a test runs again only when its files changed.

Steps marked `deploy` write no output: they publish (import into D1, upload
to R2, deploy the Worker) and run only with --deploy, after the steps listed
in their `after`: the deploys before them, and the checks of what they
publish. When one of those cannot be brought up to date, the deploy
waits, unless only data from outside holds it back (its command and files are
the ones it was last built with): then what is deployed still fits the code.

The state (state.json: the pins, and for each step the hashes of what it read,
the hash and size of each output it wrote, when, and how long it took) is what
tells whether a step is up to date, not the output files. A step whose outputs are gone, for instance from a
lost CI cache, runs again only when a step that has to run reads them. With
BUILD_REMOTE set (s3://bucket/prefix, or a directory) the state is read from
there and written back after every step, with a copy per run under runs/, and
a step's `store` files (what it keeps between runs) are kept there too.

Steps run several at a time: one starts as soon as the steps it needs or
comes after are done and the machine holds it. A step says what it takes with
`cpus` and `memory` (GB; 1 each when unsaid), and the steps running together
stay within --cpus and --memory (the machine's own by default); a step that
takes more than that runs alone, and deploys go one at a time. Every line a
step prints is passed on with the step's name in front, and every minute
(--report) a line says which steps are running, for how long, and how many
are left. A run starts by saying how many steps it has to run and, when each
of them has run before, about how long they will take: the times they took
last, put through the same scheduling (a step whose input comes out
unchanged will not run, so it is the most it should take).

A command runs from the repository root under `bash -euo pipefail` with:

  OUT      the directory to write the step's outputs to
  BUILD    where the other steps' outputs are: $BUILD/<step>/<output>
  STORE    files kept between runs (the step's `store`, whose names may hold
           a source's version: lltskb/$SRC_LLTSKB/an.db)
  SRC_<NAME>  the pinned version of each of its sources

`prune` deletes the outputs of steps marked `keep = false` once no step that
has yet to run reads them, to leave them out of the CI cache. `adopt` records
steps as built with the outputs found in their output directories (or, for a
deploy, as done), for outputs made or published by other means.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import fnmatch
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_VERSION = 1
# A step file may only use these keys, so a typo is an error
SOURCE_KEYS = {'about', 'probe'}
STEP_KEYS = {
    *('about', 'run', 'files', 'sources', 'needs', 'after', 'outs', 'store'),
    *('deploy', 'check', 'keep', 'cpus', 'memory'),
}
LOG_TAIL = 30
# Reasons for running a step shown in a line; the state has them all
MAX_REASONS = 3
# Seconds between the lines saying what is running
REPORT_EVERY = 60
# How a step that ran well is reported, by kind
RAN = {'build': 'built', 'check': 'passed', 'deploy': 'deployed'}
# Times a step is run again for lost outputs before its outputs are taken to
# differ every time
MAX_REBUILDS = 3


class BuildError(Exception):
    pass


@dataclasses.dataclass(frozen=True)
class Source:
    name: str
    about: str
    probe: str | None  # None: changes only when refreshed by name


@dataclasses.dataclass(frozen=True)
class Step:
    name: str
    about: str
    run: str
    files: tuple[str, ...]
    sources: tuple[str, ...]
    needs: tuple[tuple[str, str], ...]  # (step, path under its outputs)
    after: tuple[str, ...]
    outs: tuple[str, ...]
    store: tuple[str, ...]
    deploy: bool
    check: bool
    keep: bool
    cpus: float
    memory: float  # GB

    @property
    def kind(self) -> str:
        return 'deploy' if self.deploy else 'check' if self.check else 'build'

    @property
    def upstream(self) -> list[str]:
        return list(dict.fromkeys([s for s, _ in self.needs] + list(self.after)))


def now() -> str:
    return dt.datetime.now(dt.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def digest(data: bytes) -> str:
    return hashlib.blake2b(data, digest_size=16).hexdigest()


def digest_json(value: object) -> str:
    return digest(json.dumps(value, sort_keys=True, ensure_ascii=False).encode())


def file_digest(path: Path) -> str:
    with path.open('rb') as f:
        return hashlib.file_digest(f, lambda: hashlib.blake2b(digest_size=16)).hexdigest()


def env_name(source: str) -> str:
    return 'SRC_' + re.sub(r'[^A-Za-z0-9]', '_', source).upper()


# ── The step file ───────────────────────────────────────


def load_steps(path: Path) -> tuple[dict[str, Source], dict[str, Step]]:
    with path.open('rb') as f:
        raw = tomllib.load(f)
    unknown = set(raw) - {'sources', 'steps'}
    if unknown:
        raise BuildError(f'{path.name}: unknown tables {sorted(unknown)}')

    sources = {}
    for name, entry in raw.get('sources', {}).items():
        if set(entry) - SOURCE_KEYS:
            raise BuildError(f'source {name}: unknown keys {sorted(set(entry) - SOURCE_KEYS)}')
        sources[name] = Source(name, entry.get('about', ''), entry.get('probe'))

    steps = {}
    for name, entry in raw.get('steps', {}).items():
        if set(entry) - STEP_KEYS:
            raise BuildError(f'step {name}: unknown keys {sorted(set(entry) - STEP_KEYS)}')
        if 'run' not in entry:
            raise BuildError(f'step {name}: no run command')
        needs = []
        for need in entry.get('needs', []):
            step, _, out = need.partition('/')
            if not out:
                raise BuildError(f'step {name}: need {need!r} must be "step/output"')
            needs.append((step, out))
        steps[name] = Step(
            name=name,
            about=entry.get('about', ''),
            run=entry['run'],
            files=tuple(entry.get('files', [])),
            sources=tuple(entry.get('sources', [])),
            needs=tuple(needs),
            after=tuple(entry.get('after', [])),
            outs=tuple(entry.get('outs', [])),
            store=tuple(entry.get('store', [])),
            deploy=entry.get('deploy', False),
            check=entry.get('check', False),
            keep=entry.get('keep', True),
            cpus=entry.get('cpus', 1),
            memory=entry.get('memory', 1),
        )
    check_steps(sources, steps)
    return sources, steps


def check_steps(sources: dict[str, Source], steps: dict[str, Step]) -> None:
    for step in steps.values():
        where = f'step {step.name}'
        if step.deploy and step.check:
            raise BuildError(f'{where}: a step is a deploy or a check, not both')
        if (step.deploy or step.check) and step.outs:
            raise BuildError(f'{where}: a {step.kind} step has no outputs')
        if step.kind == 'build' and not step.outs:
            raise BuildError(f'{where}: no outputs (only deploy and check steps have none)')
        for source in step.sources:
            if source not in sources:
                raise BuildError(f'{where}: unknown source {source!r}')
        for other in step.after:
            if other not in steps:
                raise BuildError(f'{where}: unknown step {other!r} in after')
        for other, out in step.needs:
            if other not in steps:
                raise BuildError(f'{where}: needs unknown step {other!r}')
            if not any(out == o or out.startswith(o + '/') for o in steps[other].outs):
                raise BuildError(f'{where}: {other} has no output {out!r}')
        # What the command reads must be declared
        needed = {other for other, _ in step.needs}
        for other in re.findall(r'\$\{?BUILD\}?/([A-Za-z0-9_.-]+)', step.run):
            if other not in needed:
                raise BuildError(f'{where}: the command reads $BUILD/{other}, which is not in needs')
        declared = {env_name(s) for s in step.sources}
        for variable in re.findall(r'\$\{?(SRC_[A-Z0-9_]+)', ' '.join([step.run, *step.store])):
            if variable not in declared:
                raise BuildError(f'{where}: the command reads ${variable}, which is not in sources')

    # No cycles
    state: dict[str, int] = {}

    def visit(name: str, path: list[str]) -> None:
        if state.get(name) == 2:
            return
        if state.get(name) == 1:
            raise BuildError('steps depend on each other: ' + ' → '.join([*path, name]))
        state[name] = 1
        for other in steps[name].upstream:
            visit(other, [*path, name])
        state[name] = 2

    for name in steps:
        visit(name, [])


# ── Where the state is kept besides the build directory ─


class Remote:
    """s3://bucket/prefix through the aws CLI (R2_ENDPOINT names the endpoint),
    or a directory."""

    def __init__(self, url: str) -> None:
        self.url = url.rstrip('/')
        self.s3 = self.url.startswith('s3://')

    def _aws(self, *args: str) -> subprocess.CompletedProcess:
        command = ['aws', 's3', *args]
        if os.environ.get('R2_ENDPOINT'):
            command += ['--endpoint-url', os.environ['R2_ENDPOINT']]
        return subprocess.run(command, capture_output=True, text=True)

    def _has(self, key: str) -> bool:
        """Asked by listing: reading a missing object answers 404 on some
        stores and 403 on others (R2 among them), which reads like a refusal"""
        result = self._aws('ls', f'{self.url}/{key}')
        if result.returncode == 0:
            # The listing is by prefix: state.json also lists state.json.bak
            name = key.rsplit('/', 1)[-1]
            return any(line.split()[-1:] == [name] for line in result.stdout.splitlines())
        if result.returncode == 1 and not result.stderr.strip():
            return False  # nothing there
        raise BuildError(f'could not look for {self.url}/{key}: {result.stderr.strip()}')

    def get(self, key: str, path: Path) -> bool:
        """False when the remote has no such file"""
        path.parent.mkdir(parents=True, exist_ok=True)
        if not self.s3:
            source = Path(self.url) / key
            if not source.exists():
                return False
            shutil.copyfile(source, path)
            return True
        if not self._has(key):
            return False
        result = self._aws('cp', '--only-show-errors', f'{self.url}/{key}', str(path))
        if result.returncode != 0:
            raise BuildError(f'could not read {self.url}/{key}: {result.stderr.strip()}')
        return True

    def put(self, path: Path, key: str) -> None:
        if not self.s3:
            target = Path(self.url) / key
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            return
        result = self._aws('cp', '--only-show-errors', str(path), f'{self.url}/{key}')
        if result.returncode != 0:
            raise BuildError(f'could not write {self.url}/{key}: {result.stderr.strip()}')


# ── The build ───────────────────────────────────────────


class Build:
    def __init__(self, root: Path, steps_file: Path, build_dir: Path, remote: Remote | None = None) -> None:
        self.root = root
        self.dir = build_dir
        self.out = build_dir / 'out'
        self.store = build_dir / 'store'
        self.remote = remote
        self.sources, self.steps = load_steps(steps_file)
        self.state_file = build_dir / 'state.json'
        self.state: dict = {'version': STATE_VERSION, 'sources': {}, 'steps': {}}
        self._file_hashes: dict[str, str] = {}
        self._repository_files: list[str] | bool | None = None

    # State

    def load_state(self) -> None:
        if self.remote:
            self.remote.get('state.json', self.state_file)
        if self.state_file.exists():
            state = json.loads(self.state_file.read_text())
            if state.get('version') == STATE_VERSION:
                self.state = state
        self.state.setdefault('sources', {})
        self.state.setdefault('steps', {})

    def save_state(self) -> None:
        # The graph goes along, so the state alone can be drawn
        self.state['graph'] = {
            'sources': {s.name: {'about': s.about, 'manual': s.probe is None} for s in self.sources.values()},
            'steps': {
                s.name: {
                    'about': s.about,
                    'sources': list(s.sources),
                    'needs': [f'{step}/{out}' for step, out in s.needs],
                    'after': list(s.after),
                    'outs': list(s.outs),
                    'kind': s.kind,
                    'deploy': s.deploy,
                    'cpus': s.cpus,
                    'memory': s.memory,
                }
                for s in self.steps.values()
            },
        }
        self.state['saved_at'] = now()
        self.dir.mkdir(parents=True, exist_ok=True)
        part = self.state_file.with_suffix('.json.part')
        part.write_text(json.dumps(self.state, ensure_ascii=False, indent=1, sort_keys=True))
        part.replace(self.state_file)
        if self.remote:
            self.remote.put(self.state_file, 'state.json')

    # Sources

    def probe(self, source: Source) -> str | None:
        """The source's current version, or None when the probe fails"""
        if source.probe is None:
            return now()
        result = subprocess.run(
            ['bash', '-euo', 'pipefail', '-c', source.probe], cwd=self.root, capture_output=True, text=True
        )
        version = result.stdout.strip()
        if result.returncode != 0 or not version or '\n' in version:
            print(f'! could not probe {source.name}: {(result.stderr or result.stdout).strip()[-300:]}', flush=True)
            return None
        return version

    def refresh(self, names: list[str], targets: list[str] | None = None) -> None:
        """Probes the named sources (`all`: every source with a probe) and
        the ones never pinned that the targets' steps read, and pins what
        they answer"""
        read = {source for name in self.order(targets or []) for source in self.steps[name].sources}
        chosen = set()
        for name in names:
            if name == 'all':
                chosen |= {s.name for s in self.sources.values() if s.probe is not None}
            elif name in self.sources:
                chosen.add(name)
            else:
                raise BuildError(f'unknown source {name!r}')
        pins = self.state['sources']
        for source in self.sources.values():
            pin = pins.get(source.name)
            if source.name not in chosen and (pin is not None or source.name not in read):
                continue
            if pin is None and source.probe is None and source.name not in chosen:
                # A source without a probe starts at a fixed version
                pins[source.name] = {'version': 'initial', 'checked_at': now(), 'changed_at': now()}
                continue
            version = self.probe(source)
            if version is None:
                if pin is None:
                    raise BuildError(f'source {source.name} has no pinned version and its probe failed')
                pin['probe_failed_at'] = now()
                continue
            if pin is None or pin['version'] != version:
                print(f'source {source.name}: {pin["version"] if pin else "(new)"} → {version}', flush=True)
                pins[source.name] = {'version': version, 'checked_at': now(), 'changed_at': now()}
            else:
                pin['checked_at'] = now()
                pin.pop('probe_failed_at', None)

    # What a step reads

    def repository_files(self) -> list[str] | None:
        """The files git tracks or would add (so nothing ignored: node_modules,
        build outputs, caches), or None when the root is not in a repository"""
        if self._repository_files is None:
            result = subprocess.run(
                ['git', '-C', str(self.root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                capture_output=True,
                text=True,
            )
            self._repository_files = sorted(filter(None, result.stdout.split('\0'))) if result.returncode == 0 else False
        return self._repository_files or None

    def step_files(self, step: Step) -> dict[str, str]:
        """The repository files matching the step's patterns, with their hashes"""
        excluded = [p[1:] for p in step.files if p.startswith('!')]
        known = self.repository_files()
        found: dict[str, str] = {}
        for pattern in step.files:
            if pattern.startswith('!'):
                continue
            matched = False
            for path in [self.root] if pattern == '.' else sorted(self.root.glob(pattern)):
                if not path.is_dir():
                    paths = [path]
                elif known is None:
                    # Not a repository: everything but git's and the build's own
                    own = (self.root / '.git', self.dir)
                    paths = sorted(
                        p for p in path.rglob('*') if p.is_file() and not any(p.is_relative_to(d) for d in own)
                    )
                else:
                    inside = '' if path == self.root else path.relative_to(self.root).as_posix() + '/'
                    paths = [self.root / rel for rel in known if rel.startswith(inside) and (self.root / rel).is_file()]
                for p in paths:
                    rel = p.relative_to(self.root).as_posix()
                    if '__pycache__' in p.parts or any(fnmatch.fnmatch(rel, e) for e in excluded):
                        continue
                    if rel not in self._file_hashes:
                        self._file_hashes[rel] = file_digest(p)
                    found[rel] = self._file_hashes[rel]
                    matched = True
            if not matched:
                raise BuildError(f'step {step.name}: {pattern!r} matches no file')
        return found

    def need_hash(self, step: str, out: str) -> str | None:
        """The recorded hash of another step's output (or of a file inside one)"""
        outputs = self.state['steps'].get(step, {}).get('outputs', {})
        if out in outputs:
            return outputs[out]['hash']
        for name, record in outputs.items():
            if out.startswith(name + '/'):
                return record.get('files', {}).get(out[len(name) + 1 :], {}).get('hash')
        return None

    def inputs(self, step: Step) -> dict:
        return {
            'run': step.run,
            'files': self.step_files(step),
            'sources': {s: self.state['sources'][s]['version'] for s in step.sources},
            'needs': {f'{s}/{out}': self.need_hash(s, out) for s, out in step.needs},
        }

    def reasons(self, step: Step, inputs: dict) -> list[str]:
        """Why the step is not up to date with `inputs` (empty when it is)"""
        record = self.state['steps'].get(step.name)
        if not record or 'fingerprint' not in record:
            return ['never built']
        if record['fingerprint'] == digest_json(inputs):
            return []
        old = record.get('inputs', {})
        reasons = []
        if old.get('run') != inputs['run']:
            reasons.append('its command changed')
        for kind, what in (('files', 'file'), ('sources', 'source'), ('needs', 'input')):
            before, after = old.get(kind, {}), inputs[kind]
            for key in sorted(set(before) | set(after)):
                if before.get(key) == after.get(key):
                    continue
                if kind == 'sources':
                    reasons.append(f'source {key}: {before.get(key, "(none)")} → {after.get(key, "(none)")}')
                elif key not in before:
                    reasons.append(f'new {what} {key}')
                elif key not in after:
                    reasons.append(f'{what} {key} no longer read')
                else:
                    reasons.append(f'{what} {key} changed')
        return reasons or ['its inputs changed']

    # What a step wrote

    def describe_output(self, path: Path) -> dict:
        """An output's hash and size; for a directory, of each file in it too,
        its own hash being that of its files' names and hashes"""
        if path.is_dir():
            files = {
                p.relative_to(path).as_posix(): {'hash': file_digest(p), 'size': p.stat().st_size}
                for p in sorted(path.rglob('*'))
                if p.is_file()
            }
            return {
                'hash': digest_json({name: f['hash'] for name, f in files.items()}),
                'size': sum(f['size'] for f in files.values()),
                'files': files,
            }
        return {'hash': file_digest(path), 'size': path.stat().st_size}

    def output_present(self, step: str, out: str) -> bool:
        """Whether the output is in the build directory as the state records it"""
        path = self.out / step / out
        if not path.exists():
            return False
        if path.is_dir():
            return self.describe_output(path)['hash'] == self.need_hash(step, out)
        return file_digest(path) == self.need_hash(step, out)

    def adopt(self, step: Step) -> None:
        """Records the step as built with what is in its output directory"""
        missing = [out for out in step.outs if not (self.out / step.name / out).exists()]
        if missing:
            raise BuildError(f'cannot adopt {step.name}: no {", ".join(missing)} in {self.out / step.name}')
        unbuilt = [f'{s}/{out}' for s, out in step.needs if self.need_hash(s, out) is None]
        if unbuilt:
            raise BuildError(f'cannot adopt {step.name}: {", ".join(unbuilt)} is not built')
        inputs = self.inputs(step)
        self.state['steps'][step.name] = {
            'fingerprint': digest_json(inputs),
            'inputs': inputs,
            'outputs': {out: self.describe_output(self.out / step.name / out) for out in step.outs},
            'built_at': now(),
            'duration_s': None,
            'attempt': {'status': 'adopted', 'at': now(), 'run': run_info()},
        }
        print(f'adopted {step.name}')

    # Planning

    def order(self, targets: list[str]) -> list[str]:
        """The targets and what they depend on, dependencies first"""
        for target in targets:
            if target not in self.steps:
                raise BuildError(f'unknown step {target!r}')
        seen: dict[str, None] = {}

        def visit(name: str) -> None:
            if name in seen:
                return
            for other in self.steps[name].upstream:
                visit(other)
            seen[name] = None

        for target in targets or self.steps:
            visit(target)
        return list(seen)

    def plan(self, targets: list[str], force: set[str] = frozenset()) -> dict[str, list[str]]:
        """Each step that would run, with the reasons. A step reading the
        output of one that runs is listed too, though it stays up to date if
        that output comes out the same."""
        runs: dict[str, list[str]] = {}
        order = self.order(targets)
        for name in order:
            step = self.steps[name]
            reasons = ['forced'] if name in force else []
            reasons += self.reasons(step, self.inputs(step))
            if reasons != ['never built']:
                reasons += [f'{other} runs' for other in dict.fromkeys(s for s, _ in step.needs) if other in runs]
            if reasons:
                runs[name] = list(dict.fromkeys(reasons))
        # Steps that run need their inputs back if those are gone
        for name in reversed(order):
            if name not in runs:
                continue
            for other, out in self.steps[name].needs:
                if other not in runs and not (self.out / other / out).exists():
                    runs[other] = [f'its output {out} is gone and {name} reads it']
        return {name: runs[name] for name in order if name in runs}


def fits(step: Step, running: list[Step], cpus: float, memory: float) -> bool:
    """Whether the step may start beside the ones running"""
    if not running:
        return True  # alone, whatever it takes
    if step.deploy and any(other.deploy for other in running):
        return False
    return (
        sum(other.cpus for other in running) + step.cpus <= cpus
        and sum(other.memory for other in running) + step.memory <= memory
    )


def simulate(steps: dict[str, Step], seconds: dict[str, float], cpus: float, memory: float) -> float:
    """How long the steps of `seconds` (each with the time it takes, in the
    order they are looked at) take together, started as the runner starts
    them: when the ones they wait for are done and the machine holds them"""
    waiting = list(seconds)
    running: dict[str, float] = {}  # step → when it ends
    done: set[str] = set()
    clock = 0.0
    while waiting or running:
        for name in list(waiting):
            # Steps outside the plan are up to date: nothing to wait for
            if any(other in seconds and other not in done for other in steps[name].upstream):
                continue
            if fits(steps[name], [steps[r] for r in running], cpus, memory):
                running[name] = clock + seconds[name]
                waiting.remove(name)
        first = min(running, key=running.get)
        clock = running.pop(first)
        done.add(first)
    return clock


def forecast(build: Build, plan: dict[str, list[str]], deploy: bool, cpus: float, memory: float) -> list[str]:
    """What a run is about to do, in a line or two: how many steps, and how
    long they should take by the time each took when it last ran"""
    names = [name for name in plan if deploy or not build.steps[name].deploy]
    if not names:
        return ['nothing to run']
    kinds = [build.steps[name].kind for name in names]
    words = {'build': ('build', 'builds'), 'check': ('check', 'checks'), 'deploy': ('deploy', 'deploys')}
    counts = ', '.join(f'{kinds.count(k)} {words[k][kinds.count(k) > 1]}' for k in words if k in kinds)
    lines = [f'{len(names)} step{"s" if len(names) > 1 else ""} to run: {counts}']
    seconds = {name: build.state['steps'].get(name, {}).get('duration_s') for name in names}
    unknown = [name for name, took in seconds.items() if took is None]
    if unknown:
        lines.append(f'no estimate of the time: {told(unknown, ", ")} {"has" if len(unknown) == 1 else "have"} not run before')
    else:
        together = simulate(build.steps, seconds, cpus, memory)
        lines.append(
            f'about {elapsed(together)} if all of them run, by the time each took last '
            f'({elapsed(sum(seconds.values()))} one after another)'
        )
    return lines


class Runner:
    """Runs the steps that are not up to date, several at a time where their
    dependencies allow and the machine's CPUs and memory hold them (each step
    says what it takes; deploys go one at a time). One thread per running step
    reads its output; everything else happens on the caller's thread."""

    def __init__(
        self, build: Build, deploy: bool, force: set[str], cpus: float, memory: float, report: float = REPORT_EVERY
    ) -> None:
        self.build = build
        self.deploy = deploy
        self.force = set(force)
        self.cpus = cpus
        self.memory = memory
        self.report = report  # seconds between lines on what is running; 0 for none
        self.results: dict[str, tuple[str, str]] = {}  # settled steps → (outcome, detail)
        self.ran: set[str] = set()
        self.results_before: dict[str, str] = {}  # what a step built in this run was built for
        self.running: dict[str, dict] = {}
        # Up-to-date steps to run again for outputs that are gone → why
        self.wanted: dict[str, str] = {}
        self.rebuilt: dict[str, int] = {}
        # Outputs found in the build directory as recorded
        self.present: set[tuple[str, str]] = set()
        self.events: queue.Queue = queue.Queue()
        self.output = threading.Lock()
        self.width = 0

    def run(self, targets: list[str]) -> bool:
        order = self.build.order(targets)
        self.width = max((len(name) for name in order), default=0)
        for line in forecast(self.build, self.build.plan(targets, self.force), self.deploy, self.cpus, self.memory):
            self.say('', line)
        due = time.monotonic() + self.report
        try:
            while True:
                moved = self.schedule(order)
                if self.running:
                    try:
                        wait = max(0.0, due - time.monotonic()) if self.report else None
                        self.finish(*self.events.get(timeout=wait))
                    except queue.Empty:
                        self.say('', self.progress(order))
                        due += self.report
                elif not moved:
                    break
        finally:
            for job in self.running.values():
                job['process'].kill()
        self.results = {name: self.results[name] for name in order if name in self.results}
        return not any(outcome == 'failed' for outcome, _ in self.results.values())

    def progress(self, order: list[str]) -> str:
        """The steps running now with how long each has run, and how many are left"""
        now = time.monotonic()
        running = ', '.join(f'{name} {elapsed(now - job["clock"])}' for name, job in self.running.items())
        left = sum(1 for name in order if name not in self.results and name not in self.running)
        return f'running: {running}' + (f'; {left} more to go' if left else '')

    def say(self, name: str, text: str) -> None:
        with self.output:
            print(f'{name:<{self.width}} | {text}', flush=True)

    # Deciding

    def schedule(self, order: list[str]) -> bool:
        """Settles the steps whose fate is known and starts those that can
        run; True when anything changed"""
        build = self.build
        moved = False
        for name in order:
            if name in self.results or name in self.running:
                continue
            step = build.steps[name]
            if any(other not in self.results for other in step.upstream):
                continue
            stuck = [other for other in step.upstream if self.results[other][0] in ('failed', 'blocked')]
            # A deploy does not wait for one held back by data from outside alone
            needed = {other for other, _ in step.needs}
            stuck = [other for other in stuck if other in needed or not self.held_back_from_outside(other)]
            if stuck:
                self.results[name] = ('blocked', 'needs ' + ', '.join(stuck))
                moved = True
                continue
            reasons = ['forced'] if name in self.force else []
            reasons += [self.wanted[name]] if name in self.wanted else []
            reasons += build.reasons(step, build.inputs(step))
            if not reasons:
                self.results[name] = (RAN[step.kind], self.results_before[name]) if name in self.ran else ('up to date', '')
                moved = True
                continue
            if step.deploy and not self.deploy:
                self.results[name] = ('not deployed', told(reasons))
                moved = True
                continue
            # Its inputs must be there as recorded; the steps that made the
            # ones that are not run again first
            gone = [(other, out) for other, out in step.needs if not self.input_present(other, out)]
            if gone:
                for other, out in gone:
                    self.rebuilt[other] = self.rebuilt.get(other, 0) + 1
                    if self.rebuilt[other] > MAX_REBUILDS:
                        raise BuildError(f'the outputs of {other} keep changing when rebuilt; it is not reproducible')
                    self.wanted[other] = f'its output {out} is gone and {name} reads it'
                    del self.results[other]
                moved = True
                continue
            if self.fits(step):
                self.start(step, reasons)
                moved = True
        return moved

    def fits(self, step: Step) -> bool:
        # Never while a step reading its outputs runs: they are replaced whole
        if any(step.name in {other for other, _ in self.build.steps[r].needs} for r in self.running):
            return False
        return fits(step, [self.build.steps[r] for r in self.running], self.cpus, self.memory)

    def held_back_from_outside(self, name: str) -> bool:
        """Whether the step, and every step before it that could not be brought
        up to date, has the command and files it was last built with: then a
        source is what changed, and what is deployed still fits the code"""
        build = self.build
        step = build.steps[name]
        record = build.state['steps'].get(name, {})
        if 'fingerprint' not in record:
            return False
        if record['inputs']['run'] != step.run or record['inputs']['files'] != build.step_files(step):
            return False
        failing = [other for other in step.upstream if self.results.get(other, ('',))[0] in ('failed', 'blocked')]
        return all(self.held_back_from_outside(other) for other in failing)

    def input_present(self, step: str, out: str) -> bool:
        if (step, out) not in self.present and self.build.output_present(step, out):
            self.present.add((step, out))
        return (step, out) in self.present

    # Running

    def start(self, step: Step, reasons: list[str]) -> None:
        build = self.build
        inputs = build.inputs(step)
        self.force.discard(step.name)
        self.wanted.pop(step.name, None)

        tmp = build.dir / 'tmp' / step.name
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        build.store.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, OUT=str(tmp), BUILD=str(build.out), STORE=str(build.store))
        for source in step.sources:
            env[env_name(source)] = build.state['sources'][source]['version']
        # A store name may hold a source's version: lltskb/$SRC_LLTSKB/an.db
        store = [re.sub(r'\$\{?(SRC_[A-Z0-9_]+)\}?', lambda m: env[m[1]], name) for name in step.store]
        if build.remote:
            for name in store:
                if not (build.store / name).exists():
                    build.remote.get(f'store/{name}', build.store / name)

        record = build.state['steps'].setdefault(step.name, {})
        started = now()
        record['attempt'] = {'status': 'running', 'at': started, 'run': run_info(), 'reasons': reasons}
        build.save_state()
        self.say(step.name, f'── starts: {told(reasons)}')
        process = subprocess.Popen(
            ['bash', '-euo', 'pipefail', '-c', step.run],
            cwd=build.root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors='replace',
        )
        job = {
            'process': process,
            'inputs': inputs,
            'reasons': reasons,
            'started': started,
            'clock': time.monotonic(),
            'store': store,
            'tmp': tmp,
        }
        self.running[step.name] = job
        threading.Thread(target=self.follow, args=(step.name, process), daemon=True).start()

    def follow(self, name: str, process: subprocess.Popen) -> None:
        """A running step's thread: passes its output on, then says it ended"""
        clock = time.monotonic()
        tail: list[str] = []
        assert process.stdout is not None
        with process.stdout:
            for line in process.stdout:
                self.say(name, line.rstrip('\n'))
                tail = [*tail[-(LOG_TAIL - 1) :], line.rstrip('\n')]
        code = process.wait()
        self.events.put((name, code, round(time.monotonic() - clock, 1), tail))

    def finish(self, name: str, code: int, duration: float, tail: list[str]) -> None:
        build = self.build
        step = build.steps[name]
        job = self.running.pop(name)
        tmp = job['tmp']
        record = build.state['steps'][name]
        attempt = record['attempt']
        attempt['duration_s'] = duration
        error = f'exit code {code}' if code else None
        missing = [out for out in step.outs if not (tmp / out).exists()]
        if not error and missing:
            error = 'did not write ' + ', '.join(missing)
        if error:
            # The outputs of the last good build stay
            attempt.update(status='failed', error=error, log_tail=tail)
            shutil.rmtree(tmp, ignore_errors=True)
            build.save_state()
            self.say(name, f'✗ failed after {duration} s: {error}')
            self.results[name] = ('failed', error)
            return

        before = record.get('outputs')
        outputs = {out: build.describe_output(tmp / out) for out in step.outs}
        if step.outs:
            target = build.out / name
            shutil.rmtree(target, ignore_errors=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp.replace(target)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
        if build.remote:
            for stored in job['store']:
                if (build.store / stored).exists():
                    build.remote.put(build.store / stored, f'store/{stored}')
        attempt['status'] = 'ok'
        record.update(
            fingerprint=digest_json(job['inputs']),
            inputs=job['inputs'],
            outputs=outputs,
            built_at=job['started'],
            duration_s=duration,
        )
        build.save_state()
        size = sum(o['size'] for o in outputs.values())
        self.say(name, f'✓ done in {duration} s' + (f', {size:,} bytes' if step.outs else ''))
        self.ran.add(name)
        self.present = {(other, out) for other, out in self.present if other != name}
        unchanged = bool(step.outs) and before == outputs
        self.results[name] = (RAN[step.kind], told(job['reasons']) + (' (output unchanged)' if unchanged else ''))
        self.results_before[name] = self.results[name][1]
        if before is not None and before != outputs:
            # Steps settled on what it wrote before are looked at again
            for other in self.readers(name):
                if self.results.get(other, ('',))[0] in ('up to date', *RAN.values()):
                    del self.results[other]

    def readers(self, name: str) -> set[str]:
        """Every step that reads the step's outputs, directly or through others"""
        found: set[str] = set()
        queue_ = [name]
        while queue_:
            current = queue_.pop()
            for step in self.build.steps.values():
                if step.name not in found and current in {other for other, _ in step.needs}:
                    found.add(step.name)
                    queue_.append(step.name)
        return found


def run_info() -> dict | None:
    """The CI run this is, for the state"""
    if not os.environ.get('GITHUB_RUN_ID'):
        return None
    server = os.environ.get('GITHUB_SERVER_URL', 'https://github.com')
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    run_id = os.environ['GITHUB_RUN_ID']
    return {
        'id': run_id,
        'url': f'{server}/{repository}/actions/runs/{run_id}',
        'event': os.environ.get('GITHUB_EVENT_NAME'),
        'commit': os.environ.get('GITHUB_SHA'),
    }


# ── Commands ────────────────────────────────────────────


def machine_memory() -> float:
    """The machine's memory in GB (8 where it cannot be told)"""
    try:
        with open('/proc/meminfo') as f:
            return round(int(re.search(r'MemTotal:\s+(\d+) kB', f.read())[1]) / 1e6, 1)
    except (OSError, TypeError):
        return 8.0


def elapsed(seconds: float) -> str:
    """How long a step has run, to the unit that matters: 42 s, 12 min, 1 h 20 min"""
    if seconds < 60:
        return f'{int(seconds)} s'
    minutes = int(seconds // 60)
    return f'{minutes} min' if minutes < 60 else f'{minutes // 60} h {minutes % 60:02d} min'


def told(reasons: list[str], between: str = '; ') -> str:
    """The reasons in a line; the first few when there are many"""
    if len(reasons) <= MAX_REASONS:
        return between.join(reasons)
    return between.join(reasons[:MAX_REASONS]) + f'{between}and {len(reasons) - MAX_REASONS} more'


def split(values: list[str] | None) -> list[str]:
    return [v for value in values or [] for v in value.replace(',', ' ').split()]


def print_plan(build: Build, plan: dict[str, list[str]]) -> None:
    if not plan:
        print('Everything is up to date.')
        return
    for name, reasons in plan.items():
        print(f'{build.steps[name].kind:6} {name}: {told(reasons)}')


def summary(build: Build, runner: Runner, started: str) -> str:
    """A Markdown table of what the run did"""
    lines = ['| Step | Result | Time | Output | Why |', '| --- | --- | --- | --- | --- |']
    for name, (outcome, detail) in runner.results.items():
        record = build.state['steps'].get(name, {})
        seconds = record.get('attempt', {}).get('duration_s') if name in runner.ran or outcome == 'failed' else None
        size = sum(o['size'] for o in record.get('outputs', {}).values())
        lines.append(
            f'| {name} | {outcome} | {f"{seconds} s" if seconds is not None else ""} '
            f'| {f"{size:,} B" if record.get("outputs") else ""} | {detail} |'
        )
    pins = ['', '| Source | Version | Changed |', '| --- | --- | --- |']
    for name, pin in build.state['sources'].items():
        pins.append(f'| {name} | `{pin["version"]}` | {pin["changed_at"]}{" (this run)" if pin["changed_at"] >= started else ""} |')
    return '\n'.join(lines + pins) + '\n'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--steps', type=Path, default=HERE / 'steps.toml', help='the step file')
    parser.add_argument('--root', type=Path, default=HERE.parents[1], help='the repository root')
    parser.add_argument('--build-dir', type=Path, help='default: <root>/.build')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'run'):
        command = commands.add_parser(name)
        command.add_argument('targets', nargs='*', help='steps to bring up to date (default: all)')
        command.add_argument('--refresh', action='append', help='sources to probe again: names, or all')
        command.add_argument('--force', action='append', help='steps to run even if up to date')
        command.add_argument('--checks', action='store_true', help='the check steps (with any targets named)')
        command.add_argument('--deploy', action='store_true', help='the deploy steps too')
        command.add_argument('--cpus', type=float, default=os.cpu_count() or 1, help='CPUs steps may take together')
        command.add_argument(
            '--memory', type=float, default=machine_memory(), help='GB of memory they may take together'
        )
    run = commands.choices['run']
    run.add_argument(
        '--report', type=float, default=REPORT_EVERY, metavar='SECONDS', help='how often to say what is running (0: never)'
    )
    commands.add_parser('prune')
    commands.add_parser('adopt').add_argument('names', nargs='+', metavar='step')
    args = parser.parse_args(argv)

    root = args.root.resolve()
    remote = Remote(os.environ['BUILD_REMOTE']) if os.environ.get('BUILD_REMOTE') else None
    try:
        build = Build(root, args.steps, (args.build_dir or root / '.build').resolve(), remote)
        build.load_state()
        if args.command == 'prune':
            build.refresh([])
            waiting = build.plan([])
            for step in build.steps.values():
                readers = [s.name for s in build.steps.values() if step.name in {other for other, _ in s.needs}]
                if step.keep or not (build.out / step.name).exists():
                    continue
                if step.name in waiting or any(reader in waiting for reader in readers):
                    print(f'keeping the outputs of {step.name}: steps reading them have yet to run')
                    continue
                print(f'removing the outputs of {step.name}')
                shutil.rmtree(build.out / step.name)
            return 0
        if args.command == 'adopt':
            build.refresh([])
            for name in build.order(args.names):
                if name in args.names:
                    build.adopt(build.steps[name])
            build.save_state()
            return 0

        started = now()
        force = set(split(args.force))
        for name in force:
            if name not in build.steps:
                raise BuildError(f'unknown step {name!r}')
        targets = args.targets
        if args.checks:
            targets = [s.name for s in build.steps.values() if s.check] + targets
        build.refresh(split(args.refresh), targets)
        if args.command == 'plan':
            # Nothing is written: the pins a plan refreshed are for the plan only
            plan = build.plan(targets, force)
            print_plan(build, plan)
            if plan:
                print('\n'.join(forecast(build, plan, args.deploy, args.cpus, args.memory)))
            return 0

        build.save_state()
        runner = Runner(build, args.deploy, force, args.cpus, args.memory, args.report)
        ok = runner.run(targets)
        text = summary(build, runner, started)
        print('\n' + text)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
                f.write(text)
        info = run_info()
        if remote and info:
            report = build.dir / 'run.json'
            report.write_text(
                json.dumps(
                    {
                        'run': info,
                        'started_at': started,
                        'finished_at': now(),
                        'ok': ok,
                        'steps': {name: {'outcome': o, 'detail': d} for name, (o, d) in runner.results.items()},
                        'state': build.state,
                    },
                    ensure_ascii=False,
                )
            )
            remote.put(report, f'runs/{info["id"]}.json')
        return 0 if ok else 1
    except BuildError as error:
        print(f'build.py: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
