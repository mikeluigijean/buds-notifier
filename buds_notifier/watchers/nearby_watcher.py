"""Swift-Pair-like popup: the headset is advertising nearby but isn't connected."""

import logging
import time
from collections.abc import Callable

from .connection_watcher import Notifier

log = logging.getLogger(__name__)


class NearbyWatcher:
    def __init__(
        self,
        display_name: str,
        name_patterns: tuple[str, ...],
        cooldown_seconds: float,
        notifier: Notifier,
        close_notification: Callable[[int], None],
        get_name_at: Callable[[str], str | None],
        is_connected: Callable[[], bool],
        connect: Callable[[Callable[[str | None], None]], None],
        clock: Callable[[], float] = time.monotonic,
    ):
        self._name = display_name
        self._patterns = name_patterns
        self._cooldown = cooldown_seconds
        self._notifier = notifier
        self._close = close_notification
        self._get_name_at = get_name_at
        self._is_connected = is_connected
        self._connect = connect
        self._clock = clock

        self._last_notified: float | None = None
        self._notification_id = 0

    def on_device_found(self, device_path: str) -> None:
        # The controller already filtered on these patterns; double check the name BlueZ sees.
        name = self._get_name_at(device_path)
        if not name or not name.startswith(self._patterns):
            log.debug("Ignoring %s (name %r)", device_path, name)
            return
        if self._is_connected():
            return

        now = self._clock()
        # The buds advertise from several random addresses at once; the cooldown dedupes them.
        if self._last_notified is not None and now - self._last_notified < self._cooldown:
            return
        self._last_notified = now

        self._notification_id = self._notifier.notify(
            f"{self._name} nearby",
            "Not connected to this laptop.",
            replaces_id=self._notification_id,
            actions={"connect": ("Connect", self._on_connect_clicked)},
        )

    def on_connected_changed(self, connected: bool) -> None:
        if connected:
            self._close(self._notification_id)
            self._notification_id = 0

    def _on_connect_clicked(self) -> None:
        log.info("Connect clicked")
        self._connect(self._on_connect_done)

    def _on_connect_done(self, error: str | None) -> None:
        # Success is announced by the connection watcher.
        if error:
            log.warning("Connect failed: %s", error)
            self._notification_id = self._notifier.notify(
                f"Couldn't connect {self._name}", error,
                icon="dialog-warning", replaces_id=self._notification_id,
            )
