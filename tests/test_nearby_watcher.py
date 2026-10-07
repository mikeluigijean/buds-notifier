import unittest

from buds_notifier.watchers.nearby_watcher import NearbyWatcher
from tests.test_connection_watcher import FakeNotifier

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
        self.closed = []
        self.connect_calls = []
        self.notifier = FakeNotifier()
        self.watcher = NearbyWatcher(
            "Buds", PATTERNS, 60, self.notifier,
            close_notification=self.closed.append,
            get_name_at=NAMES.get,
            is_connected=lambda: self.connected,
            connect=self.connect_calls.append,
            clock=lambda: self.now,
        )

    def nearby_count(self):
        return sum(1 for n in self.notifier.sent if n["summary"] == "Buds nearby")


class NearbyWatcherTest(unittest.TestCase):
    def test_matching_names_notify(self):
        for path in ("/dev_mine", "/dev_le"):
            h = Harness()
            h.watcher.on_device_found(path)
            self.assertEqual(h.nearby_count(), 1, path)

    def test_non_matching_names_ignored(self):
        h = Harness()
        for path in ("/dev_generic", "/dev_watch", "/dev_other", "/dev_unknown"):
            h.watcher.on_device_found(path)
        self.assertEqual(h.notifier.sent, [])

    def test_no_popup_when_connected(self):
        h = Harness()
        h.connected = True
        h.watcher.on_device_found("/dev_mine")
        self.assertEqual(h.notifier.sent, [])

    def test_cooldown_dedupes_then_repeats(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        h.watcher.on_device_found("/dev_le")  # same buds, another random address
        self.assertEqual(h.nearby_count(), 1)
        h.now += 61
        h.watcher.on_device_found("/dev_mine")
        self.assertEqual(h.nearby_count(), 2)
        self.assertEqual(h.notifier.sent[1]["replaces_id"], h.notifier.sent[0]["id"])

    def test_connect_button_and_error(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        h.watcher._on_connect_clicked()
        self.assertEqual(len(h.connect_calls), 1)
        h.connect_calls[0]("br-connection-page-timeout")
        self.assertEqual(h.notifier.sent[-1]["summary"], "Couldn't connect Buds")

    def test_connect_success_is_silent(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        h.watcher._on_connect_clicked()
        h.connect_calls[0](None)
        self.assertEqual(h.nearby_count(), 1)
        self.assertEqual(len(h.notifier.sent), 1)

    def test_connecting_closes_popup(self):
        h = Harness()
        h.watcher.on_device_found("/dev_mine")
        notification_id = h.notifier.sent[0]["id"]
        h.watcher.on_connected_changed(True)
        self.assertEqual(h.closed, [notification_id])


if __name__ == "__main__":
    unittest.main()
