#!/usr/bin/env python3
"""Executable shim with a latency-isolated status-line import path."""

import sys

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "statusline":
        from ai_usage.sensor_cli import main

        raise SystemExit(main(sys.argv[2:]))
    from ai_usage.cli import main

    raise SystemExit(main())
