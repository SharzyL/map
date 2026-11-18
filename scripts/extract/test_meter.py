"""Tests of meter.py: python3 -m unittest discover -s scripts/extract"""

import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import meter  # noqa: E402

# Writes `n` chunks of 1 MB, one every `pause` seconds
PRODUCER = 'import sys, time\nfor _ in range({n}):\n    sys.stdout.buffer.write(b"x" * 1_000_000); sys.stdout.flush(); time.sleep({pause})\n'


def run(n: int, pause: float, *args: str) -> subprocess.CompletedProcess:
    producer = subprocess.Popen([sys.executable, '-c', PRODUCER.format(n=n, pause=pause)], stdout=subprocess.PIPE)
    result = subprocess.run(
        [sys.executable, str(HERE / 'meter.py'), *args], stdin=producer.stdout, capture_output=True, text=False
    )
    producer.stdout.close()
    producer.wait()
    return result


class MeterTest(unittest.TestCase):
    def test_passes_everything_through_and_says_how_far_it_is(self) -> None:
        result = run(8, 0.1, 'pass 1/2', '8000000', '--every', '0.25')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'x' * 8_000_000)
        lines = result.stderr.decode().splitlines()
        self.assertGreaterEqual(len(lines), 3)
        self.assertRegex(lines[0], r'^pass 1/2: \d+ MB of 8 MB \(\d+%\) in 0 s, \d+ MB/s now, \d+ MB/s on average, about 0 s left$')
        self.assertRegex(lines[-1], r'^pass 1/2: 8 MB in 0 s, \d+ MB/s on average$')

    def test_without_a_total(self) -> None:
        result = run(3, 0.15, 'pass 2/2', '--every', '0.1')
        lines = result.stderr.decode().splitlines()
        self.assertRegex(lines[0], r'^pass 2/2: \d+ MB in 0 s, \d+ MB/s now, \d+ MB/s on average$')

    def test_words(self) -> None:
        self.assertEqual(
            meter.line('pass 1/2', 31_400_000_000, 95_200_000_000, 600, (16_200_000_000, 300)),
            'pass 1/2: 31.4 GB of 95.2 GB (32%) in 10 min, 54 MB/s now, 52 MB/s on average, about 19 min left',
        )
        self.assertEqual(meter.span(4830), '1 h 20 min')

    def test_stops_when_its_reader_does(self) -> None:
        producer = subprocess.Popen([sys.executable, '-c', PRODUCER.format(n=50, pause=0.01)], stdout=subprocess.PIPE)
        metered = subprocess.Popen([sys.executable, str(HERE / 'meter.py'), 'x'], stdin=producer.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        metered.stdout.read(10)
        metered.stdout.close()
        self.assertEqual(metered.wait(timeout=10), 1)
        producer.kill()
        producer.stdout.close()
        producer.wait()
        metered.stderr.close()


if __name__ == '__main__':
    unittest.main()
