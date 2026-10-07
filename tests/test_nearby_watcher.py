import unittest

from buds_notifier.watchers.nearby_watcher import NearbyWatcher
from tests.fakes import FakePresenter

PATTERNS = ("Alice's Buds3 Pro", "Galaxy Buds3 Pro (EEFF)")
NAMES = {
    "/dev_mine": "Alice's Buds3 Pro",
    "/dev_le": "Galaxy Buds3 Pro (EEFF) LE",
    "/dev_generic": "Buds3 Pro",
    "/dev_watch": "Galaxy Watch8 Classic (1A2B)",
    "/dev_other": "Galaxy Buds3 Pro (1234) LE",
}


class Harness:
    def __init__(self):
        self.now = 1000.0
        self.connected = False
        self.connect_calls = []
        self.presenter = FakePresenter()
        self.watcher = NearbyWatcher(
            "Buds", PATTERNS, 60, self.presenter,
            get_name_at=NAMES.get,
            is_connected=lambda: self.connected,
            connect=self.connect_calls.append,
            clock=lambda: self.now,
        )

    def nearby(self):
        return self.presenter.events("nearby")


class NearbyWatcherTest(unittest.TestCase):
    def test_matching_names_popup(self):
        for path in ("/dev_mine", "/dev_le"):
            h = Harness()
            h.watcher.on_device_found(path)
            self.assertEqual(len(h.nearby()), 1, path)

    def test_non_matching_names_ignored(self):
        h = Harness()
        for path in ("/dev_generic", "/dev_watch", "/dev_other", "/dev_unknown"):
            h.watcher.on_device_found(path)
        self.assertEqual(h.presenter.calls, [])

    def test_no_popup_when_connected(self):
        h = Harness()
        h.connected = True
        h.watcher.on_device_found("/dev_mine")
        self.assertEqual(h.presenter.calls, [])

    def test_cooldown_dedupes_then_repeats(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        h.watcher.on_device_found("/dev_le")  # same buds, another random address
        self.assertEqual(len(h.nearby()), 1)
        h.now += 61
        h.watcher.on_device_found("/dev_mine")
        self.assertEqual(len(h.nearby()), 2)
        self.assertEqual(h.nearby()[1]["replaces"], h.nearby()[0]["handle"])

    def test_connect_button_and_error(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        h.nearby()[0]["on_connect"]()
        self.assertEqual(len(h.connect_calls), 1)
        h.connect_calls[0]("br-connection-page-timeout")
        (failed,) = h.presenter.events("connect_failed")
        self.assertEqual(failed["error"], "br-connection-page-timeout")

    def test_connect_success_is_silent(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        h.nearby()[0]["on_connect"]()
        h.connect_calls[0](None)
        self.assertEqual(len(h.presenter.calls), 1)

    def test_connecting_closes_popup(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        h.watcher.on_connected_changed(True)
        self.assertEqual(h.presenter.closed, [h.nearby()[0]["handle"]])


if __name__ == "__main__":
    unittest.main()
