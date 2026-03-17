#!/usr/bin/env python3
"""Execute the committed solo dev assistant source.

The solo assistant now lives in a normal local source file beside this
entrypoint so self-build and assistant-first edits do not depend on
``tmp/copilot_restore`` materialization.
"""

from __future__ import annotations

from pathlib import Path


_SCRIPT_DIR = Path(__file__).resolve().parent
_LOCAL_SOURCE = _SCRIPT_DIR / "solo_dev_assistant_runtime.py"


def _resolve_source() -> Path:
	if not _LOCAL_SOURCE.exists():
		raise FileNotFoundError(
			"committed solo assistant source is missing: "
			f"{_LOCAL_SOURCE}"
		)
	return _LOCAL_SOURCE


_SOURCE = _resolve_source()
exec(compile(_SOURCE.read_text(encoding="utf-8"), str(_SOURCE), "exec"), globals())
