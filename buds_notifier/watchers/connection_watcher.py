"""Turn headset connection and battery changes into popups."""

import time
from collections.abc import Callable

from ..battery import Battery
from ..presenters import NO_HANDLE, Presenter

# Battery details arriving this soon after connecting update the "connected" popup in place.
UPDATE_WINDOW_SECONDS = 15


class ConnectionWatcher:
    def __init__(self, display_name: str, presenter: Presenter,
                 low_battery_percent: int, low_battery_rearm_percent: int,
                 clock: Callable[[], float] = time.monotonic):
        self._name = display_name
        self._presenter = presenter
        self._low = low_battery_percent
        self._rearm = low_battery_rearm_percent
        self._clock = clock

        self._connected = False
        self._bluez_percent: int | None = None   # BlueZ Battery1: one value (the lower bud)
        self._budslink: Battery | None = None    # BudsLink: left / right / case
        self._low_warned = False
        self._handle = NO_HANDLE
        self._connected_at = 0.0

    @property
    def battery(self) -> Battery | None:
        if self._budslink and self._budslink.has_buds:
            return self._budslink
        if self._bluez_percent is not None:
            return Battery(single=self._bluez_percent)
        return None

    def sync(self, connected: bool, bluez_percent: int | None,
             budslink: Battery | None = None) -> None:
        """Adopt the current state silently (startup, bluetoothd restart)."""
        self._connected = connected
        self._bluez_percent = bluez_percent if connected else None
        self._budslink = budslink if connected else None
        self._handle = NO_HANDLE
        self._low_warned = False
        if connected:
            self._check_low_battery()

    def on_connected_changed(self, connected: bool) -> None:
        if connected == self._connected:
            return
        self._connected = connected

        if connected:
            self._low_warned = False
            self._connected_at = self._clock()
            self._handle = self._presenter.connected(self._name, self.battery)
            self._check_low_battery()
        else:
            self._bluez_percent = None
            self._budslink = None
            self._handle = NO_HANDLE
            self._presenter.disconnected(self._name)

    def on_bluez_battery(self, percentage: int | None) -> None:
        self._bluez_percent = percentage
        self._battery_changed()

    def on_budslink_battery(self, battery: Battery | None) -> None:
        self._budslink = battery
        self._battery_changed()

    def _battery_changed(self) -> None:
        if not self._connected:
            return
        if self._handle[1] and self._clock() - self._connected_at <= UPDATE_WINDOW_SECONDS:
            self._handle = self._presenter.connected(self._name, self.battery, replaces=self._handle)
        self._check_low_battery()

    def _check_low_battery(self) -> None:
        battery = self.battery
        level = battery.lowest_bud() if battery else None
        if level is None:
            return
        if level >= self._rearm:
            self._low_warned = False
        elif level < self._low and not self._low_warned:
            self._low_warned = True
            self._presenter.low_battery(self._name, battery)
