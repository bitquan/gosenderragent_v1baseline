#!/usr/bin/env python3
"""Analyze backend/scripts/dev_assistant.log and emit usage insights."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
LOG_PATH = Path(__file__).resolve().parent / "dev_assistant.log"
BAT_BOARD = REPO_ROOT / "docs" / "BAT_FEATURE_BOARD.md"
REPORT_PATH = REPO_ROOT / "docs" / "DEV_ASSISTANT_LOG_REPORT.md"


def load_tickets() -> dict[str, str]:
    tickets: dict[str, str] = {}
    if not BAT_BOARD.exists():
        return tickets
    for line in BAT_BOARD.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line.startswith("- `BAT<"):
            continue
        try:
            head, desc = line.split("`", 2)[1], line.split("`", 2)[2].strip()
            ticket_id = head.removeprefix("BAT<").removesuffix(">")
        except Exception:
            continue
        if ticket_id.isdigit() and ticket_id not in tickets:
            tickets[ticket_id] = desc
    return tickets


def parse_log(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    for idx, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        payload["_line"] = idx
        rows.append(payload)
    return rows


def render_report(entries: list[dict[str, Any]], tickets: dict[str, str]) -> str:
    total = len(entries)
    by_ticket = Counter(str(e.get("ticket", "")) for e in entries if e.get("ticket"))
    by_template = Counter(str(e.get("template", "none")) for e in entries)
    ai_count = sum(1 for e in entries if e.get("ai"))
    write_count = sum(1 for e in entries if e.get("write"))
    git_count = sum(1 for e in entries if e.get("git"))
    brainstorm_count = sum(1 for e in entries if e.get("brainstorm") or e.get("brainstorm_notes"))
    bot_count = sum(1 for e in entries if e.get("run_mode") in ("autopilot", "batch", "scheduled"))
    mode_counts: Counter[str] = Counter(str(e.get("run_mode", "manual")) for e in entries)
    schedule_counts: Counter[str] = Counter(str(e.get("schedule")) for e in entries if e.get("schedule"))

    tag_counts: Counter[str] = Counter()
    for ticket, count in by_ticket.items():
        desc = tickets.get(ticket, "")
        for fragment in desc.split("]"):
            if fragment.startswith("["):
                tag_counts[fragment.removeprefix("[").strip().upper()] += count

    repeat_tickets = [t for t, count in by_ticket.items() if count > 1]

    recommendations: list[str] = []
    if total == 0:
        recommendations.append("No log data available yet; run assistant once to seed analysis.")
    else:
        if ai_count / total < 0.4:
            recommendations.append("Add stronger default templates per BAT class so non-AI runs still generate structured boilerplate.")
        if write_count / total < 0.6:
            recommendations.append("Promote a 'write stubs' default profile in VS Code prompts to reduce preview-only churn.")
        if git_count / max(total, 1) < 0.25:
            recommendations.append("Use AI+write+git profile for launch-critical BATs so scaffold PRs are traceable.")
        if repeat_tickets:
            recommendations.append("Repeated BAT runs detected; add ticket-specific template profiles to reduce reruns.")
        if brainstorm_count / max(total, 1) < 0.3:
            recommendations.append("Enable brainstorming by default for SEC/OPS/QA tickets to improve prompt specificity.")

    prompt_profiles = {
        "BE": "Focus prompt on endpoint contract, DB migration safety, auth guard matrix, and pytest coverage.",
        "FE": "Focus prompt on route-level UX states, mobile breakpoints, API typing, and interaction tests.",
        "SEC": "Focus prompt on threat path, deny-by-default checks, observability/audit events, and abuse tests.",
        "OPS": "Focus prompt on rollout/rollback commands, health probes, and production smoke validation.",
        "QA": "Focus prompt on role matrix, regression scenarios, and deterministic test fixtures.",
    }

    lines: list[str] = []
    lines.append("# Dev Assistant Log Report")
    lines.append("")
    lines.append(f"Generated: {datetime.now(timezone.utc).isoformat()}")
    lines.append("")
    lines.append("## Usage Summary")
    lines.append(f"- Total runs: {total}")
    lines.append(f"- Bot/auto runs: {bot_count}")
    lines.append(f"- AI enabled runs: {ai_count}")
    lines.append(f"- Write runs: {write_count}")
    lines.append(f"- Git runs: {git_count}")
    lines.append(f"- Brainstorm-enabled runs: {brainstorm_count}")
    lines.append("")

    lines.append("## Run Mode Breakdown")
    for mode, cnt in mode_counts.items():
        lines.append(f"- {mode}: {cnt}")
    lines.append("")
    if schedule_counts:
        lines.append("## Cron Expressions")
        for expr, cnt in schedule_counts.items():
            lines.append(f"- {expr}: {cnt}")
        lines.append("")

    lines.append("## Scaffolded Tickets")
    if by_ticket:
        for ticket, count in by_ticket.most_common():
            desc = tickets.get(ticket, "(ticket not found in board)")
            lines.append(f"- BAT<{ticket}>: {count} run(s) :: {desc}")
    else:
        lines.append("- None")
    lines.append("")

    lines.append("## Template Usage")
    if by_template:
        for template, count in by_template.most_common():
            lines.append(f"- {template}: {count}")
    else:
        lines.append("- None")
    lines.append("")

    lines.append("## Tag Distribution")
    if tag_counts:
        for tag, count in tag_counts.most_common():
            lines.append(f"- [{tag}]: {count}")
    else:
        lines.append("- None")
    lines.append("")

    lines.append("## Prompt Refinement Profiles")
    for tag, guidance in prompt_profiles.items():
        lines.append(f"- [{tag}] {guidance}")
    lines.append("")

    lines.append("## Recommendations")
    for rec in recommendations:
        lines.append(f"- {rec}")
    lines.append("")

    if repeat_tickets:
        lines.append("## Repeated Tickets")
        for ticket in repeat_tickets:
            lines.append(f"- BAT<{ticket}> repeated {by_ticket[ticket]} times")
        lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze dev assistant usage log")
    parser.add_argument("--log", default=str(LOG_PATH), help="Path to dev_assistant.log")
    parser.add_argument("--write-report", action="store_true", help="Write markdown report to docs/DEV_ASSISTANT_LOG_REPORT.md")
    parser.add_argument("--serve", action="store_true", help="Start a tiny HTTP server exposing the report")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on when --serve is used")
    args = parser.parse_args()

    entries = parse_log(Path(args.log))
    tickets = load_tickets()
    report = render_report(entries, tickets)

    print(report)
    if args.write_report:
        REPORT_PATH.write_text(report + "\n", encoding="utf-8")
        print(f"\nWrote {REPORT_PATH}")

    if args.serve:
        # serve report on localhost
        import http.server
        import socketserver

        class ReportHandler(http.server.SimpleHTTPRequestHandler):
            def do_GET(self):
                if self.path in ("/", "/index.html"):
                    self.send_response(200)
                    self.send_header("Content-type", "text/html; charset=utf-8")
                    self.end_headers()
                    # simple card-based dashboard with Chart.js for run_mode breakdown
                    bot_pct = (bot_count / total * 100) if total else 0
                    risk_score = min(100, bot_pct * 1.5 + len(repeat_tickets) * 5)
                    html = f"""
<html><head>
<title>Dev Assistant Dashboard</title>
<style>
body {{ background:#1e1e1e; color:#eee; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }}
.card {{ display:inline-block; background:#2d2d2d; border-radius:8px; padding:12px 16px; margin:8px; min-width:120px; text-align:center; }}
.card .value {{ font-size:24px; font-weight:700; }}
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head><body>
<h1>Dev Assistant Dashboard</h1>
<div class="card"><div class="label">Total runs</div><div class="value">{total}</div></div>
<div class="card"><div class="label">Bot runs</div><div class="value">{bot_count}</div></div>
<div class="card"><div class="label">Risk score</div><div class="value">{risk_score:.1f}%</div></div>
<canvas id="modeChart" width="400" height="200"></canvas>
<script>
var ctx = document.getElementById('modeChart').getContext('2d');
new Chart(ctx, {{
    type: 'pie',
    data: {{
        labels: {list(mode_counts.keys())},
        datasets: [{{ data: {list(mode_counts.values())},
                     backgroundColor: ['#4caf50','#2196f3','#ff9800','#f44336','#9c27b0'] }}]
    }},
    options: {{ plugins: {{ legend: {{ labels: {{ color: '#eee' }} }} }} }}
}});
</script>
</body></html>"""
                    self.wfile.write(html.encode("utf-8"))
                else:
                    self.send_error(404)

        with socketserver.TCPServer(("", args.port), ReportHandler) as httpd:
            print(f"serving report at http://localhost:{args.port}")
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("stopping server")


if __name__ == "__main__":
    main()
