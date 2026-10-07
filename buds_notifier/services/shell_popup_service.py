"""Client for the "Buds Notifier Popups" GNOME Shell extension (session bus)."""

import json
import logging
from collections.abc import Callable

import dbus

log = logging.getLogger(__name__)

SHELL_NAME = "io.github.mikeluigijean.BudsNotifier.Shell"
SHELL_PATH = "/io/github/mikeluigijean/BudsNotifier/Shell"
SHELL_IFACE = "io.github.mikeluigijean.BudsNotifier.Shell1"


class ShellPopupService:
    def __init__(self, bus: dbus.Bus,
                 on_action: Callable[[int, str], None],
                 on_closed: Callable[[int, str], None]):
        self._bus = bus
        bus.add_signal_receiver(lambda i, a: on_action(int(i), str(a)),
                                "ActionInvoked", SHELL_IFACE, path=SHELL_PATH)
        bus.add_signal_receiver(lambda i, r: on_closed(int(i), str(r)),
                                "Closed", SHELL_IFACE, path=SHELL_PATH)

    def available(self) -> bool:
        try:
            return bool(self._bus.name_has_owner(SHELL_NAME))
        except dbus.DBusException:
            return False

    def show(self, card: dict) -> int:
        """Card id, or 0 if the extension can't show it now (absent, Do Not Disturb, locked)."""
        if not self.available():
            return 0
        try:
            iface = dbus.Interface(self._bus.get_object(SHELL_NAME, SHELL_PATH), SHELL_IFACE)
            return int(iface.Show(json.dumps(card)))
        except dbus.DBusException as e:
            log.warning("Popup extension call failed: %s", e)
            return 0

    def close(self, card_id: int) -> None:
        try:
            iface = dbus.Interface(self._bus.get_object(SHELL_NAME, SHELL_PATH), SHELL_IFACE)
            iface.Close(dbus.UInt32(card_id))
        except dbus.DBusException as e:
            log.debug("Could not close popup %d: %s", card_id, e)
