"""How events are shown: custom shell popups, falling back to standard notifications.

Handles returned by a presenter are opaque; pass them back to update/close what was shown.
"""

from collections.abc import Callable
from typing import Protocol

from ..battery import Battery

Handle = tuple[str, int]  # (backend, id); ("", 0) = nothing shown
NO_HANDLE: Handle = ("", 0)


class Presenter(Protocol):
    def connected(self, name: str, battery: Battery | None,
                  replaces: Handle = NO_HANDLE) -> Handle: ...

    def disconnected(self, name: str) -> Handle: ...

    def low_battery(self, name: str, battery: Battery) -> Handle: ...

    def nearby(self, name: str, on_connect: Callable[[], None],
               replaces: Handle = NO_HANDLE) -> Handle: ...

    def connect_failed(self, name: str, error: str, replaces: Handle = NO_HANDLE) -> Handle: ...

    def close(self, handle: Handle) -> None: ...
