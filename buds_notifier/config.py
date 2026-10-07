"""Load user configuration from ~/.config/buds-notifier/config.toml."""

import tomllib
from dataclasses import dataclass, fields
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "buds-notifier" / "config.toml"


@dataclass(frozen=True)
class Config:
    # Public (classic) address of the paired headset — the only device we ever connect to.
    device_address: str
    # Nearby watcher: LE advertised-name prefixes of the headset.
    name_patterns: tuple[str, ...]
    adapter: str = "hci0"
    low_battery_percent: int = 15
    low_battery_rearm_percent: int = 20
    nearby_cooldown_seconds: int = 60
    # dBm: "found" when stronger than nearby_rssi_found, "lost" when weaker than nearby_rssi_lost.
    nearby_rssi_found: int = -85
    nearby_rssi_lost: int = -95


REQUIRED_KEYS = ("device_address", "name_patterns")


def load_config(path: Path = CONFIG_PATH) -> Config:
    data = {}
    if path.exists():
        with path.open("rb") as f:
            data = tomllib.load(f)

    missing = [key for key in REQUIRED_KEYS if not data.get(key)]
    if missing:
        raise ValueError(f"Set {' and '.join(missing)} in {path} (see config.example.toml)")

    known = {f.name for f in fields(Config)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"Unknown config keys in {path}: {', '.join(sorted(unknown))}")

    if "name_patterns" in data:
        data["name_patterns"] = tuple(data["name_patterns"])
    if "device_address" in data:
        data["device_address"] = data["device_address"].upper()

    config = Config(**data)
    if config.low_battery_rearm_percent <= config.low_battery_percent:
        raise ValueError("low_battery_rearm_percent must be greater than low_battery_percent")
    if not -127 <= config.nearby_rssi_lost < config.nearby_rssi_found <= 20:
        raise ValueError("need -127 <= nearby_rssi_lost < nearby_rssi_found <= 20")
    return config
