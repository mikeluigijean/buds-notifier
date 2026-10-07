import unittest

from buds_notifier.watchers.connection_watcher import ConnectionWatcher


class FakeNotifier:
    def __init__(self):
        self.sent = []
        self._next_id = 1

    def notify(self, summary, body="", icon="audio-headset", replaces_id=0, actions=None, urgency=1):
        notification_id = replaces_id or self._next_id
        self._next_id += 1
        self.sent.append({"id": notification_id, "summary": summary, "body": body,
                          "replaces_id": replaces_id, "urgency": urgency})
        return notification_id


def make_watcher():
    notifier = FakeNotifier()
    return ConnectionWatcher("Buds", notifier, 15, 20), notifier


class ConnectionWatcherTest(unittest.TestCase):
    def test_sync_is_silent(self):
        watcher, notifier = make_watcher()
        watcher.sync(True, 50)
        self.assertEqual(notifier.sent, [])

    def test_connect_with_known_battery(self):
        watcher, notifier = make_watcher()
        watcher.on_battery_changed(71)  # Battery1 can appear just before Connected flips
        watcher.on_connected_changed(True)
        self.assertEqual(notifier.sent[-1]["summary"], "Buds connected")
        self.assertEqual(notifier.sent[-1]["body"], "Battery: 71%")

    def test_battery_arriving_later_updates_same_notification(self):
        watcher, notifier = make_watcher()
        watcher.on_connected_changed(True)
        first = notifier.sent[-1]
        self.assertEqual(first["body"], "Battery: unknown")
        watcher.on_battery_changed(64)
        self.assertEqual(notifier.sent[-1]["replaces_id"], first["id"])
        self.assertEqual(notifier.sent[-1]["body"], "Battery: 64%")
        # Further battery updates don't re-notify
        watcher.on_battery_changed(63)
        self.assertEqual(len(notifier.sent), 2)

    def test_duplicate_state_is_ignored(self):
        watcher, notifier = make_watcher()
        watcher.on_connected_changed(False)
        watcher.on_connected_changed(True)
        watcher.on_connected_changed(True)
        self.assertEqual(len(notifier.sent), 1)

    def test_disconnect(self):
        watcher, notifier = make_watcher()
        watcher.sync(True, 80)
        watcher.on_connected_changed(False)
        self.assertEqual(notifier.sent[-1]["summary"], "Buds disconnected")

    def test_low_battery_warns_once_and_rearms(self):
        watcher, notifier = make_watcher()
        watcher.sync(True, 30)
        watcher.on_battery_changed(14)
        watcher.on_battery_changed(12)
        watcher.on_battery_changed(16)  # between thresholds: still armed off
        watcher.on_battery_changed(13)
        lows = [n for n in notifier.sent if n["summary"] == "Buds battery low"]
        self.assertEqual(len(lows), 1)
        self.assertEqual(lows[0]["urgency"], 2)

        watcher.on_battery_changed(20)  # charged back up: re-arm
        watcher.on_battery_changed(14)
        lows = [n for n in notifier.sent if n["summary"] == "Buds battery low"]
        self.assertEqual(len(lows), 2)

    def test_low_battery_at_connect(self):
        watcher, notifier = make_watcher()
        watcher.on_battery_changed(10)
        watcher.on_connected_changed(True)
        summaries = [n["summary"] for n in notifier.sent]
        self.assertEqual(summaries, ["Buds connected", "Buds battery low"])

    def test_reconnect_rearms_low_battery(self):
        watcher, notifier = make_watcher()
        watcher.sync(True, 10)  # silent sync still warns when already low
        watcher.on_connected_changed(False)
        watcher.on_battery_changed(10)
        watcher.on_connected_changed(True)
        lows = [n for n in notifier.sent if n["summary"] == "Buds battery low"]
        self.assertEqual(len(lows), 2)

    def test_battery_ignored_while_disconnected(self):
        watcher, notifier = make_watcher()
        watcher.on_battery_changed(5)
        self.assertEqual(notifier.sent, [])


if __name__ == "__main__":
    unittest.main()
