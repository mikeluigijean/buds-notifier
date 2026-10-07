import tempfile
import unittest
from pathlib import Path

from buds_notifier.config import load_config

REQUIRED = 'device_address = "AA:BB:CC:DD:EE:FF"\nname_patterns = ["Alice\'s Buds3 Pro"]\n'


def write_config(text: str) -> Path:
    f = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False)
    f.write(text)
    f.close()
    return Path(f.name)


class ConfigTest(unittest.TestCase):
    def test_missing_file_rejected(self):
        with self.assertRaisesRegex(ValueError, "device_address and name_patterns"):
            load_config(Path("/nonexistent/config.toml"))

    def test_missing_required_key_rejected(self):
        with self.assertRaisesRegex(ValueError, "name_patterns"):
            load_config(write_config('device_address = "AA:BB:CC:DD:EE:FF"\n'))

    def test_required_keys_and_defaults(self):
        config = load_config(write_config(REQUIRED))
        self.assertEqual(config.device_address, "AA:BB:CC:DD:EE:FF")
        self.assertEqual(config.name_patterns, ("Alice's Buds3 Pro",))
        self.assertEqual(config.low_battery_percent, 15)

    def test_address_is_normalised(self):
        config = load_config(write_config(REQUIRED.replace("AA:BB:CC:DD:EE:FF", "aa:bb:cc:dd:ee:ff")))
        self.assertEqual(config.device_address, "AA:BB:CC:DD:EE:FF")

    def test_unknown_key_rejected(self):
        with self.assertRaises(ValueError):
            load_config(write_config(REQUIRED + "typo_key = 1\n"))

    def test_bad_thresholds_rejected(self):
        with self.assertRaises(ValueError):
            load_config(write_config(
                REQUIRED + "low_battery_percent = 20\nlow_battery_rearm_percent = 20\n"))


if __name__ == "__main__":
    unittest.main()
