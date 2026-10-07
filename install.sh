#!/usr/bin/env bash
# Install buds-notifier as a systemd user service running from this repository.
# Safe to re-run. Needs no sudo (see README for the one-time BlueZ setting).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/buds-notifier"

if ! /usr/bin/python3 -c 'import gi, dbus' 2>/dev/null; then
    echo "Missing Python bindings. Install them with:" >&2
    echo "  sudo apt install python3-gi python3-dbus" >&2
    exit 1
fi

mkdir -p "$UNIT_DIR" "$CONFIG_DIR"
sed "s|@REPO_DIR@|$REPO_DIR|" "$REPO_DIR/systemd/buds-notifier.service" > "$UNIT_DIR/buds-notifier.service"
echo "Installed $UNIT_DIR/buds-notifier.service (WorkingDirectory=$REPO_DIR)"

systemctl --user daemon-reload
systemctl --user enable buds-notifier.service

if [[ ! -e "$CONFIG_DIR/config.toml" ]]; then
    cp "$REPO_DIR/config.example.toml" "$CONFIG_DIR/config.toml"
    echo "Created $CONFIG_DIR/config.toml with example values."
    echo "Edit device_address and name_patterns, then start the service:"
    echo "  systemctl --user restart buds-notifier"
else
    echo "Kept existing $CONFIG_DIR/config.toml"
    systemctl --user restart buds-notifier.service
    echo "Service: $(systemctl --user is-active buds-notifier.service)"
fi

if ! busctl get-property org.bluez /org/bluez/hci0 org.bluez.AdvertisementMonitorManager1 \
        SupportedFeatures 2>/dev/null | grep -q controller-patterns; then
    cat <<'EOF'

Nearby popup is disabled: BlueZ advertisement monitors with hardware filtering are unavailable.
If your adapter supports it, enable once (in a normal terminal; Bluetooth devices reconnect):
  sudo cp /etc/bluetooth/main.conf /etc/bluetooth/main.conf.bak
  sudo sed -i 's/^#Experimental = false/Experimental = true/' /etc/bluetooth/main.conf
  sudo systemctl restart bluetooth
EOF
fi
