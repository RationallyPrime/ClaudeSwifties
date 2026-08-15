"""Command-line entry points for sensors, supervisors, and installers."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import CollectorConfig
from .errors import CollectorError
from .installer import install, uninstall
from .sensor_cli import statusline as render_statusline
from .supervisor import Supervisor, doctor_report


def statusline(config_path: Path) -> int:
    raw_input = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)  # exactly one stdin read
    sys.stdout.buffer.write(render_statusline(config_path, raw_input))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI Usage schema-3 edge collector")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("statusline", "supervise", "doctor"):
        command = subparsers.add_parser(name)
        command.add_argument("--config", required=True, type=Path)
    install_parser = subparsers.add_parser("install")
    install_parser.add_argument(
        "--provider", choices=("claude", "codex", "grok"), required=True
    )
    uninstall_parser = subparsers.add_parser("uninstall")
    uninstall_parser.add_argument(
        "--provider", choices=("claude", "codex", "grok"), required=True
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "statusline":
            return statusline(args.config)
        if args.command == "supervise":
            result = Supervisor(CollectorConfig.load(args.config)).run()
        elif args.command == "doctor":
            result = doctor_report(CollectorConfig.load(args.config))
        elif args.command == "install":
            result = install(args.provider)
        else:
            result = uninstall(args.provider)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except (CollectorError, OSError, ValueError) as error:
        # Do not print exception reprs; config/transport objects can retain
        # secret values. Expected messages are deliberately bounded/redacted.
        print(f"ai-usage: {error}", file=sys.stderr)
        return 1
