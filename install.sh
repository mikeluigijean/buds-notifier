#!/usr/bin/env bash
# Install the Buds Notifier GNOME Shell extension from this repository (development, or
# installing without extensions.gnome.org). Safe to re-run; needs no sudo.
set -euo pipefail

UUID="buds-notifier@mikeluigijean.github.io"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_DIR/gnome-extension/$UUID"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

glib-compile-schemas "$SRC/schemas"

mkdir -p "$EXT_DIR"
if [[ -L "$EXT_DIR/$UUID" || ! -e "$EXT_DIR/$UUID" ]]; then
    ln -sfn "$SRC" "$EXT_DIR/$UUID"
    echo "Linked $EXT_DIR/$UUID -> $SRC"
else
    echo "Not linking: $EXT_DIR/$UUID exists and is not a symlink (installed from extensions.gnome.org?)" >&2
    exit 1
fi

# Retire the Python service used by versions before the all-in-extension rewrite.
if systemctl --user cat buds-notifier.service >/dev/null 2>&1; then
    systemctl --user disable --now buds-notifier.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/buds-notifier.service"
    systemctl --user daemon-reload
    echo "Removed the old buds-notifier background service (~/.config/buds-notifier/ is no longer used)."
fi

# Enable it. A newly installed extension is only discovered at login on Wayland, so if the
# running shell doesn't know it yet, add it to the enabled list for the next login.
if gnome-extensions info "$UUID" 2>/dev/null | grep -q 'State: ACTIVE'; then
    echo "Extension is active. Log out and back in to load code changes."
elif gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Extension enabled."
else
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" != *"'$UUID'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['$UUID']"
        else
            gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
        fi
    fi
    echo "Log out and back in once: the extension will then be active."
fi
echo "Settings and status: gnome-extensions prefs $UUID"
