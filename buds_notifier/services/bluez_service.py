"""BlueZ client on the system bus: device state, battery, connect."""

import logging
from collections.abc import Callable

import dbus

log = logging.getLogger(__name__)

BLUEZ = "org.bluez"
DEVICE_IFACE = "org.bluez.Device1"
BATTERY_IFACE = "org.bluez.Battery1"
PROPS_IFACE = "org.freedesktop.DBus.Properties"
OBJECT_MANAGER_IFACE = "org.freedesktop.DBus.ObjectManager"
A2DP_SINK_UUID = "0000110b-0000-1000-8000-00805f9b34fb"


def device_path(address: str, adapter: str = "hci0") -> str:
    return f"/org/bluez/{adapter}/dev_{address.upper().replace(':', '_')}"


class BluezService:
    def __init__(self, bus: dbus.Bus, adapter: str = "hci0"):
        self._bus = bus
        self._adapter = adapter

    def _props(self, path: str) -> dbus.Interface:
        return dbus.Interface(self._bus.get_object(BLUEZ, path), PROPS_IFACE)

    def get_device_properties(self, address: str) -> dict:
        """Device1 properties, or {} if BlueZ doesn't know the device (or isn't running)."""
        try:
            props = self._props(device_path(address, self._adapter)).GetAll(DEVICE_IFACE)
        except dbus.DBusException as e:
            log.debug("Device1 properties unavailable for %s: %s", address, e)
            return {}
        return {str(k): v for k, v in props.items()}

    def get_name_at(self, path: str) -> str | None:
        """Advertised name of any BlueZ device object (e.g. a random-address LE entry)."""
        try:
            return str(self._props(path).Get(DEVICE_IFACE, "Name"))
        except dbus.DBusException:
            return None

    def connect_classic(self, address: str, on_done: Callable[[str | None], None]) -> None:
        """Connect the paired device over classic Bluetooth (BR/EDR). on_done(error or None).

        Device1.Connect() on this dual-mode headset may pick the LE bearer and fail
        (le-connection-abort-by-local), so connect the A2DP sink profile explicitly.
        """
        props = self.get_device_properties(address)
        if not props.get("Paired") or props.get("AddressType") != "public":
            on_done(f"{address} is not a paired device with a public address")
            return

        device = dbus.Interface(
            self._bus.get_object(BLUEZ, device_path(address, self._adapter)), DEVICE_IFACE
        )
        log.info("ConnectProfile(A2DP sink) on %s", device_path(address, self._adapter))
        device.ConnectProfile(
            A2DP_SINK_UUID,
            reply_handler=lambda: on_done(None),
            error_handler=lambda e: on_done(e.get_dbus_message() or e.get_dbus_name()),
            timeout=30,
        )

    def get_battery_percentage(self, address: str) -> int | None:
        try:
            pct = self._props(device_path(address, self._adapter)).Get(BATTERY_IFACE, "Percentage")
        except dbus.DBusException:
            return None
        return int(pct)

    def watch_device(
        self,
        address: str,
        on_connected_changed: Callable[[bool], None],
        on_battery_changed: Callable[[int | None], None],
    ) -> None:
        path = device_path(address, self._adapter)

        def on_properties_changed(interface, changed, _invalidated):
            if interface == DEVICE_IFACE and "Connected" in changed:
                on_connected_changed(bool(changed["Connected"]))
            elif interface == BATTERY_IFACE and "Percentage" in changed:
                on_battery_changed(int(changed["Percentage"]))

        # Battery1 is added/removed as a whole interface when the headset connects/disconnects.
        def on_interfaces_added(object_path, interfaces):
            if object_path == path and BATTERY_IFACE in interfaces:
                pct = interfaces[BATTERY_IFACE].get("Percentage")
                on_battery_changed(None if pct is None else int(pct))

        def on_interfaces_removed(object_path, interfaces):
            if object_path == path and BATTERY_IFACE in interfaces:
                on_battery_changed(None)

        self._bus.add_signal_receiver(
            on_properties_changed, "PropertiesChanged", PROPS_IFACE, BLUEZ, path
        )
        self._bus.add_signal_receiver(
            on_interfaces_added, "InterfacesAdded", OBJECT_MANAGER_IFACE, BLUEZ, "/"
        )
        self._bus.add_signal_receiver(
            on_interfaces_removed, "InterfacesRemoved", OBJECT_MANAGER_IFACE, BLUEZ, "/"
        )

    def watch_service(self, on_running_changed: Callable[[bool], None]) -> None:
        """Called with True/False when bluetoothd appears/disappears on the bus."""
        self._bus.watch_name_owner(BLUEZ, lambda owner: on_running_changed(bool(owner)))
