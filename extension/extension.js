import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const CTL_PATH = '/usr/local/sbin/nova-killswitch-ctl';
const STATE_DIR = '/etc/nova-killswitch';
const STATE_FILE = `${STATE_DIR}/state`;
const CURRENT_FILE = `${STATE_DIR}/current`;
const PROFILES_DIR = `${STATE_DIR}/profiles`;

function readTextFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch (e) {
        return null;
    }
}

function parseCurrent(text) {
    const out = {mode: 'full', profile: '', trusted: '', ifaces: '', node_path: ''};
    if (!text)
        return out;
    for (const line of text.split('\n')) {
        const m = line.match(/^(MODE|PROFILE|TRUSTED|IFACES|NODE_PATH)=(.*)$/);
        if (!m)
            continue;
        const key = m[1].toLowerCase();
        out[key] = m[2].trim().replace(/^"(.*)"$/, '$1');
    }
    return out;
}

function listProfiles() {
    const names = [];
    try {
        const dir = Gio.File.new_for_path(PROFILES_DIR);
        const en = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const n = info.get_name();
            if (n.endsWith('.profile'))
                names.push(n.slice(0, -8));
        }
    } catch (e) {
        // no profiles dir yet
    }
    return names.sort();
}

const KillSwitchToggle = GObject.registerClass(
class KillSwitchToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            title: _('Kill Switch'),
            iconName: 'changes-allow-symbolic',
            toggleMode: true,
        });

        this._syncing = false;
        this._pending = false;
        this._profile = '';   // '' = default profile from config

        this.menu.setHeader('network-vpn-symbolic', _('Nova Kill Switch'));
        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = this.menu.addAction(_('Settings…'),
            () => this._openSettings());
        settingsItem.visible = true;

        this.connect('clicked', () => this._onClicked());
        this.connect('destroy', () => this._onDestroy());

        this._monitors = [];
        for (const path of [STATE_FILE, CURRENT_FILE]) {
            try {
                const m = Gio.File.new_for_path(path)
                    .monitor_file(Gio.FileMonitorFlags.NONE, null);
                m.connect('changed', () => this._refresh());
                this._monitors.push(m);
            } catch (e) {
                // file may not exist yet; refresh still polls
            }
        }

        this._buildProfileMenu();
        this._refresh();
    }

    _buildProfileMenu() {
        this._profileSection.removeAll();
        const profiles = listProfiles();
        if (profiles.length === 0)
            return;
        for (const name of profiles) {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => {
                this._profile = name;
                if (this.checked)
                    this._run(['enable', name]);   // re-arm with this profile
                this._refresh();
            });
            this._profileSection.addMenuItem(item);
            item._novaProfile = name;
        }
    }

    _openSettings() {
        try {
            Gio.Subprocess.new(['nova-killswitch-settings'],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify(_('Nova Kill Switch'),
                _('Settings app not installed.'));
        }
    }

    _onClicked() {
        if (this._syncing || this._pending)
            return;
        const wantArmed = this.checked;
        this._run(wantArmed ? ['enable', this._profile] : ['disable']);
    }

    _run(args) {
        this._pending = true;
        this.reactive = false;
        const argv = ['pkexec', CTL_PATH, ...args.filter(a => a !== '')];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'nova-killswitch: failed to spawn pkexec');
            this._pending = false;
            this.reactive = true;
            this._refresh();
            return;
        }
        proc.wait_check_async(null, (source, res) => {
            try {
                source.wait_check_finish(res);
            } catch (e) {
                logError(e, `nova-killswitch: ${args.join(' ')} failed`);
            }
            this._pending = false;
            this.reactive = true;
            this._refresh();
        });
    }

    _refresh() {
        const armed = (readTextFile(STATE_FILE) || '').trim() === 'armed';
        const {mode, profile, trusted, ifaces} = parseCurrent(readTextFile(CURRENT_FILE));

        this._syncing = true;
        this.checked = armed;
        this._syncing = false;

        // reflect the active profile in the submenu ornament
        for (const item of this._profileSection._getMenuItems())
            item.setOrnament(item._novaProfile === (this._profile || profile)
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

        // padlock metaphor: open = off, closed = protected, warning = blocking
        if (!armed) {
            this.iconName = 'changes-allow-symbolic';
            this.subtitle = _('Off');
        } else if (mode === 'node' || mode === 'dns') {
            const path = parseCurrent(readTextFile(CURRENT_FILE)).node_path;
            if (path === 'none') {
                this.iconName = 'dialog-warning-symbolic';
                this.subtitle = _('Node unreachable');
            } else {
                this.iconName = 'changes-prevent-symbolic';
                this.subtitle = path === 'local' ? _('Node · local')
                    : path === 'vpn' ? _('Node · VPN') : _('Node access');
            }
        } else if (trusted) {
            this.iconName = 'changes-prevent-symbolic';
            this.subtitle = _('Trusted gateway');
        } else if (ifaces) {
            this.iconName = 'changes-prevent-symbolic';
            this.subtitle = _('Protected · %s').format(ifaces.split(' ').join('→'));
        } else {
            this.iconName = 'dialog-warning-symbolic';
            this.subtitle = _('Blocking — no VPN');
        }
    }

    _onDestroy() {
        for (const m of this._monitors)
            m.cancel();
        this._monitors = [];
    }
});

const KillSwitchIndicator = GObject.registerClass(
class KillSwitchIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'changes-allow-symbolic';

        this._toggle = new KillSwitchToggle();
        this._toggle.bind_property('checked', this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this._toggle.bind_property('icon-name', this._indicator, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);
        this.quickSettingsItems.push(this._toggle);
    }
});

export default class NovaKillSwitchExtension extends Extension {
    enable() {
        this._indicator = new KillSwitchIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(i => i.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
