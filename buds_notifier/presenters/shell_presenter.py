"""Custom popup cards via the GNOME Shell extension, with notification fallback."""

from collections.abc import Callable
from typing import Protocol

from ..battery import Battery
from . import NO_HANDLE, Handle, Presenter

BACKEND = "shell"


class ShellPopups(Protocol):
    def show(self, card: dict) -> int: ...
    def close(self, card_id: int) -> None: ...


class ShellPresenter:
    """Shows cards through the extension; anything it can't show goes to `fallback`."""

    def __init__(self, popups: ShellPopups, fallback: Presenter):
        self._popups = popups
        self._fallback = fallback
        self._actions: dict[int, dict[str, Callable[[], None]]] = {}

    # Wire these to ShellPopupService's ActionInvoked / Closed signals.
    def on_action(self, card_id: int, action: str) -> None:
        callback = self._actions.get(card_id, {}).get(action)
        if callback:
            callback()

    def on_closed(self, card_id: int, _reason: str) -> None:
        self._actions.pop(card_id, None)

    def _show(self, card: dict, replaces: Handle,
              actions: dict[str, Callable[[], None]] | None = None) -> Handle:
        if replaces[0] == BACKEND:
            card["replaces_id"] = replaces[1]
        card_id = self._popups.show(card)
        if not card_id:
            return NO_HANDLE
        if actions:
            self._actions[card_id] = actions
        return (BACKEND, card_id)

    def connected(self, name: str, battery: Battery | None,
                  replaces: Handle = NO_HANDLE) -> Handle:
        card = {"kind": "connected", "title": name, "subtitle": "Connected",
                "battery": battery.to_card() if battery else None}
        shown = self._show(card, replaces)
        return shown if shown[1] else self._fallback.connected(
            name, battery, self._fallback_handle(replaces))

    def disconnected(self, name: str) -> Handle:
        card = {"kind": "disconnected", "title": name, "subtitle": "Disconnected"}
        shown = self._show(card, NO_HANDLE)
        return shown if shown[1] else self._fallback.disconnected(name)

    def low_battery(self, name: str, battery: Battery) -> Handle:
        card = {"kind": "low-battery", "title": name, "subtitle": "Battery low",
                "battery": battery.to_card()}
        shown = self._show(card, NO_HANDLE)
        return shown if shown[1] else self._fallback.low_battery(name, battery)

    def nearby(self, name: str, on_connect: Callable[[], None],
               replaces: Handle = NO_HANDLE) -> Handle:
        card = {"kind": "nearby", "title": name, "subtitle": "Nearby — not connected",
                "actions": [{"id": "connect", "label": "Connect"},
                            {"id": "dismiss", "label": "Dismiss"}]}
        shown = self._show(card, replaces, {"connect": on_connect})
        return shown if shown[1] else self._fallback.nearby(
            name, on_connect, self._fallback_handle(replaces))

    def connect_failed(self, name: str, error: str, replaces: Handle = NO_HANDLE) -> Handle:
        card = {"kind": "error", "title": name, "subtitle": f"Couldn't connect: {error}"}
        shown = self._show(card, replaces)
        return shown if shown[1] else self._fallback.connect_failed(
            name, error, self._fallback_handle(replaces))

    def close(self, handle: Handle) -> None:
        if handle[0] == BACKEND:
            self._popups.close(handle[1])
        else:
            self._fallback.close(handle)

    @staticmethod
    def _fallback_handle(handle: Handle) -> Handle:
        return NO_HANDLE if handle[0] == BACKEND else handle
