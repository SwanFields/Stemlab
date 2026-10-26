"""Stand-in for `python -m demucs.separate` used only by the test-suite.

It mimics the parts of the real CLI that app/separators.py depends on:
the -n / -o / --filename options, the output layout <out>/<model>/<filename>,
and a tqdm-style progress bar redrawn with carriage returns on stderr.
"""
import argparse
import shutil
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("-n", "--name", default="htdemucs")
parser.add_argument("-o", "--out", required=True)
parser.add_argument("-d", "--device")
parser.add_argument("--filename", default="{track}/{stem}.{ext}")
parser.add_argument("track")
args = parser.parse_args()

if "FAKE_DEMUCS_FAIL" in __import__("os").environ:
    print("RuntimeError: CUDA out of memory", file=sys.stderr)
    sys.exit(1)

for pct in (0, 25, 50, 75, 100):
    sys.stderr.write(f"\r {pct:3d}%|{'#' * (pct // 10):<10}| {pct}/100 [00:01<00:00]")
    sys.stderr.flush()
sys.stderr.write("\n")

track = Path(args.track)
dest = Path(args.out) / args.name
dest.mkdir(parents=True, exist_ok=True)
for stem in ("vocals", "drums", "bass", "other"):
    name = args.filename.format(track=track.stem, trackext=track.suffix, stem=stem, ext="wav")
    target = dest / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(track, target)
