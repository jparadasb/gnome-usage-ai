import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 300;
const BAR_WIDTH = 220;

const PROVIDERS = [
    {key: 'claude', name: 'Claude Code', short: 'C', url: 'https://claude.ai/settings/usage'},
    {key: 'codex', name: 'Codex', short: 'X', url: 'https://chatgpt.com/codex/settings/usage'},
];

function fmtTokens(n) {
    if (n == null)
        return '–';
    if (n >= 1e9)
        return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3)
        return `${(n / 1e3).toFixed(1)}k`;
    return `${n}`;
}

function fmtReset(epoch) {
    if (!epoch)
        return '';
    const secs = Math.max(0, epoch - Date.now() / 1000);
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0)
        return `resets in ${d}d ${h}h`;
    if (h > 0)
        return `resets in ${h}h ${m}m`;
    return `resets in ${m}m`;
}

function levelClass(pct) {
    if (pct >= 90)
        return 'ai-usage-crit';
    if (pct >= 70)
        return 'ai-usage-warn';
    return 'ai-usage-ok';
}

function sessionPercent(provider) {
    const w = provider?.limits?.windows;
    return w?.length ? Math.max(...w.map(x => x.percent)) : null;
}

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'AI Usage');
        this._ext = ext;
        this._data = null;
        this._error = null;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/ai-usage-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-usage-panel-label',
        });
        box.add_child(this._label);
        this.add_child(box);

        this._content = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._content);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._footer = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._footer.label.add_style_class_name('ai-usage-dim');
        this.menu.addMenuItem(this._footer);

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refresh);

        for (const p of PROVIDERS) {
            const item = new PopupMenu.PopupMenuItem(`Open ${p.name} usage page`);
            item.connect('activate', () => Gio.AppInfo.launch_default_for_uri(p.url, null));
            this.menu.addMenuItem(item);
        }

        // Re-render on open so "resets in" countdowns are fresh.
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._render();
        });

        this._render();
        this.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    refresh() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const proc = Gio.Subprocess.new(
                ['python3', '-I', `${this._ext.path}/helper/ai_usage.py`, '--compact'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                this._busy = false;
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        throw new Error(stderr?.trim() || 'helper failed');
                    this._data = JSON.parse(stdout);
                    this._error = null;
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._error = e.message;
                }
                this._render();
            });
        } catch (e) {
            this._busy = false;
            this._error = e.message;
            this._render();
        }
    }

    _render() {
        this._renderPanel();
        this._renderMenu();
    }

    _renderPanel() {
        if (!this._data) {
            this._label.text = this._error ? '!' : '…';
            return;
        }
        const parts = [];
        let worst = 0;
        for (const p of PROVIDERS) {
            const pct = sessionPercent(this._data[p.key]);
            parts.push(`${p.short} ${pct == null ? '–' : `${Math.round(pct)}%`}`);
            worst = Math.max(worst, pct ?? 0);
        }
        this._label.text = parts.join('  ');
        for (const c of ['ai-usage-ok', 'ai-usage-warn', 'ai-usage-crit'])
            this._label.remove_style_class_name(c);
        if (worst >= 70)
            this._label.add_style_class_name(levelClass(worst));
    }

    _renderMenu() {
        this._content.removeAll();

        if (this._error) {
            const item = new PopupMenu.PopupMenuItem(`Error: ${this._error}`, {reactive: false});
            item.label.add_style_class_name('ai-usage-crit');
            this._content.addMenuItem(item);
        }
        if (!this._data) {
            if (!this._error)
                this._content.addMenuItem(new PopupMenu.PopupMenuItem('Loading…', {reactive: false}));
            this._footer.label.text = '';
            return;
        }

        PROVIDERS.forEach((p, i) => {
            if (i > 0)
                this._content.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._content.addMenuItem(this._providerItem(p, this._data[p.key] ?? {}));
        });

        const age = Math.round((Date.now() / 1000 - this._data.generated_at) / 60);
        this._footer.label.text = `Updated ${age <= 0 ? 'just now' : `${age} min ago`} · auto every ${REFRESH_SECONDS / 60} min`;
    }

    _providerItem(p, data) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'ai-usage-provider'});
        item.add_child(col);

        const limits = data.limits ?? {};
        const tokens = data.tokens ?? {};

        const header = new St.BoxLayout({x_expand: true});
        header.add_child(new St.Label({text: p.name, style_class: 'ai-usage-title', x_expand: true}));
        if (limits.plan)
            header.add_child(new St.Label({text: limits.plan.toUpperCase(), style_class: 'ai-usage-badge'}));
        col.add_child(header);

        if (limits.error)
            col.add_child(new St.Label({text: `⚠ ${limits.error}`, style_class: 'ai-usage-crit'}));

        for (const w of limits.windows ?? [])
            col.add_child(this._windowRow(w));

        if (limits.limit_reached)
            col.add_child(new St.Label({text: 'Limit reached', style_class: 'ai-usage-crit'}));
        if (limits.extra?.percent != null)
            col.add_child(this._windowRow({label: 'Extra usage', percent: limits.extra.percent}));
        if (limits.credits != null)
            col.add_child(new St.Label({text: `Credits: ${limits.credits}`, style_class: 'ai-usage-dim'}));

        if (tokens.error) {
            col.add_child(new St.Label({text: `⚠ ${tokens.error}`, style_class: 'ai-usage-dim'}));
            return item;
        }

        const t = tokens.today;
        let summary = `Today: ${fmtTokens(tokens.today_total)} tokens · ${tokens.sessions_today ?? 0} sessions`;
        col.add_child(new St.Label({text: summary, style_class: 'ai-usage-stat'}));
        if (t) {
            col.add_child(new St.Label({
                text: `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache r ${fmtTokens(t.cache_read)} / w ${fmtTokens(t.cache_write)}`,
                style_class: 'ai-usage-dim',
            }));
        }
        for (const [model, n] of (tokens.models_today ?? []).slice(0, 3)) {
            col.add_child(new St.Label({
                text: `  ${model}: ${fmtTokens(n)}`,
                style_class: 'ai-usage-dim',
            }));
        }
        if (tokens.days?.length)
            col.add_child(this._sparkline(tokens.days));
        return item;
    }

    _windowRow(w) {
        const row = new St.BoxLayout({vertical: true, style_class: 'ai-usage-window'});
        const top = new St.BoxLayout({x_expand: true});
        top.add_child(new St.Label({text: w.label, x_expand: true}));
        top.add_child(new St.Label({
            text: `${Math.round(w.percent)}%`,
            style_class: levelClass(w.percent),
        }));
        row.add_child(top);

        const trough = new St.Widget({style_class: 'ai-usage-trough', width: BAR_WIDTH});
        const fill = new St.Widget({
            style_class: `ai-usage-fill ${levelClass(w.percent)}-bg`,
            width: Math.max(2, Math.round(BAR_WIDTH * Math.min(100, w.percent) / 100)),
        });
        trough.add_child(fill);
        row.add_child(trough);

        if (w.resets_at)
            row.add_child(new St.Label({text: fmtReset(w.resets_at), style_class: 'ai-usage-dim'}));
        return row;
    }

    _sparkline(days) {
        const wrap = new St.BoxLayout({vertical: true, style_class: 'ai-usage-spark-wrap'});
        wrap.add_child(new St.Label({text: 'Last 7 days', style_class: 'ai-usage-dim'}));
        const bars = new St.BoxLayout({style_class: 'ai-usage-spark'});
        const max = Math.max(1, ...days.map(d => d.tokens));
        const H = 32;
        for (const d of days) {
            const col = new St.BoxLayout({vertical: true, style_class: 'ai-usage-spark-col'});
            const h = d.tokens ? Math.max(2, Math.round(H * d.tokens / max)) : 1;
            col.add_child(new St.Widget({height: H - h}));
            col.add_child(new St.Widget({height: h, style_class: 'ai-usage-spark-bar'}));
            const wd = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'narrow'});
            col.add_child(new St.Label({text: wd, style_class: 'ai-usage-spark-day'}));
            bars.add_child(col);
        }
        wrap.add_child(bars);
        return wrap;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        super.destroy();
    }
});

export default class AiUsageExtension extends Extension {
    enable() {
        this._indicator = new UsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
