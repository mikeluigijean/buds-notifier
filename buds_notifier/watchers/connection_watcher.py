"""Turn headset connection and battery changes into notifications."""

from typing import Protocol

from ..services.notification_service import URGENCY_CRITICAL


class Notifier(Protocol):
    def notify(self, summary: str, body: str = "", icon: str = "audio-headset",
               replaces_id: int = 0, actions=None, urgency: int = 1) -> int: ...


class ConnectionWatcher:
    def __init__(self, display_name: str, notifier: Notifier,
                 low_battery_percent: int, low_battery_rearm_percent: int):
        self._name = display_name
        self._notifier = notifier
        self._low = low_battery_percent
        self._rearm = low_battery_rearm_percent

        self._connected = False
        self._battery: int | None = None
        self._low_warned = False
        # Id of the "connected" notification while it still lacks a battery level.
        self._pending_battery_id = 0

    def sync(self, connected: bool, battery: int | None) -> None:
        """Adopt the current state silently (startup, bluetoothd restart)."""
        self._connected = connected
        self._battery = battery if connected else None
        self._pending_battery_id = 0
        self._low_warned = False
        if connected:
            self._check_low_battery()

    def on_connected_changed(self, connected: bool) -> None:
        if connected == self._connected:
            return
        self._connected = connected

        if connected:
            self._low_warned = False
            notification_id = self._notifier.notify(f"{self._name} connected", self._battery_text())
            self._pending_battery_id = notification_id if self._battery is None else 0
            self._check_low_battery()
        else:
            self._battery = None
            self._pending_battery_id = 0
            self._notifier.notify(f"{self._name} disconnected")

    def on_battery_changed(self, percentage: int | None) -> None:
        self._battery = percentage
        if percentage is None or not self._connected:
            return

        if self._pending_battery_id:
            self._notifier.notify(f"{self._name} connected", self._battery_text(),
                                  replaces_id=self._pending_battery_id)
            self._pending_battery_id = 0
        self._check_low_battery()

    def _battery_text(self) -> str:
        return "Battery: unknown" if self._battery is None else f"Battery: {self._battery}%"

    def _check_low_battery(self) -> None:
        if self._battery is None:
            return
        if self._battery >= self._rearm:
            self._low_warned = False
        elif self._battery < self._low and not self._low_warned:
            self._low_warned = True
            self._notifier.notify(f"{self._name} battery low", f"Battery: {self._battery}%",
                                  icon="battery-caution", urgency=URGENCY_CRITICAL)
