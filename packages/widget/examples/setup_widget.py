#!/usr/bin/env python
"""One-command setup for the Jupyter trajectory widget.

Run this with the SAME Python interpreter your notebook kernel uses::

    python packages/widget/examples/setup_widget.py

It fixes the two cold-checkout failure modes in one go:

1. ``FileNotFoundError: Widget bundle not found`` — the JS bundle under
   ``detailviews/static/widget/`` is gitignored build output; this script runs
   ``npm ci`` (first time) and ``npm run build:widget`` to produce it.
2. ``ModuleNotFoundError: No module named 'detailviews'`` — the package must
   be installed in the *kernel's* environment. This script installs with
   ``sys.executable -m pip`` AND registers a dedicated Jupyter kernel
   ("Python (detailviews demo)") pointing at this exact interpreter — a
   user-level ``python3`` kernelspec often launches whatever ``python`` is
   on PATH, which silently ignores your venv. The demo notebook pins the
   registered kernel, so it resolves to the right environment on first open.

Flags: ``--rebuild`` forces a fresh JS build even if a bundle exists.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

# packages/widget — the pip package (pyproject.toml, detailviews/)
WIDGET_DIR = Path(__file__).resolve().parent.parent
# packages/app — the JS project that builds the widget bundle
APP_DIR = WIDGET_DIR.parent / "app"
# repo root — npm-workspaces umbrella; npm ci runs here
REPO_ROOT = WIDGET_DIR.parent.parent
BUNDLE = WIDGET_DIR / "detailviews" / "static" / "widget" / "index.js"


def run(cmd: list[str], cwd: Path | None = None, batch_shim: bool = False) -> None:
    # Batch shims like npm.cmd need cmd.exe on Windows. Real executables must
    # NOT go through cmd /c: its parser re-splits quoted paths with spaces.
    if batch_shim and sys.platform == "win32":
        cmd = ["cmd", "/c", *cmd]
    print(f"\n>>> {' '.join(cmd)}" + (f"  (in {cwd})" if cwd else ""))
    subprocess.run(cmd, cwd=cwd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--rebuild", action="store_true", help="rebuild the JS bundle even if present"
    )
    args = parser.parse_args()

    if not (REPO_ROOT / "node_modules").is_dir():
        run(["npm", "ci"], cwd=REPO_ROOT, batch_shim=True)
    else:
        print("node_modules present - skipping npm ci")

    if args.rebuild or not BUNDLE.is_file():
        run(["npm", "run", "build:widget"], cwd=APP_DIR, batch_shim=True)
    else:
        print(f"widget bundle present - skipping build ({BUNDLE})")

    run([sys.executable, "-m", "pip", "install", "-e", str(WIDGET_DIR)])

    # Register a kernel bound to THIS interpreter; the demo notebook pins it.
    run([sys.executable, "-m", "pip", "install", "ipykernel"])
    run(
        [
            sys.executable,
            "-m",
            "ipykernel",
            "install",
            "--user",
            "--name",
            "detailviews_demo",
            "--display-name",
            "Python (detailviews demo)",
        ]
    )

    # Import in a fresh interpreter: this also exercises the bundle check in
    # detailviews/__init__.py, so a broken setup fails here, not in the notebook.
    print("\n>>> verifying import in a fresh interpreter")
    subprocess.run(
        [sys.executable, "-c", "import detailviews; print('detailviews OK:', detailviews.__file__)"],
        check=True,
    )

    print(
        "\nSetup complete. Verify in a real notebook:\n"
        "  1. Start Jupyter from this environment and open packages/widget/examples/simple_widget_demo.ipynb.\n"
        "  2. Run all cells; the last cell must show a scatterplot with 8 spiral trajectories.\n"
        "  3. Lasso a few points - insets and cluster contours should appear.\n"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as err:
        print(f"\nsetup_widget: step failed with exit code {err.returncode}", file=sys.stderr)
        sys.exit(err.returncode)
