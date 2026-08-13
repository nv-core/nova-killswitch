import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const DEST = 'org.novanetwork.KillSwitch';
const OBJ = '/org/novanetwork/KillSwitch';

// Talk to nova-killswitchd over the system bus. Passwordless via its bus policy.
function callSync(method, params = null, replyType = null) {
    const bus = Gio.DBus.system;
    return bus.call_sync(DEST, OBJ, DEST, method, params, replyType,
        Gio.DBusCallFlags.NONE, 5000, null);
}

const KillSwitchToggle = GObject.registerClass(
class KillSwitchToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            title: _('Kill Switch'),
            iconName: 'changes-allow-symbolic',
            toggleMode: true,
        });

        this._busy = false;
        this._profile = '';

        this.menu.setHeader('network-vpn-symbolic', _('Nova Kill Switch'));
        this._profiles = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profiles);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Settings…'), () => this._openSettings());

        this.connect('clicked', () => this._onClicked());
        this.connect('destroy', () => this._onDestroy());

        // live updates: the daemon emits Changed on every state change
        this._sigId = Gio.DBus.system.signal_subscribe(
            DEST, DEST, 'Changed', OBJ, null, Gio.DBusSignalFlags.NONE,
            () => this._refresh());

        this._buildProfiles();
        this._refresh();
    }

    _buildProfiles() {
        this._profiles.removeAll();
        let names = [];
        try {
            names = callSync('ListProfiles', null,
                new GLib.VariantType('(as)')).deepUnpack()[0];
        } catch (e) {
            names = [];
        }
        for (const name of names) {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => {
                this._profile = name;
                if (this.checked)
                    this._arm(name);
                this._refresh();
            });
            item._name = name;
            this._profiles.addMenuItem(item);
        }
    }

    _openSettings() {
        try {
            Gio.Subprocess.new(['nova-killswitch-settings'], Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify(_('Nova Kill Switch'), _('Settings app not installed.'));
        }
    }

    _onClicked() {
        if (this._busy)
            return;
        if (this.checked)
            this._arm(this._profile);
        else
            this._call('Disarm');
    }

    _arm(profile) {
        this._call('Arm', new GLib.Variant('(s)', [profile || '']));
    }

    _call(method, params = null) {
        this._busy = true;
        this.reactive = false;
        try {
            callSync(method, params, null);
        } catch (e) {
            Main.notify(_('Nova Kill Switch'), e.message);
        }
        this._busy = false;
        this.reactive = true;
        this._refresh();
    }

    _refresh() {
        let st = {};
        try {
            const r = callSync('GetStatus', null, new GLib.VariantType('(a{sv})'));
            const dict = r.deepUnpack()[0];
            for (const k in dict)
                st[k] = dict[k].deepUnpack();
        } catch (e) {
            this.subtitle = _('daemon off');
            this.iconName = 'changes-allow-symbolic';
            return;
        }

        const armed = st.armed === true || st.armed === 'true';
        this._syncing = true;
        this.checked = armed;
        this._syncing = false;

        for (const item of this._profiles._getMenuItems())
            item.setOrnament(item._name === (this._profile || st.profile)
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

        if (!armed) {
            this.iconName = 'changes-allow-symbolic';
            this.subtitle = _('Off');
        } else {
            this.iconName = st.final_iface || st.node_path === 'local' || st.node_path === 'vpn'
                ? 'changes-prevent-symbolic' : 'dialog-warning-symbolic';
            this.subtitle = st.detail || _('Protected');
        }
    }

    _onDestroy() {
        if (this._sigId)
            Gio.DBus.system.signal_unsubscribe(this._sigId);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends QuickSettings.SystemIndicator {
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
        this._indicator = new Indicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }
    disable() {
        this._indicator.quickSettingsItems.forEach(i => i.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
