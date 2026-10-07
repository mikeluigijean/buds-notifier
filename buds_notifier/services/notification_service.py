"""Desktop notifications via org.freedesktop.Notifications on the session bus."""

import logging
from collections.abc import Callable

import dbus

log = logging.getLogger(__name__)

NOTIFICATIONS = "org.freedesktop.Notifications"
NOTIFICATIONS_PATH = "/org/freedesktop/Notifications"

URGENCY_LOW, URGENCY_NORMAL, URGENCY_CRITICAL = 0, 1, 2


class NotificationService:
    def __init__(self, bus: dbus.Bus, app_name: str = "Buds Notifier"):
        self._bus = bus
        self._app_name = app_name
        # notification id -> {action key: callback}
        self._actions: dict[int, dict[str, Callable[[], None]]] = {}

        bus.add_signal_receiver(
            self._on_action_invoked, "ActionInvoked", NOTIFICATIONS, path=NOTIFICATIONS_PATH
        )
        bus.add_signal_receiver(
            self._on_closed, "NotificationClosed", NOTIFICATIONS, path=NOTIFICATIONS_PATH
        )

    def notify(
        self,
        summary: str,
        body: str = "",
        icon: str = "audio-headset",
        replaces_id: int = 0,
        actions: dict[str, tuple[str, Callable[[], None]]] | None = None,
        urgency: int = URGENCY_NORMAL,
    ) -> int:
        """Show a notification and return its id (0 if it couldn't be shown).

        actions maps an action key to (button label, callback).
        """
        actions = actions or {}
        flat_actions = [part for key, (label, _) in actions.items() for part in (key, label)]
        hints = {"urgency": dbus.Byte(urgency)}
        try:
            proxy = self._bus.get_object(NOTIFICATIONS, NOTIFICATIONS_PATH)
            notification_id = int(
                dbus.Interface(proxy, NOTIFICATIONS).Notify(
                    self._app_name,
                    dbus.UInt32(replaces_id),
                    icon,
                    summary,
                    body,
                    dbus.Array(flat_actions, signature="s"),
                    dbus.Dictionary(hints, signature="sv"),
                    dbus.Int32(-1),
                )
            )
        except dbus.DBusException as e:
            log.warning("Could not show notification %r: %s", summary, e)
            return 0

        self._actions.pop(replaces_id, None)
        if actions:
            self._actions[notification_id] = {key: cb for key, (_, cb) in actions.items()}
        log.info("Notified: %s — %s", summary, body)
        return notification_id

    def close(self, notification_id: int) -> None:
        if not notification_id:
            return
        self._actions.pop(notification_id, None)
        try:
            proxy = self._bus.get_object(NOTIFICATIONS, NOTIFICATIONS_PATH)
            dbus.Interface(proxy, NOTIFICATIONS).CloseNotification(dbus.UInt32(notification_id))
        except dbus.DBusException as e:
            log.debug("Could not close notification %d: %s", notification_id, e)

    def _on_action_invoked(self, notification_id, action_key):
        callback = self._actions.get(int(notification_id), {}).get(str(action_key))
        if callback:
            callback()

    def _on_closed(self, notification_id, _reason):
        self._actions.pop(int(notification_id), None)
