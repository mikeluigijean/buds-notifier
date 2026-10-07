# Buds Notifier

A GNOME Shell extension that shows **Windows-style popup cards** for your Bluetooth earbuds and
headsets: automatically, for every paired headset, with no configuration.

- **Connected**, with battery: **left / right / case** with [BudsLink](https://flathub.org/apps/io.github.maniacx.BudsLink),
  otherwise the single level BlueZ reports
- **Disconnected**
- **Low battery** (lowest earbud below 15%, warned again only after charging back to 20%)
- **Nearby + Connect** (Swift-Pair-like): a paired headset is close but not connected; one click
  connects it over classic Bluetooth

Cards slide in at the top-right (below the top bar), auto-hide (hover keeps them), and fall back
to the regular notification list under Do Not Disturb or on the lock screen.

Tested on Ubuntu with GNOME Shell 50.1 (Wayland), BlueZ 5.85, Intel AX201, Galaxy Buds3 Pro.

## Install

**From extensions.gnome.org** (once published): install "Buds Notifier", done.

**From this repository:**

```bash
git clone https://github.com/mikeluigijean/buds-notifier.git ~/scripts/buds-notifier
~/scripts/buds-notifier/install.sh
```

Then log out and back in once (Wayland only discovers new extensions at login). A first card
confirms which headsets are being watched.

### Optional extras (shown in the extension's preferences)

| Extra | What it adds | How |
|---|---|---|
| BudsLink (Flathub) | Left / right / case battery for many brands (Galaxy Buds, AirPods, Pixel Buds, Sony, Bose, Nothing, …) | `flatpak install flathub io.github.maniacx.BudsLink`, or the button in preferences |
| BlueZ experimental features | The **nearby** card (needs an adapter with hardware advertisement filtering) | One-time, in a terminal (devices reconnect briefly): see below |

```bash
sudo cp /etc/bluetooth/main.conf /etc/bluetooth/main.conf.bak
sudo sed -i 's/^#Experimental = false/Experimental = true/' /etc/bluetooth/main.conf
sudo systemctl restart bluetooth
```

The extension never falls back to continuous Bluetooth scanning: without hardware filtering
the nearby card stays off.

## Preferences

`gnome-extensions prefs buds-notifier@mikeluigijean.github.io` (or the Extensions app):

- **Status:** Bluetooth, popup cards (Do Not Disturb), BudsLink, nearby card readiness (with
  the exact setup command when needed)
- **Devices:** every paired audio device with an on/off switch. Earbuds/headsets/headphones
  are on by default; speakers and other audio devices can be switched on
- **Notifications:** low-battery thresholds, nearby card on/off, cooldown and signal threshold,
  BudsLink on/off
- **Test:** show a sample card

## How it works

```
gnome-extension/buds-notifier@mikeluigijean.github.io/
  extension.js          # wiring: BlueZ events -> watchers -> cards; settings; D-Bus test API
  card.js               # the card widget (St)
  prefs.js              # preferences window (Adw)
  lib/bluez.js          # BlueZ client (system bus): paired audio devices, connect, battery
  lib/advmon.js         # BlueZ advertisement monitors (hardware-filtered nearby detection)
  lib/budslink.js       # BudsLink client (session bus): per-earbud + case battery
  lib/popups.js         # cards top-right, fallback to the notification list
  lib/connectionWatcher.js, lib/nearbyWatcher.js   # event logic (pure JS)
  lib/battery.js, lib/patterns.js                  # data helpers (pure JS)
  schemas/              # GSettings
tests-js/run.js         # unit tests for the pure-JS modules
```

- **Which devices:** paired BlueZ devices whose icon is `audio-headset`/`audio-headphones`,
  plus any audio device switched on in preferences. Newly paired headsets are picked up live.
- **Connection & battery:** BlueZ `Device1.Connected`, `Battery1.Percentage`. BlueZ reports the
  battery a few seconds after connecting (~4.6 s measured), so the connected card waits up to
  6 s for it; details arriving later update the card in place.
- **Left / right / case:** BudsLink's device paths mirror BlueZ's
  (`/org/bluez/hci0/dev_X` → `/io/github/maniacx/BudsLink/Devices/hci0/dev_X`); `Device.State`
  has `battery1..3Level/Status`, and `Config`'s `battery<n>Icon` says which slot is left, right or
  case. BudsLink is held (`HoldService` + 120 s heartbeat) only while a watched headset is connected.
- **Nearby:** one advertisement monitor per name (the device's name and alias, 6–29 bytes),
  matched by the chip on the advertised complete local name, then double-checked in software.
- **Connect:** `Device1.ConnectProfile(A2DP sink)`, never `Device1.Connect()`: on dual-mode
  earbuds that can pick the LE bearer and fail (`le-connection-abort-by-local`). An error that
  arrives while the headset connected anyway (it often reconnects by itself) is ignored.

### Session-bus API (preferences and testing)

`io.github.mikeluigijean.BudsNotifier.Shell`, `/io/github/mikeluigijean/BudsNotifier/Shell`,
interface `…Shell1`: `Show(s card_json) → u`, `Close(u)`, `Activate(u id, s action) → b`
(same as clicking a button), `Status() → s` (JSON: devices, nearby, BudsLink, recent cards),
signals `ActionInvoked(u, s)` and `Closed(u, s)`.

```bash
gdbus call --session --dest io.github.mikeluigijean.BudsNotifier.Shell \
  --object-path /io/github/mikeluigijean/BudsNotifier/Shell \
  --method io.github.mikeluigijean.BudsNotifier.Shell1.Status
```

## Development

```bash
gjs -m tests-js/run.js                       # unit tests
./install.sh                                 # link into ~/.local/share/gnome-shell/extensions
gnome-extensions pack gnome-extension/buds-notifier@mikeluigijean.github.io \
  --extra-source=card.js --extra-source=lib --extra-source=icons --force   # zip for EGO
```

Code changes need a log out/in on Wayland. To test without touching your session, run an
isolated headless shell (own session bus, temporary config; real BlueZ):

```bash
T=$(mktemp -d); mkdir -p $T/data/gnome-shell/extensions $T/config $T/runtime; chmod 700 $T/runtime
ln -s "$PWD/gnome-extension/buds-notifier@mikeluigijean.github.io" $T/data/gnome-shell/extensions/
env XDG_DATA_HOME=$T/data XDG_CONFIG_HOME=$T/config XDG_RUNTIME_DIR=$T/runtime GSETTINGS_BACKEND=memory \
  dbus-run-session -- bash -c 'gnome-shell --headless --wayland --no-x11 --virtual-monitor 1920x1080 & sleep 5;
    gnome-extensions enable buds-notifier@mikeluigijean.github.io; sleep 2;
    gdbus call --session --dest io.github.mikeluigijean.BudsNotifier.Shell \
      --object-path /io/github/mikeluigijean/BudsNotifier/Shell \
      --method io.github.mikeluigijean.BudsNotifier.Shell1.Status; kill %1'
```

## Known limitations (measured, not guessed)

- **Nearby detection is intermittent.** With hardware filtering only (no scan running), the
  Galaxy Buds3 Pro were sometimes reported continuously (every ~0.2 s, verified with `btmon`)
  and sometimes not at all for minutes; whenever something runs a normal scan (Bluetooth
  settings, RQuickShare, `bluetoothctl scan`) they're found immediately. Cause not identified.
- **Nearby card once per appearance, not per case opening.** While connected to a phone the buds
  keep broadcasting identical data with the case closed or open, and with hardware filtering
  BlueZ never sent `DeviceLost`.
- **Nearby depends on the brand broadcasting its name.** Verified on Galaxy Buds3 Pro; devices
  that don't put their name in LE advertisements (likely AirPods) won't trigger it.
- **AX201 limits:** a monitor holding more than about one name is rejected (`status 0x0d`), hence
  one monitor per name; at most 16 patterns. No LE Audio on this chip (`btmgmt info` lists no
  `cis-central`).
- **BudsLink and Galaxy Buds Client** share the earbuds' single control channel; running both may
  make one fail to connect (not tested).
- Declares GNOME Shell 50 only (EGO rules forbid claiming untested versions).

## Uninstall

```bash
gnome-extensions disable buds-notifier@mikeluigijean.github.io
rm ~/.local/share/gnome-shell/extensions/buds-notifier@mikeluigijean.github.io
# Optional, undo the BlueZ change:
sudo mv /etc/bluetooth/main.conf.bak /etc/bluetooth/main.conf && sudo systemctl restart bluetooth
```

## License

MIT, see [LICENSE](LICENSE).
