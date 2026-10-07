"""BlueZ advertisement monitor: hardware-filtered LE advertisement matching.

Exports an ObjectManager root with one org.bluez.AdvertisementMonitor1 object per name and
registers it with org.bluez.AdvertisementMonitorManager1 (needs Experimental = true).
"""

import logging
from collections.abc import Callable

import dbus
import dbus.service

log = logging.getLogger(__name__)

BLUEZ = "org.bluez"
MANAGER_IFACE = "org.bluez.AdvertisementMonitorManager1"
MONITOR_IFACE = "org.bluez.AdvertisementMonitor1"
PROPS_IFACE = "org.freedesktop.DBus.Properties"
OBJECT_MANAGER_IFACE = "org.freedesktop.DBus.ObjectManager"

APP_PATH = "/org/budsnotifier/advmon"

AD_TYPE_COMPLETE_NAME = 0x09


class _Monitor(dbus.service.Object):
    def __init__(self, bus, path, patterns, rssi, on_found, on_lost):
        super().__init__(bus, path)
        self.path = path
        self._patterns = patterns
        self._rssi = rssi
        self._on_found = on_found
        self._on_lost = on_lost

    def properties(self) -> dict:
        props = {
            "Type": dbus.String("or_patterns"),
            "Patterns": dbus.Array(
                [dbus.Struct((dbus.Byte(0), dbus.Byte(ad_type), dbus.Array(value, signature="y")))
                 for ad_type, value in self._patterns],
                signature="(yyay)",
            ),
        }
        props.update(self._rssi)
        return props

    @dbus.service.method(PROPS_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.properties() if interface == MONITOR_IFACE else {}

    @dbus.service.method(MONITOR_IFACE)
    def Release(self):
        log.warning("Advertisement monitor %s released by BlueZ", self.path)

    @dbus.service.method(MONITOR_IFACE)
    def Activate(self):
        log.info("Advertisement monitor %s active", self.path)

    @dbus.service.method(MONITOR_IFACE, in_signature="o")
    def DeviceFound(self, device):
        log.debug("DeviceFound %s", device)
        self._on_found(str(device))

    @dbus.service.method(MONITOR_IFACE, in_signature="o")
    def DeviceLost(self, device):
        log.debug("DeviceLost %s", device)
        self._on_lost(str(device))


class _App(dbus.service.Object):
    def __init__(self, bus, monitors: list[_Monitor]):
        super().__init__(bus, APP_PATH)
        self._monitors = monitors

    @dbus.service.method(OBJECT_MANAGER_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        return {dbus.ObjectPath(m.path): {MONITOR_IFACE: m.properties()} for m in self._monitors}


class AdvMonService:
    def __init__(self, bus: dbus.Bus, adapter: str, name_patterns: tuple[str, ...],
                 rssi_found: int, rssi_lost: int,
                 on_found: Callable[[str], None], on_lost: Callable[[str], None] = lambda _p: None):
        self._bus = bus
        self._adapter_path = f"/org/bluez/{adapter}"
        rssi = {
            "RSSIHighThreshold": dbus.Int16(rssi_found),
            "RSSIHighTimeout": dbus.UInt16(1),
            "RSSILowThreshold": dbus.Int16(rssi_lost),
            "RSSILowTimeout": dbus.UInt16(30),
        }
        # One monitor per name: the AX201 rejects monitors whose patterns total more than
        # ~one name (MGMT status 0x0d), e.g. two 22-byte patterns in one monitor.
        monitors = [
            _Monitor(bus, f"{APP_PATH}/monitor{i}", [(AD_TYPE_COMPLETE_NAME, name.encode())],
                     rssi, on_found, on_lost)
            for i, name in enumerate(name_patterns)
        ]
        self._app = _App(bus, monitors)

    def supports_hardware_filtering(self) -> bool:
        try:
            props = dbus.Interface(self._bus.get_object(BLUEZ, self._adapter_path), PROPS_IFACE)
            features = props.Get(MANAGER_IFACE, "SupportedFeatures")
        except dbus.DBusException as e:
            log.warning("AdvertisementMonitorManager1 unavailable: %s", e)
            return False
        return "controller-patterns" in [str(f) for f in features]

    def register(self) -> None:
        manager = dbus.Interface(self._bus.get_object(BLUEZ, self._adapter_path), MANAGER_IFACE)
        manager.RegisterMonitor(
            dbus.ObjectPath(APP_PATH),
            reply_handler=lambda: log.info("Advertisement monitor registered"),
            error_handler=lambda e: log.error("RegisterMonitor failed: %s", e),
        )
