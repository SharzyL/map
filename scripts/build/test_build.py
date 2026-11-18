"""Tests of build.py on small step files: python3 -m unittest scripts/build/test_build.py"""

import contextlib
import io
import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build  # noqa: E402

# upper: text → UPPER; joined: UPPER + a source's version; publish: a deploy
STEPS = """
[sources.feed]
probe = "cat feed-version"

[sources.manual]

[steps.upper]
run = "echo upper >> runs; tr a-z A-Z < text.txt > $OUT/upper.txt; cp notes.txt $OUT/notes.txt"
files = ["text.txt", "notes.txt"]
outs = ["upper.txt", "notes.txt"]

[steps.joined]
run = "echo joined >> runs; (cat $BUILD/upper/upper.txt; echo $SRC_FEED $SRC_MANUAL) > $OUT/joined.txt"
sources = ["feed", "manual"]
needs = ["upper/upper.txt"]
outs = ["joined.txt"]

[steps.publish]
run = "echo publish >> runs; cp $BUILD/joined/joined.txt published.txt"
needs = ["joined/joined.txt"]
deploy = true

[steps.announce]
run = "echo announce >> runs"
files = ["notes.txt"]
after = ["publish"]
deploy = true
"""


class BuildTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / 'repo'
        self.root.mkdir()
        self.remote = Path(tmp.name) / 'remote'
        self.write('text.txt', 'hello\n')
        self.write('notes.txt', 'notes\n')
        self.write('feed-version', '1\n')
        self.write('steps.toml', STEPS)
        os.environ.pop('BUILD_REMOTE', None)
        os.environ.pop('GITHUB_RUN_ID', None)
        os.environ.pop('GITHUB_ACTIONS', None)
        os.environ.pop('GITHUB_STEP_SUMMARY', None)

    def write(self, name: str, text: str) -> None:
        (self.root / name).write_text(textwrap.dedent(text))

    def build(self, *args: str) -> tuple[int, str]:
        """Runs build.py; its exit code and output, and the steps it ran in self.ran"""
        (self.root / 'runs').unlink(missing_ok=True)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = build.main(['--steps', str(self.root / 'steps.toml'), '--root', str(self.root), *args])
        runs = self.root / 'runs'
        self.ran = runs.read_text().split() if runs.exists() else []
        return code, out.getvalue()

    def state(self) -> dict:
        return json.loads((self.root / '.build' / 'state.json').read_text())

    def out(self, path: str) -> str:
        return (self.root / '.build' / 'out' / path).read_text()

    def test_builds_once(self) -> None:
        code, _ = self.build('run')
        self.assertEqual((code, self.ran), (0, ['upper', 'joined']))
        self.assertEqual(self.out('joined/joined.txt'), 'HELLO\n1 initial\n')
        code, output = self.build('run')
        self.assertEqual((code, self.ran), (0, []))
        self.assertIn('| upper | up to date |  | 12 B |', output)
        self.assertIn('| publish | not deployed |', output)

    def test_changed_file_rebuilds_its_step_and_what_changes_after(self) -> None:
        self.build('run')
        self.write('text.txt', 'world\n')
        self.build('run')
        self.assertEqual(self.ran, ['upper', 'joined'])
        self.assertEqual(self.out('joined/joined.txt'), 'WORLD\n1 initial\n')
        # The same output: what reads it stays up to date
        self.write('text.txt', 'World\n')
        _, output = self.build('run')
        self.assertEqual(self.ran, ['upper'])
        self.assertIn('file text.txt changed (output unchanged)', output)
        # Only the output a step needs counts
        self.write('notes.txt', 'other notes\n')
        self.build('run')
        self.assertEqual(self.ran, ['upper'])

    def test_changed_command_rebuilds(self) -> None:
        self.build('run')
        self.write('steps.toml', STEPS.replace('echo $SRC_FEED', 'echo v$SRC_FEED'))
        _, output = self.build('run')
        self.assertEqual(self.ran, ['joined'])
        self.assertIn('its command changed', output)

    def test_sources_are_pinned_until_refreshed(self) -> None:
        self.build('run', '--deploy')
        self.write('feed-version', '2\n')
        self.build('run', '--deploy')
        self.assertEqual(self.ran, [])
        _, output = self.build('plan', '--refresh', 'all')
        self.assertIn('build  joined: source feed: 1 → 2', output)
        self.assertIn('deploy publish: joined runs', output)
        # A plan pins nothing
        self.assertEqual(self.state()['sources']['feed']['version'], '1')
        _, output = self.build('run', '--refresh', 'all')
        self.assertEqual(self.ran, ['joined'])
        self.assertEqual(self.out('joined/joined.txt'), 'HELLO\n2 initial\n')
        self.assertEqual(self.state()['sources']['manual']['version'], 'initial')
        # A source without a probe changes when named
        self.build('run', '--refresh', 'manual')
        self.assertEqual(self.ran, ['joined'])
        self.assertNotEqual(self.state()['sources']['manual']['version'], 'initial')

    def test_failed_probe_keeps_the_pin(self) -> None:
        self.build('run')
        (self.root / 'feed-version').unlink()
        code, output = self.build('run', '--refresh', 'all')
        self.assertEqual((code, self.ran), (0, []))
        self.assertIn('could not probe feed', output)
        self.assertIn('probe_failed_at', self.state()['sources']['feed'])

    def test_deploys_in_order_when_asked(self) -> None:
        self.build('run', '--deploy')
        self.assertEqual(self.ran, ['upper', 'joined', 'publish', 'announce'])
        self.assertEqual((self.root / 'published.txt').read_text(), 'HELLO\n1 initial\n')
        self.build('run', '--deploy')
        self.assertEqual(self.ran, [])
        # A deploy runs again for what it publishes, not for the deploys before it
        self.write('text.txt', 'bye\n')
        self.build('run', '--deploy')
        self.assertEqual(self.ran, ['upper', 'joined', 'publish'])

    def test_failure_keeps_the_last_output_and_blocks_what_reads_it(self) -> None:
        self.build('run', '--deploy')
        self.write('steps.toml', STEPS.replace('tr a-z A-Z', 'false; tr a-z A-Z'))
        self.write('notes.txt', 'new\n')
        code, output = self.build('run', '--deploy')
        self.assertEqual((code, self.ran), (1, ['upper']))
        self.assertIn('| upper | failed |', output)
        self.assertIn('| joined | blocked |  | 16 B | needs upper |', output)
        # A deploy waits for the deploys before it
        self.assertIn('| announce | blocked |  |  | needs publish |', output)
        self.assertEqual(self.out('upper/upper.txt'), 'HELLO\n')
        attempt = self.state()['steps']['upper']['attempt']
        self.assertEqual((attempt['status'], attempt['error']), ('failed', 'exit code 1'))
        # Fixed: it builds again, and nothing after it has to
        self.write('steps.toml', STEPS)
        code, _ = self.build('run', '--deploy')
        self.assertEqual((code, self.ran), (0, ['upper', 'announce']))

    def test_deploy_does_not_wait_for_a_failure_from_outside(self) -> None:
        steps = STEPS.replace('echo joined >> runs;', 'echo joined >> runs; test $SRC_FEED != bad;')
        self.write('steps.toml', steps)
        self.build('run', '--deploy')
        # The source breaks joined, and so publish; announce's own change goes out
        self.write('feed-version', 'bad\n')
        self.write('notes.txt', 'new\n')
        code, output = self.build('run', '--deploy', '--refresh', 'all')
        self.assertEqual((code, self.ran), (1, ['upper', 'joined', 'announce']))
        self.assertIn('| publish | blocked |  |  | needs joined |', output)
        # ... but not when the failing step's command changed with it
        self.write('steps.toml', steps.replace('!= bad', '!= bad '))
        self.write('notes.txt', 'newer\n')
        code, output = self.build('run', '--deploy')
        self.assertEqual((code, self.ran), (1, ['upper', 'joined']))
        self.assertIn('| announce | blocked |  |  | needs publish |', output)

    def test_missing_output_is_a_failure(self) -> None:
        self.write('steps.toml', STEPS.replace('cp notes.txt $OUT/notes.txt', 'true'))
        code, output = self.build('run')
        self.assertEqual(code, 1)
        self.assertIn('did not write notes.txt', output)

    def test_lost_outputs_come_back_only_when_read(self) -> None:
        self.build('run', '--deploy')
        (self.root / '.build' / 'out' / 'upper' / 'upper.txt').unlink()
        (self.root / '.build' / 'out' / 'joined' / 'joined.txt').unlink()
        code, _ = self.build('run', '--deploy')
        self.assertEqual((code, self.ran), (0, []))
        # joined has to run and reads upper's output
        self.write('feed-version', '3\n')
        _, output = self.build('plan', '--refresh', 'feed')
        self.assertIn('build  upper: its output upper.txt is gone and joined reads it', output)
        self.build('run', '--refresh', 'feed', '--deploy')
        self.assertEqual(self.ran, ['upper', 'joined', 'publish'])
        self.assertEqual(self.out('joined/joined.txt'), 'HELLO\n3 initial\n')

    def test_output_that_is_not_the_recorded_one_is_rebuilt(self) -> None:
        self.build('run')
        (self.root / '.build' / 'out' / 'upper' / 'upper.txt').write_text('stale\n')
        self.build('run', '--refresh', 'manual')
        self.assertEqual(self.ran, ['upper', 'joined'])
        self.assertTrue(self.out('joined/joined.txt').startswith('HELLO\n'))

    def test_force_and_targets(self) -> None:
        self.build('run', 'upper')
        self.assertEqual(self.ran, ['upper'])
        self.build('run', '--force', 'upper')
        self.assertEqual(self.ran, ['upper', 'joined'])
        self.build('run', '--force', 'joined')
        self.assertEqual(self.ran, ['joined'])

    def test_state_and_store_follow_the_remote(self) -> None:
        os.environ['BUILD_REMOTE'] = str(self.remote)
        self.addCleanup(os.environ.pop, 'BUILD_REMOTE', None)
        self.write(
            'steps.toml',
            STEPS
            + """
            [steps.counted]
            run = "echo counted >> runs; echo x >> $STORE/count.txt; cp $STORE/count.txt $OUT/count.txt"
            files = ["text.txt"]
            store = ["count.txt"]
            outs = ["count.txt"]

            [steps.kept]
            run = "mkdir -p $STORE/feed/$SRC_FEED; echo $SRC_FEED | tee $STORE/feed/$SRC_FEED/data > $OUT/data"
            sources = ["feed"]
            store = ["feed/${SRC_FEED}/data"]
            outs = ["data"]
            """,
        )
        os.environ['GITHUB_RUN_ID'] = '42'
        self.addCleanup(os.environ.pop, 'GITHUB_RUN_ID', None)
        self.build('run', '--deploy')
        self.assertEqual((self.remote / 'store' / 'count.txt').read_text(), 'x\n')
        self.assertEqual((self.remote / 'store' / 'feed' / '1' / 'data').read_text(), '1\n')
        report = json.loads((self.remote / 'runs' / '42.json').read_text())
        self.assertEqual((report['ok'], report['steps']['publish']['outcome']), (True, 'built'))
        state = json.loads((self.remote / 'state.json').read_text())
        self.assertEqual(state['graph']['steps']['joined']['needs'], ['upper/upper.txt'])
        self.assertEqual(state['steps']['joined']['attempt']['run']['id'], '42')
        self.assertGreaterEqual(state['steps']['joined']['duration_s'], 0)

        # A build directory lost whole: nothing runs again, deploys included
        import shutil

        shutil.rmtree(self.root / '.build')
        code, _ = self.build('run', '--deploy')
        self.assertEqual((code, self.ran), (0, []))
        # and what a step keeps between runs comes back from the remote
        self.write('text.txt', 'again\n')
        self.build('run', 'counted')
        self.assertEqual(self.out('counted/count.txt'), 'x\nx\n')

    def test_prune_removes_outputs_not_kept_once_read(self) -> None:
        self.write('steps.toml', STEPS.replace('[steps.joined]', '[steps.joined]\nkeep = false'))
        self.build('run')
        # publish has yet to read it
        _, output = self.build('prune')
        self.assertIn('keeping the outputs of joined', output)
        self.assertTrue((self.root / '.build' / 'out' / 'joined').exists())
        self.build('run', '--deploy')
        self.build('prune')
        self.assertFalse((self.root / '.build' / 'out' / 'joined').exists())
        self.assertTrue((self.root / '.build' / 'out' / 'upper').exists())
        self.build('run', '--deploy')
        self.assertEqual(self.ran, [])

    def test_adopt_records_outputs_made_elsewhere(self) -> None:
        out = self.root / '.build' / 'out' / 'upper'
        out.mkdir(parents=True)
        (out / 'upper.txt').write_text('HELLO\n')
        code, output = self.build('adopt', 'upper')
        self.assertEqual(code, 2)
        self.assertIn('no notes.txt', output)
        (out / 'notes.txt').write_text('notes\n')
        self.build('adopt', 'upper')
        self.build('run')
        self.assertEqual(self.ran, ['joined'])
        # A deploy done by hand
        self.build('adopt', 'publish')
        self.build('run', '--deploy')
        self.assertEqual(self.ran, ['announce'])

    def test_directory_outputs(self) -> None:
        self.write(
            'steps.toml',
            """
            [steps.split]
            run = "mkdir $OUT/parts; cp text.txt $OUT/parts/a.txt; cp notes.txt $OUT/parts/b.txt"
            files = ["text.txt", "notes.txt"]
            outs = ["parts"]

            [steps.first]
            run = "echo first >> runs; cp $BUILD/split/parts/a.txt $OUT/first.txt"
            needs = ["split/parts/a.txt"]
            outs = ["first.txt"]

            [steps.both]
            run = "echo both >> runs; cat $BUILD/split/parts/*.txt > $OUT/both.txt"
            needs = ["split/parts"]
            outs = ["both.txt"]
            """,
        )
        self.build('run')
        self.assertEqual(self.ran, ['first', 'both'])
        # The state has the hash and size of every output, and of each file of a directory
        parts = self.state()['steps']['split']['outputs']['parts']
        self.assertEqual((parts['size'], parts['files']['a.txt']['size'], parts['files']['b.txt']['size']), (12, 6, 6))
        self.assertEqual(len(parts['hash']), 32)
        self.assertEqual(self.state()['steps']['first']['inputs']['needs'], {'split/parts/a.txt': parts['files']['a.txt']['hash']})
        self.assertEqual(self.state()['steps']['first']['outputs']['first.txt']['size'], 6)
        self.write('notes.txt', 'changed\n')
        self.build('run')
        self.assertEqual(self.ran, ['both'])

    def test_step_file_mistakes_are_refused(self) -> None:
        cases = {
            'the command reads $BUILD/upper': STEPS.replace('needs = ["upper/upper.txt"]', ''),
            'the command reads $SRC_FEED': STEPS.replace('sources = ["feed", "manual"]', 'sources = ["manual"]'),
            'upper has no output': STEPS.replace('needs = ["upper/upper.txt"]', 'needs = ["upper/lower.txt"]'),
            'unknown keys': STEPS.replace('deploy = true', 'deploys = true', 1),
            'unknown source': STEPS.replace('sources = ["feed", "manual"]', 'sources = ["feed", "manual", "x"]'),
            'depend on each other': STEPS.replace('files = ["text.txt", "notes.txt"]', 'after = ["announce"]'),
            'a deploy step has no outputs': STEPS.replace('after = ["publish"]', 'outs = ["x"]'),
            "'missing.txt' matches no file": STEPS.replace('files = ["notes.txt"]', 'files = ["missing.txt"]'),
        }
        for message, steps in cases.items():
            with self.subTest(message):
                self.write('steps.toml', steps)
                code, output = self.build('plan')
                self.assertEqual(code, 2)
                self.assertIn(message, output)

    def test_excluded_files_do_not_count(self) -> None:
        (self.root / 'src').mkdir()
        self.write('src/a.py', 'a\n')
        self.write('src/a_test.py', 'test\n')
        self.write(
            'steps.toml',
            """
            [steps.code]
            run = "echo code >> runs; cat src/a.py > $OUT/code"
            files = ["src", "!src/*_test.py"]
            outs = ["code"]
            """,
        )
        self.build('run')
        self.write('src/a_test.py', 'changed\n')
        self.build('run')
        self.assertEqual(self.ran, [])
        self.write('src/a.py', 'b\n')
        self.build('run')
        self.assertEqual(self.ran, ['code'])


if __name__ == '__main__':
    unittest.main()
