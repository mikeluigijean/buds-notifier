"""Standard desktop notifications (org.freedesktop.Notifications)."""

from collections.abc import Callable

from ..battery import Battery
from ..services.notification_service import URGENCY_CRITICAL, NotificationService
from . import NO_HANDLE, Handle

BACKEND = "notification"


def _id(handle: Handle) -> int:
    return handle[1] if handle[0] == BACKEND else 0


class NotificationPresenter:
    def __init__(self, notifications: NotificationService):
        self._notifications = notifications

    def _show(self, notification_id: int) -> Handle:
        return (BACKEND, notification_id) if notification_id else NO_HANDLE

    def connected(self, name: str, battery: Battery | None,
                  replaces: Handle = NO_HANDLE) -> Handle:
        body = f"Battery: {battery.text() if battery else 'unknown'}"
        return self._show(self._notifications.notify(
            f"{name} connected", body, replaces_id=_id(replaces)))

    def disconnected(self, name: str) -> Handle:
        return self._show(self._notifications.notify(f"{name} disconnected"))

    def low_battery(self, name: str, battery: Battery) -> Handle:
        return self._show(self._notifications.notify(
            f"{name} battery low", f"Battery: {battery.text()}",
            icon="battery-caution", urgency=URGENCY_CRITICAL))

    def nearby(self, name: str, on_connect: Callable[[], None],
               replaces: Handle = NO_HANDLE) -> Handle:
        return self._show(self._notifications.notify(
            f"{name} nearby", "Not connected to this laptop.", replaces_id=_id(replaces),
            actions={"connect": ("Connect", on_connect)}))

    def connect_failed(self, name: str, error: str, replaces: Handle = NO_HANDLE) -> Handle:
        return self._show(self._notifications.notify(
            f"Couldn't connect {name}", error, icon="dialog-warning", replaces_id=_id(replaces)))

    def close(self, handle: Handle) -> None:
        if _id(handle):
            self._notifications.close(_id(handle))
