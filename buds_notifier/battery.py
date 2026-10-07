"""Battery levels: per-bud and case (from BudsLink) or a single level (from BlueZ)."""

import json
from dataclasses import asdict, dataclass

# BudsLink reports these statuses for slots it has no current value for.
_UNAVAILABLE = {"disconnected", "not-reported"}


@dataclass(frozen=True)
class Slot:
    level: int
    charging: bool = False


@dataclass(frozen=True)
class Battery:
    left: Slot | None = None
    right: Slot | None = None
    case: Slot | None = None
    single: int | None = None

    @property
    def has_buds(self) -> bool:
        return self.left is not None or self.right is not None

    def lowest_bud(self) -> int | None:
        """Level the low-battery warning is based on (case excluded)."""
        levels = [s.level for s in (self.left, self.right) if s is not None]
        if levels:
            return min(levels)
        return self.single

    def text(self) -> str:
        parts = [f"{name} {slot.level}%{' (charging)' if slot.charging else ''}"
                 for name, slot in (("L", self.left), ("R", self.right), ("Case", self.case))
                 if slot is not None]
        if parts:
            return " · ".join(parts)
        return "unknown" if self.single is None else f"{self.single}%"

    def to_card(self) -> dict:
        return asdict(self)


def parse_budslink_state(state_json: str) -> Battery | None:
    """BudsLink Device.State JSON -> Battery (battery1 = left, 2 = right, 3 = case)."""
    try:
        state = json.loads(state_json)
    except (TypeError, ValueError):
        return None

    def slot(n: int) -> Slot | None:
        status = state.get(f"battery{n}Status")
        level = state.get(f"battery{n}Level")
        if status in _UNAVAILABLE or not isinstance(level, int):
            return None
        return Slot(level, charging=status == "charging")

    battery = Battery(left=slot(1), right=slot(2), case=slot(3))
    return battery if battery.has_buds or battery.case else None
