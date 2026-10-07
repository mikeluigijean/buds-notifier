"""Entry point: python3 -m buds_notifier [--debug]"""

import argparse
import logging
import sys

import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

from .config import load_config
from .services.advmon_service import AdvMonService
from .services.bluez_service import BluezService
from .services.notification_service import NotificationService
from .watchers.connection_watcher import ConnectionWatcher
from .watchers.nearby_watcher import NearbyWatcher

log = logging.getLogger("buds_notifier")


def main() -> int:
    parser = argparse.ArgumentParser(prog="buds_notifier")
    parser.add_argument("--debug", action="store_true", help="verbose logging")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    try:
        config = load_config()
    except ValueError as e:
        log.error("Invalid configuration: %s", e)
        return 1
    address = config.device_address
    DBusGMainLoop(set_as_default=True)
    system_bus = dbus.SystemBus()
    bluez = BluezService(system_bus, config.adapter)
    notifier = NotificationService(dbus.SessionBus())

    props = bluez.get_device_properties(address)
    if not props.get("Paired"):
        log.error("%s is not a paired device on %s", address, config.adapter)
        return 1
    display_name = str(props.get("Alias") or address)

    connection = ConnectionWatcher(display_name, notifier,
                                   config.low_battery_percent, config.low_battery_rearm_percent)
    nearby = NearbyWatcher(
        display_name,
        config.name_patterns,
        config.nearby_cooldown_seconds,
        notifier,
        close_notification=notifier.close,
        get_name_at=bluez.get_name_at,
        is_connected=lambda: bool(bluez.get_device_properties(address).get("Connected")),
        connect=lambda on_done: bluez.connect_classic(address, on_done),
    )
    advmon = AdvMonService(system_bus, config.adapter, config.name_patterns,
                           config.nearby_rssi_found, config.nearby_rssi_lost,
                           on_found=nearby.on_device_found)

    def on_connected_changed(connected: bool) -> None:
        connection.on_connected_changed(connected)
        nearby.on_connected_changed(connected)

    def start_nearby() -> None:
        # Only with hardware (controller) filtering; never fall back to continuous software scanning.
        if advmon.supports_hardware_filtering():
            advmon.register()
        else:
            log.warning("No controller-patterns support: nearby popup disabled")

    def on_bluez_running(running: bool) -> None:
        if not running:
            log.info("bluetoothd stopped")
            connection.sync(False, None)
            return
        connected = bool(bluez.get_device_properties(address).get("Connected"))
        battery = bluez.get_battery_percentage(address)
        log.info("State: connected=%s battery=%s", connected, battery)
        connection.sync(connected, battery)
        start_nearby()

    bluez.watch_device(address, on_connected_changed, connection.on_battery_changed)
    # Also fires once immediately with the current owner, which does the initial sync.
    bluez.watch_service(on_bluez_running)

    log.info("Watching %s (%s)", display_name, address)
    GLib.MainLoop().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
