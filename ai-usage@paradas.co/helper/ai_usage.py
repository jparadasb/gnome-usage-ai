#!/usr/bin/env python3
"""Collect Claude Code and Codex usage and print it as JSON.

Rate-limit windows come from the same endpoints the CLIs use, authenticated
with the tokens they already store locally (read-only, never refreshed here).
Token totals are computed from local session logs.
"""
import glob
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(HOME, ".claude"))
CODEX_DIR = os.environ.get("CODEX_HOME", os.path.join(HOME, ".codex"))
TIMEOUT = 10
DAYS = 7


def http_json(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.load(resp)


def http_error(e):
    if isinstance(e, urllib.error.HTTPError):
        if e.code in (401, 403):
            return "auth expired - open the CLI once to refresh login"
        return f"HTTP {e.code}"
    if isinstance(e, urllib.error.URLError):
        return f"network: {e.reason}"
    return str(e)


def iso_to_epoch(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def day_keys():
    today = datetime.now().date()
    return [(today - timedelta(days=i)).isoformat() for i in range(DAYS - 1, -1, -1)]


# ---------------------------------------------------------------- Claude

def claude_limits():
    path = os.path.join(CLAUDE_DIR, ".credentials.json")
    try:
        oauth = json.load(open(path))["claudeAiOauth"]
    except (OSError, KeyError, ValueError):
        return {"error": "not logged in"}
    out = {
        "plan": oauth.get("subscriptionType"),
        "tier": oauth.get("rateLimitTier"),
    }
    try:
        data = http_json(
            "https://api.anthropic.com/api/oauth/usage",
            {
                "Authorization": f"Bearer {oauth['accessToken']}",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "claude-code/2.0",
            },
        )
    except Exception as e:  # noqa: BLE001
        out["error"] = http_error(e)
        return out

    windows = []
    labels = {
        "five_hour": "Session (5h)",
        "seven_day": "Weekly",
        "seven_day_opus": "Weekly Opus",
        "seven_day_sonnet": "Weekly Sonnet",
    }
    for key, label in labels.items():
        w = data.get(key)
        if w and w.get("utilization") is not None:
            windows.append({
                "label": label,
                "percent": float(w["utilization"]),
                "resets_at": iso_to_epoch(w.get("resets_at")),
            })
    out["windows"] = windows
    extra = data.get("extra_usage") or {}
    if extra.get("is_enabled"):
        out["extra"] = {
            "used": extra.get("used_credits"),
            "limit": extra.get("monthly_limit"),
            "percent": extra.get("utilization"),
        }
    return out


def claude_tokens():
    days = day_keys()
    cutoff = time.time() - DAYS * 86400
    per_day = {d: 0 for d in days}
    models = {}
    seen = set()
    sessions_today = set()
    today = days[-1]
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    files = glob.glob(os.path.join(CLAUDE_DIR, "projects", "*", "**", "*.jsonl"), recursive=True)
    for f in files:
        try:
            if os.path.getmtime(f) < cutoff:
                continue
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                msg = d.get("message") or {}
                u = msg.get("usage")
                ts = d.get("timestamp")
                if not u or not ts:
                    continue
                key = (msg.get("id"), d.get("requestId"))
                if key in seen:
                    continue
                seen.add(key)
                day = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().date().isoformat()
                if day not in per_day:
                    continue
                inp = u.get("input_tokens", 0) or 0
                outp = u.get("output_tokens", 0) or 0
                cr = u.get("cache_read_input_tokens", 0) or 0
                cw = u.get("cache_creation_input_tokens", 0) or 0
                total = inp + outp + cr + cw
                per_day[day] += total
                if day == today:
                    totals["input"] += inp
                    totals["output"] += outp
                    totals["cache_read"] += cr
                    totals["cache_write"] += cw
                    sessions_today.add(d.get("sessionId"))
                    m = msg.get("model", "?")
                    if m != "<synthetic>":
                        models[m] = models.get(m, 0) + total
    return {
        "days": [{"date": d, "tokens": per_day[d]} for d in days],
        "today": totals,
        "today_total": per_day[today],
        "sessions_today": len(sessions_today),
        "models_today": sorted(models.items(), key=lambda kv: -kv[1]),
    }


# ---------------------------------------------------------------- Codex

def codex_limits():
    try:
        tokens = json.load(open(os.path.join(CODEX_DIR, "auth.json")))["tokens"]
    except (OSError, KeyError, ValueError, TypeError):
        return {"error": "not logged in"}
    out = {}
    try:
        data = http_json(
            "https://chatgpt.com/backend-api/wham/usage",
            {
                "Authorization": f"Bearer {tokens['access_token']}",
                "ChatGPT-Account-Id": tokens.get("account_id", ""),
                "User-Agent": "codex_cli_rs",
            },
        )
    except Exception as e:  # noqa: BLE001
        out["error"] = http_error(e)
        return out
    out["plan"] = data.get("plan_type")
    rl = data.get("rate_limit") or {}
    windows = []
    for key in ("primary_window", "secondary_window"):
        w = rl.get(key)
        if not w:
            continue
        secs = w.get("limit_window_seconds") or 0
        if secs <= 6 * 3600:
            label = f"Session ({round(secs / 3600)}h)"
        elif secs >= 6 * 86400:
            label = "Weekly"
        else:
            label = f"{round(secs / 3600)}h window"
        windows.append({
            "label": label,
            "percent": float(w.get("used_percent") or 0),
            "resets_at": w.get("reset_at"),
        })
    out["windows"] = windows
    out["limit_reached"] = bool(rl.get("limit_reached"))
    credits = data.get("credits") or {}
    if credits.get("has_credits"):
        out["credits"] = credits.get("balance")
    return out


def codex_tokens():
    days = day_keys()
    per_day = {d: 0 for d in days}
    models = {}
    today = days[-1]
    sessions_today = 0
    db = os.path.join(CODEX_DIR, "state_5.sqlite")
    if not os.path.exists(db):
        cands = sorted(glob.glob(os.path.join(CODEX_DIR, "state_*.sqlite")))
        if not cands:
            return {"error": "no codex state db"}
        db = cands[-1]
    cutoff = int(time.time()) - DAYS * 86400
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        rows = con.execute(
            "SELECT updated_at, tokens_used, COALESCE(model, model_provider) "
            "FROM threads WHERE updated_at >= ?",
            (cutoff,),
        ).fetchall()
        con.close()
    except sqlite3.Error as e:
        return {"error": f"sqlite: {e}"}
    # tokens_used is cumulative per thread; attribute it to its last-active day
    for updated, used, model in rows:
        day = datetime.fromtimestamp(updated).date().isoformat()
        if day not in per_day:
            continue
        per_day[day] += used or 0
        if day == today:
            sessions_today += 1
            m = model or "?"
            models[m] = models.get(m, 0) + (used or 0)
    return {
        "days": [{"date": d, "tokens": per_day[d]} for d in days],
        "today_total": per_day[today],
        "sessions_today": sessions_today,
        "models_today": sorted(models.items(), key=lambda kv: -kv[1]),
    }


def safe(fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


def main():
    result = {
        "generated_at": time.time(),
        "claude": {"limits": safe(claude_limits), "tokens": safe(claude_tokens)},
        "codex": {"limits": safe(codex_limits), "tokens": safe(codex_tokens)},
    }
    json.dump(result, sys.stdout, indent=None if "--compact" in sys.argv else 2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
