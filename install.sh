#!/usr/bin/env bash
# installer for nova-killswitch — nova convention, DUAL SCOPE.
#
# Listed in the catalog twice (user + scope=system). nova runs this with:
#   NOVA_SCOPE=system  -> root backend: ctl, monitor, systemd units,
#                         NM dispatcher, polkit rule, /etc/nova-killswitch
#   NOVA_SCOPE=user    -> GNOME extension + GTK settings app (skipped headless)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-install}"
SCOPE="${NOVA_SCOPE:-system}"

EXT_UUID="nova-killswitch@nv-core.net"

want_gui() {
    [[ ${NOVA_GUI:-} == 0 ]] && return 1
    [[ -n ${NOVA_GUI:-} ]] && return 0
    [[ -e /usr/lib64/girepository-1.0/Gtk-4.0.typelib ||
       -e /usr/lib/girepository-1.0/Gtk-4.0.typelib ]]
}
say() { printf ':: %s\n' "$*"; }

# ---------------- system scope (root) ---------------------------------------
sys_install() {
    say "installing kill switch backend (root)"
    install -Dm755 "$SRC/backend/nova-killswitch-ctl"     /usr/local/sbin/nova-killswitch-ctl
    install -Dm755 "$SRC/backend/nova-killswitch-monitor" /usr/local/sbin/nova-killswitch-monitor
    install -Dm644 "$SRC/backend/systemd/nova-killswitch-restore.service" /etc/systemd/system/nova-killswitch-restore.service
    install -Dm644 "$SRC/backend/systemd/nova-killswitch-monitor.service" /etc/systemd/system/nova-killswitch-monitor.service
    install -Dm755 "$SRC/backend/dispatcher/90-nova-killswitch" /etc/NetworkManager/dispatcher.d/90-nova-killswitch
    install -Dm644 "$SRC/backend/polkit/50-nova-killswitch.rules" /etc/polkit-1/rules.d/50-nova-killswitch.rules

    install -dm755 /etc/nova-killswitch /etc/nova-killswitch/profiles
    [[ -f /etc/nova-killswitch/config ]] || install -Dm644 "$SRC/config.sample" /etc/nova-killswitch/config

    systemctl daemon-reload
    systemctl enable --now nova-killswitch-restore.service
    systemctl enable --now nova-killswitch-monitor.service
    say "backend installed — arm from the GNOME toggle or: pkexec nova-killswitch-ctl enable"
}

sys_update() { sys_install; }

sys_uninstall() {
    say "disarming + removing kill switch backend"
    /usr/local/sbin/nova-killswitch-ctl disable 2>/dev/null || true
    systemctl disable --now nova-killswitch-monitor.service 2>/dev/null || true
    systemctl disable --now nova-killswitch-restore.service 2>/dev/null || true
    rm -f /usr/local/sbin/nova-killswitch-ctl /usr/local/sbin/nova-killswitch-monitor \
          /etc/systemd/system/nova-killswitch-restore.service \
          /etc/systemd/system/nova-killswitch-monitor.service \
          /etc/NetworkManager/dispatcher.d/90-nova-killswitch \
          /etc/polkit-1/rules.d/50-nova-killswitch.rules
    systemctl daemon-reload
    say "kept: /etc/nova-killswitch (config + profiles) — remove manually if wanted"
}

# ---------------- user scope ------------------------------------------------
user_install() {
    if ! want_gui; then
        say "no GTK4/GNOME stack (or NOVA_GUI=0) — skipping extension + settings app"
        return
    fi
    local ext_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"
    say "installing GNOME extension -> $ext_dir"
    mkdir -p "$ext_dir"
    cp "$SRC/extension/extension.js" "$SRC/extension/metadata.json" "$ext_dir/"

    say "installing settings app"
    install -Dm755 "$SRC/gui/nova-killswitch-settings" "$HOME/.local/bin/nova-killswitch-settings"
    install -Dm644 "$SRC/data/nova-killswitch.desktop" \
        "${XDG_DATA_HOME:-$HOME/.local/share}/applications/org.novanetwork.NovaKillSwitch.desktop"

    command -v gnome-extensions >/dev/null 2>&1 && \
        gnome-extensions enable "$EXT_UUID" 2>/dev/null || true
    say "extension installed — log out/in (or Alt+F2 'r' on X11) to load it"
}

user_update() { user_install; }

user_uninstall() {
    local ext_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"
    command -v gnome-extensions >/dev/null 2>&1 && gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
    rm -rf "$ext_dir"
    rm -f "$HOME/.local/bin/nova-killswitch-settings" \
          "${XDG_DATA_HOME:-$HOME/.local/share}/applications/org.novanetwork.NovaKillSwitch.desktop"
    say "extension + settings app removed"
}

case "$SCOPE" in
    system) "sys_$ACTION" ;;
    user)   "user_$ACTION" ;;
    *) echo "unknown NOVA_SCOPE: $SCOPE" >&2; exit 1 ;;
esac
