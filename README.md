# nova-killswitch

A fail-closed VPN kill switch for the **Nova Network**, built for GNOME on
Fedora Silverblue / Bluefin. Combines the correct root-firewall architecture
of a proper kill switch with intelligent, leak-proof automation:

- **Fail-closed nftables** — `policy drop` on input *and* output, IPv6
  included, swapped atomically. Armed = nothing leaves except through an
  allowed path. If the VPN drops, or you reboot, or you switch Wi-Fi→5G,
  traffic stays blocked until a permitted path is back.
- **VPN chaining** — named *profiles* of ordered layers (`tun0`, then `tun1`
  routed over `tun0`, …). Each layer may be a NetworkManager connection, a
  native WireGuard interface, or a `wg-quick`/systemd tunnel.
- **Trusted gateways (IP + MAC)** — your nova-nodes / VPN routers. When the
  default gateway matches a configured IP *and* its ARP MAC, its uplink is
  trusted and the VPN chain can be skipped (the router already tunnels).
  MAC binding defeats a hostile network handing out your router's IP.
- **Bypass subnets** — a small allow-list firewall; each active tunnel's own
  subnet can be auto-added so in-VPN LAN keeps working.
- **Zero-leak, zero-fuss** — an event-driven root monitor re-syncs instantly
  on any link/route/address change, a boot-restore unit re-arms *before
  NetworkManager*, and an NM dispatcher hook keeps the ruleset current. No
  performance cost while disarmed; nothing runs in your session as root.

## Architecture (why it's split)

A GNOME extension is an unprivileged process — it *cannot* and *must not*
touch the firewall. So enforcement lives in a **root-owned backend**, and the
UI only calls it via `pkexec`:

| component | scope | what |
|---|---|---|
| `nova-killswitch-ctl` | root (`/usr/local/sbin`) | the kill switch: nftables, profiles, gateway trust |
| `nova-killswitch-monitor` + `.service` | root | event-driven re-sync (`ip monitor`) |
| `nova-killswitch-restore.service` | root | re-arm before the network at boot |
| `90-nova-killswitch` dispatcher | root | NM up/down/vpn hooks |
| `50-nova-killswitch.rules` | root | passwordless pkexec for local wheel users |
| GNOME extension | user | Quick Settings toggle, profile picker, status |
| `nova-killswitch-settings` | user | GTK4 app: profiles, gateways, subnets |

## Install (via nova-updater)

nova-killswitch is a **dual-scope** app: installing it sets up the root
backend (system scope) *and* the extension + settings app (user scope).

```bash
nova install nova-killswitch          # installs both the user and system parts
```

The **system** (root firewall) part needs nova's system scope set up once —
if you haven't already, run nova-updater's installer with `--with-system`:

```bash
# in the nova-updater checkout, one time:
./install.sh install --with-system
```

Then log out/in so GNOME loads the extension. Requires `nftables`,
`NetworkManager`, and (for WireGuard) `wireguard-tools` — all present on
Silverblue/Bluefin.

## Usage

- **Arm/disarm**: the "Kill Switch" tile in Quick Settings, pick a profile
  from its menu; or `pkexec nova-killswitch-ctl enable [profile]`.
- **Configure**: the **Nova Kill Switch** app (or the tile → Settings…):
  default profile, LAN policy, bypass subnets, trusted gateways (with an
  "add current gateway" button that captures IP+MAC), and a profile editor.
- **CLI**: `nova-killswitch-ctl {enable [profile]|disable|status|check}`.

### Config — `/etc/nova-killswitch/config`

See [config.sample](config.sample). Edited by the GTK app via pkexec; never
needs manual editing.

### Profiles — `/etc/nova-killswitch/profiles/<name>.profile`

One VPN layer per line, order = chain order. See
[profiles/example.profile.sample](profiles/example.profile.sample).

## Verifying it's leak-proof

```sh
pkexec nova-killswitch-ctl enable
curl -s ifconfig.me                 # your VPN IP
sudo ip link set <vpn-iface> down   # simulate a drop
curl -s --max-time 5 ifconfig.me    # must hang/timeout — NOT your real IP
pkexec nova-killswitch-ctl status
```

## Security notes

- Passwordless toggling is a polkit rule authorizing pkexec of exactly one
  root-owned program (`nova-killswitch-ctl`) for local active wheel users.
  Safe only because that file isn't user-writable — don't loosen it.
- Trusted-gateway MAC checking raises the bar against IP spoofing but a
  determined on-link attacker can still forge a MAC; combined with
  fail-closed defaults it's a solid daily-driver tradeoff, not a substitute
  for Tails/Whonix if your threat model demands that.
- Personal tool, not independently audited.

Derived from the author's `gnome-vpn-killswitch` (enforcement architecture)
and `kiwi-vpn-monitor` (gateway intelligence), unified and extended.
