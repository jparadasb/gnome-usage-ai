# AI Usage — GNOME Shell extension

Top-bar indicator showing Claude Code and Codex usage. The panel shows the highest
current limit window for each tool (`C 2%  X 0%`); click it for details.

Dropdown per tool:
- plan badge
- rate-limit windows (5h session, weekly) with progress bars and reset countdowns
- today's tokens (input / output / cache), session count, top models
- last 7 days bar chart

## Data sources

| | Limits (live) | Token stats (local) |
|---|---|---|
| Claude Code | `GET api.anthropic.com/api/oauth/usage` using token in `~/.claude/.credentials.json` | `~/.claude/projects/**/*.jsonl` |
| Codex | `GET chatgpt.com/backend-api/wham/usage` using token in `~/.codex/auth.json` | `threads` table in `~/.codex/state_5.sqlite` |

Tokens are only read, never refreshed. If one shows "auth expired", run that CLI once.
These usage endpoints are undocumented and may change.

Everything is collected by `helper/ai_usage.py` (stdlib only), which the extension
runs every 5 minutes. Run it by hand to debug:

```sh
python3 ai-usage@paradas.co/helper/ai_usage.py
```

## Install

```sh
./install.sh
```

Symlinks the extension into `~/.local/share/gnome-shell/extensions/`. On Wayland,
log out and back in, then `gnome-extensions enable ai-usage@paradas.co`.

Logs: `journalctl --user -f -o cat /usr/bin/gnome-shell`.
