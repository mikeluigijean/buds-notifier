"""Entry point: python3 -m buds_notifier [--debug]"""

import argparse
import logging
import signal
import sys

import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

try:  # GLib >= 2.80
    from gi.repository import GLibUnix
    signal_add = GLibUnix.signal_add
except ImportError:
    signal_add = GLib.unix_signal_add

from .config import load_config
from .presenters.notification_presenter import NotificationPresenter
from .presenters.shell_presenter import ShellPresenter
from .services.advmon_service import AdvMonService
from .services.bluez_service import BluezService, device_path
from .services.budslink_service import BudsLinkService
from .services.notification_service import NotificationService
from .services.shell_popup_service import ShellPopupService
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
    session_bus = dbus.SessionBus()
    bluez = BluezService(system_bus, config.adapter)

    # Custom popups via the shell extension; standard notifications when it can't show them.
    popups = ShellPopupService(session_bus,
                               on_action=lambda i, a: presenter.on_action(i, a),
                               on_closed=lambda i, r: presenter.on_closed(i, r))
    presenter = ShellPresenter(popups, NotificationPresenter(NotificationService(session_bus)))

    props = bluez.get_device_properties(address)
    if not props.get("Paired"):
        log.error("%s is not a paired device on %s", address, config.adapter)
        return 1
    display_name = str(props.get("Alias") or address)

    connection = ConnectionWatcher(display_name, presenter,
                                   config.low_battery_percent, config.low_battery_rearm_percent)
    budslink = BudsLinkService(session_bus, device_path(address, config.adapter),
                               connection.on_budslink_battery)
    nearby = NearbyWatcher(
        display_name,
        config.name_patterns,
        config.nearby_cooldown_seconds,
        presenter,
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
        # Left/right/case battery: only keep BudsLink busy while the buds are connected.
        if connected:
            budslink.hold()
            connection.on_budslink_battery(budslink.read_battery())
        else:
            budslink.release()

    def start_nearby() -> None:
        # Only with hardware (controller) filtering; never fall back to continuous software scanning.
        if advmon.supports_hardware_filtering():
            advmon.register()
        else:
            log.warning("No controller-patterns support: nearby popup disabled")

    def on_bluez_running(running: bool) -> None:
        if not running:
            log.info("bluetoothd stopped")
            budslink.release()
            connection.sync(False, None)
            return
        connected = bool(bluez.get_device_properties(address).get("Connected"))
        if connected:
            budslink.hold()
        connection.sync(connected, bluez.get_battery_percentage(address),
                        budslink.read_battery() if connected else None)
        log.info("State: connected=%s battery=%s", connected,
                 connection.battery.text() if connection.battery else None)
        start_nearby()

    bluez.watch_device(address, on_connected_changed, connection.on_bluez_battery)
    # Also fires once immediately with the current owner, which does the initial sync.
    bluez.watch_service(on_bluez_running)

    loop = GLib.MainLoop()

    def on_terminate() -> bool:
        budslink.release()
        loop.quit()
        return GLib.SOURCE_REMOVE

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal_add(GLib.PRIORITY_DEFAULT, signum, on_terminate)

    log.info("Watching %s (%s)", display_name, address)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
