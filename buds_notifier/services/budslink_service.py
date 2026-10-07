"""Client for BudsLink (io.github.maniacx.BudsLink, session bus): per-bud and case battery.

BudsLink talks to the buds over their control channel and only does so while at least
one client holds it (HoldService + heartbeat), so we hold it only while the buds are
connected. Its device paths mirror BlueZ's: /org/bluez/hci0/dev_X ->
/io/github/maniacx/BudsLink/Devices/hci0/dev_X.
"""

import logging
from collections.abc import Callable

import dbus
from gi.repository import GLib

from ..battery import Battery, parse_budslink_state

log = logging.getLogger(__name__)

BUDSLINK = "io.github.maniacx.BudsLink"
MANAGER_PATH = "/io/github/maniacx/BudsLink"
MANAGER_IFACE = "io.github.maniacx.BudsLink.DeviceManager"
DEVICE_IFACE = "io.github.maniacx.BudsLink.Device"
PROPS_IFACE = "org.freedesktop.DBus.Properties"
CLIENT_ID = "buds-notifier"
HEARTBEAT_SECONDS = 120


def budslink_path(bluez_device_path: str) -> str:
    return MANAGER_PATH + "/Devices/" + bluez_device_path.removeprefix("/org/bluez/")


class BudsLinkService:
    def __init__(self, bus: dbus.Bus, bluez_device_path: str,
                 on_battery_changed: Callable[[Battery | None], None]):
        self._bus = bus
        self._path = budslink_path(bluez_device_path)
        self._on_battery_changed = on_battery_changed
        self._heartbeat_id = 0

        def on_properties_changed(interface, changed, _invalidated):
            if interface == DEVICE_IFACE and "State" in changed:
                self._on_battery_changed(parse_budslink_state(str(changed["State"])))

        def on_device_added(path):
            if str(path) == self._path:
                self._on_battery_changed(self.read_battery())

        bus.add_signal_receiver(on_properties_changed, "PropertiesChanged", PROPS_IFACE,
                                BUDSLINK, self._path)
        bus.add_signal_receiver(on_device_added, "DeviceAdded", MANAGER_IFACE,
                                BUDSLINK, MANAGER_PATH)

    def hold(self) -> None:
        """Ask BudsLink to (stay) connected to the buds; D-Bus activates it if needed."""
        self._call_manager("HoldService")
        if not self._heartbeat_id:
            self._heartbeat_id = GLib.timeout_add_seconds(HEARTBEAT_SECONDS, self._heartbeat)

    def release(self) -> None:
        if self._heartbeat_id:
            GLib.source_remove(self._heartbeat_id)
            self._heartbeat_id = 0
            self._call_manager("ReleaseService")

    def read_battery(self) -> Battery | None:
        try:
            props = dbus.Interface(self._bus.get_object(BUDSLINK, self._path), PROPS_IFACE)
            return parse_budslink_state(str(props.Get(DEVICE_IFACE, "State")))
        except dbus.DBusException as e:
            log.debug("BudsLink state unavailable: %s", e)
            return None

    def _heartbeat(self) -> bool:
        self._call_manager("HoldService")
        return GLib.SOURCE_CONTINUE

    def _call_manager(self, method: str) -> None:
        try:
            manager = dbus.Interface(self._bus.get_object(BUDSLINK, MANAGER_PATH), MANAGER_IFACE)
            getattr(manager, method)(
                CLIENT_ID,
                reply_handler=lambda: None,
                error_handler=lambda e: log.info("BudsLink %s failed: %s", method, e),
            )
        except dbus.DBusException as e:
            log.info("BudsLink unavailable (%s): %s", method, e)
