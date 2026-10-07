# buds-notifier

GNOME desktop notifications for Samsung Galaxy Buds (built for the Buds3 Pro) on Linux:

- **Connected** popup with battery level ("Alice's Buds3 Pro connected — Battery: 79%")
- **Disconnected** popup
- **Low battery** warning (once below 15%, re-armed at 20% or on reconnect)
- **Nearby** popup with a **Connect** button (Swift-Pair-like) when the buds are advertising
  nearby but aren't connected to the laptop

Tested on Ubuntu with GNOME 50 (Wayland), BlueZ 5.85, PipeWire 1.6.2 / WirePlumber 0.5.13,
Intel AX201 Bluetooth.

## Requirements

- BlueZ, a desktop notification server (GNOME Shell), systemd user session
- System Python with `python3-gi` and `python3-dbus` (`sudo apt install python3-gi python3-dbus`).
  The service always runs `/usr/bin/python3`, since a `python3` earlier in `PATH` (pyenv, conda,
  `~/.local/bin`) may not have these packages.
- Headset **paired and trusted** with the laptop.
- **Nearby popup only:** BlueZ advertisement monitors with hardware filtering, i.e.
  `Experimental = true` in `/etc/bluetooth/main.conf` and an adapter reporting
  `controller-patterns` (check:
  `busctl get-property org.bluez /org/bluez/hci0 org.bluez.AdvertisementMonitorManager1 SupportedFeatures`).
  Without it, the nearby popup disables itself; it never falls back to continuous software scanning.

## Install

```bash
git clone https://github.com/<you>/buds-notifier.git ~/scripts/buds-notifier
cd ~/scripts/buds-notifier
./install.sh
```

`install.sh` (safe to re-run, no sudo) installs the systemd user unit pointing at the clone,
enables it at login, and creates `~/.config/buds-notifier/config.toml` from
`config.example.toml` if it doesn't exist. Then set your values (see [Configuration](#configuration))
and `systemctl --user restart buds-notifier`.

One-time BlueZ setting for the nearby popup (normal terminal; Bluetooth devices disconnect briefly):

```bash
sudo cp /etc/bluetooth/main.conf /etc/bluetooth/main.conf.bak
sudo sed -i 's/^#Experimental = false/Experimental = true/' /etc/bluetooth/main.conf
sudo systemctl restart bluetooth
```

## Everyday commands

```bash
systemctl --user status buds-notifier          # is it running?
journalctl --user -u buds-notifier -f          # live log
systemctl --user restart buds-notifier         # after editing config.toml
systemctl --user disable --now buds-notifier   # turn off
```

Foreground with verbose logging (stop the service first to avoid double popups):

```bash
systemctl --user stop buds-notifier
/usr/bin/python3 -m buds_notifier --debug      # from the repo directory
```

Tests: `/usr/bin/python3 -m unittest -v` (from the repo directory).

## Configuration

`~/.config/buds-notifier/config.toml` (template: `config.example.toml`). Unknown keys are
rejected, so typos show up in the log.

| Key | Default | Meaning |
|---|---|---|
| `device_address` | **required** | Public (classic) address of the paired buds, from `bluetoothctl devices Paired`. **Connect only ever targets this.** |
| `name_patterns` | **required** | Prefixes of the names your buds broadcast over LE, e.g. `["Alice's Buds3 Pro", "Galaxy Buds3 Pro (EEFF)"]` |
| `adapter` | `hci0` | Bluetooth adapter |
| `low_battery_percent` | `15` | Warn below this |
| `low_battery_rearm_percent` | `20` | Warn again only after reaching this (or reconnecting) |
| `nearby_cooldown_seconds` | `60` | Minimum time between nearby popups |
| `nearby_rssi_found` | `-85` | Signal (dBm) needed to count as nearby. Closer to 0 = must be nearer (e.g. `-70`) |
| `nearby_rssi_lost` | `-95` | Below this the buds count as gone |

Use names unique to **your** buds in `name_patterns`: your custom name and the LE Audio name
`Galaxy Buds3 Pro (XXXX)` (XXXX = last 4 hex digits of the address). Never the generic
`Buds3 Pro`, which every Buds3 Pro nearby broadcasts.

## Code layout

```
buds_notifier/
  __main__.py                     # wiring + GLib main loop
  config.py                       # loads config.toml
  services/
    bluez_service.py              # BlueZ (system bus): device state, battery, connect
    advmon_service.py             # BlueZ advertisement monitors (hardware LE filtering)
    notification_service.py       # org.freedesktop.Notifications (session bus), buttons
  watchers/
    connection_watcher.py         # connected / disconnected / low battery logic
    nearby_watcher.py             # nearby popup + Connect button logic
tests/                            # unittest, no D-Bus needed for watcher/config tests
systemd/buds-notifier.service     # unit template (install.sh fills in the repo path)
```

## How it works

### Why the buds show up 3–4 times in Bluetooth settings

The buds use classic Bluetooth and Bluetooth Low Energy (LE) at the same time:

| Entry (example) | Address | What it is |
|---|---|---|
| **Alice's Buds3 Pro** | public, fixed | The real, paired device: music (A2DP), calls (HFP), controls. *Connected/Disconnected* in Settings. |
| Alice's Buds3 Pro | random, rotating | LE Audio broadcast. *Not Set Up*. |
| Galaxy Buds3 Pro (EEFF) LE | random, rotating | LE Audio broadcast (EEFF = end of the real address) |
| Buds3 Pro | random, but stable for days | Samsung quick-pair / Find My beacon (the format Windows Swift Pair uses) |

Only the public, paired entry is usable. The others are harmless; `bluetoothctl remove <addr>`
deletes them, but they come back on the next scan.

### Connection popups
`bluez_service` subscribes to BlueZ `PropertiesChanged` (`Device1.Connected`,
`Battery1.Percentage`) and `InterfacesAdded/Removed` (Battery1 appears/disappears on
connect/disconnect) for the paired device only. The battery level often arrives a second after
"connected", so the popup first says "unknown" and is then updated in place.

### Nearby popup
- Uses BlueZ **advertisement monitors** (`org.bluez.AdvertisementMonitorManager1`).
- With `controller-patterns`, **the Bluetooth chip filters advertisements in hardware**: during
  passive listening only matching packets reach the host (verified with `btmon`: only the buds'
  packets came through, nothing from other nearby devices).
- One monitor per name, matching the advertised **complete local name**, then a software double
  check of the name. Generic `Buds3 Pro` and Samsung's manufacturer ID alone are deliberately not
  matched (strangers' buds, Galaxy Watches).
- No popup while the buds are connected to the laptop; connecting closes an open nearby popup.

### Connect button
Calls `Device1.ConnectProfile(A2DP sink UUID 0000110b-…)` on `device_address`, after checking the
device is `Paired` with `AddressType == public`. It does **not** use `Device1.Connect()` /
`bluetoothctl connect`: on this dual-mode device that picked the LE bearer and failed with
`le-connection-abort-by-local`. Verified result: `BREDR.Connected: yes`, `LE.Connected: no`,
profile `a2dp-sink` (AAC).

## Known limitations (measured, not guessed)

- **Nearby popup appears once per appearance, not on every case opening.** Captures with `btmon`
  showed:
  - While connected to a phone, the buds' LE Audio broadcast continues **with the case closed**,
    byte-for-byte identical to the case open. There is no lid-state signal in it.
  - With hardware filtering, BlueZ **never reported DeviceLost** (even with a 5 s timeout and the
    device silent for 70 s), so a new "found" (and popup) only happens for a new address or after a
    BlueZ/notifier restart.
  - The Samsung "Buds3 Pro" beacon broadcasts irregularly (present in some captures, absent for
    35 s after opening the case in another) and its data looks encrypted, so it isn't usable as a
    lid-open signal either.
- **Other apps' scans change what you see.** Apps such as RQuickShare (Quick Share) run normal
  Bluetooth scans continuously; while they do, everything nearby is reported. Not needed by this
  notifier; just don't mistake their scans for its behaviour when debugging.
- **AX201 rejects large monitors.** `Failed to Add Adv Patterns Monitor with status 0x0d` in
  `journalctl -u bluetooth` when one monitor holds more than about one name (22 B ok, 44 B rejected);
  hence one monitor per name.
- **No LE Audio on the AX201.** `sudo btmgmt --index 0 info` lists no `cis-central` /
  `iso-broadcaster`: LC3 over LE, Auracast and the "(XXXX) LE" entry are unusable. Classic audio
  still works well: AAC for music, LC3-SWB over HFP for calls.
- **Low-battery warning can repeat.** BlueZ's single battery value jumps (e.g. 14% → 20%+ → 1%),
  which can re-arm the warning several times per session.

## Tips

- Classic Bluetooth can't do hi-fi music **and** the mic at once: when an app opens the buds' mic,
  WirePlumber switches to headset mode (`bluetooth.autoswitch-to-headset-profile = true`).
  Making another mic the default keeps the buds in AAC:
  `pactl list sources short` then `pactl set-default-source <your-mic-source>`.
- Buds controls (ANC, EQ, touch, firmware): **Galaxy Buds Client** Flatpak
  (`flatpak run me.timschneeberger.GalaxyBudsClient`). It uses the classic serial (SPP) channel
  and doesn't conflict with this notifier.
- Debugging BLE: `sudo btmon > capture.txt` records everything the adapter sends and receives.
  Captures contain nearby devices' broadcasts; don't commit them (`btmon*.txt` is gitignored).

## Uninstall / rollback

```bash
systemctl --user disable --now buds-notifier
rm ~/.config/systemd/user/buds-notifier.service
rm -r ~/.config/buds-notifier
systemctl --user daemon-reload

# Undo the BlueZ change (normal terminal; Bluetooth devices disconnect briefly):
sudo mv /etc/bluetooth/main.conf.bak /etc/bluetooth/main.conf && sudo systemctl restart bluetooth
```

Undoing only the BlueZ change is safe: the nearby popup turns itself off and the connection
popups keep working.

## License

MIT, see [LICENSE](LICENSE).
