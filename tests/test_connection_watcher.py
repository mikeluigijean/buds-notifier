import unittest

from buds_notifier.battery import Battery, Slot
from buds_notifier.watchers.connection_watcher import ConnectionWatcher
from tests.fakes import FakePresenter


class Harness:
    def __init__(self):
        self.now = 1000.0
        self.presenter = FakePresenter()
        self.watcher = ConnectionWatcher("Buds", self.presenter, 15, 20, clock=lambda: self.now)


def lr(left, right, case=None):
    return Battery(left=Slot(left), right=Slot(right), case=None if case is None else Slot(case))


class ConnectionWatcherTest(unittest.TestCase):
    def test_sync_is_silent(self):
        h = Harness()
        h.watcher.sync(True, 50)
        self.assertEqual(h.presenter.calls, [])

    def test_connect_with_known_bluez_battery(self):
        h = Harness()
        h.watcher.on_bluez_battery(71)  # Battery1 can appear just before Connected flips
        h.watcher.on_connected_changed(True)
        (event,) = h.presenter.events("connected")
        self.assertEqual(event["battery"], Battery(single=71))

    def test_budslink_battery_preferred_over_bluez(self):
        h = Harness()
        h.watcher.on_bluez_battery(44)
        h.watcher.on_budslink_battery(lr(61, 44))
        self.assertEqual(h.watcher.battery, lr(61, 44))

    def test_budslink_without_buds_falls_back_to_bluez(self):
        h = Harness()
        h.watcher.on_bluez_battery(44)
        h.watcher.on_budslink_battery(Battery(case=Slot(80)))
        self.assertEqual(h.watcher.battery, Battery(single=44))

    def test_battery_arriving_soon_updates_same_popup(self):
        h = Harness()
        h.watcher.on_connected_changed(True)
        first = h.presenter.events("connected")[0]
        self.assertIsNone(first["battery"])
        h.now += 3
        h.watcher.on_budslink_battery(lr(61, 44, 80))
        second = h.presenter.events("connected")[1]
        self.assertEqual(second["replaces"], first["handle"])
        self.assertEqual(second["battery"], lr(61, 44, 80))

    def test_battery_changes_later_do_not_repopup(self):
        h = Harness()
        h.watcher.on_connected_changed(True)
        h.now += 60
        h.watcher.on_bluez_battery(63)
        self.assertEqual(len(h.presenter.events("connected")), 1)

    def test_duplicate_state_is_ignored(self):
        h = Harness()
        h.watcher.on_connected_changed(False)
        h.watcher.on_connected_changed(True)
        h.watcher.on_connected_changed(True)
        self.assertEqual(len(h.presenter.calls), 1)

    def test_disconnect_clears_battery(self):
        h = Harness()
        h.watcher.sync(True, 80, lr(80, 80))
        h.watcher.on_connected_changed(False)
        self.assertEqual(h.presenter.events("disconnected")[0]["name"], "Buds")
        self.assertIsNone(h.watcher.battery)

    def test_low_battery_uses_lowest_bud_and_hysteresis(self):
        h = Harness()
        h.watcher.sync(True, None, lr(60, 30))
        h.watcher.on_budslink_battery(lr(60, 14))   # warn
        h.watcher.on_budslink_battery(lr(59, 12))   # still low: no repeat
        h.watcher.on_budslink_battery(lr(59, 16))   # between thresholds: still armed off
        h.watcher.on_budslink_battery(lr(58, 13))
        self.assertEqual(len(h.presenter.events("low_battery")), 1)
        h.watcher.on_budslink_battery(lr(58, 20))   # charged back: re-arm
        h.watcher.on_budslink_battery(lr(58, 14))
        self.assertEqual(len(h.presenter.events("low_battery")), 2)

    def test_case_level_never_triggers_low_battery(self):
        h = Harness()
        h.watcher.sync(True, None, lr(80, 80, 30))
        h.watcher.on_budslink_battery(lr(80, 80, 5))
        self.assertEqual(h.presenter.events("low_battery"), [])

    def test_low_battery_at_connect(self):
        h = Harness()
        h.watcher.on_bluez_battery(10)
        h.watcher.on_connected_changed(True)
        self.assertEqual([e for e, _ in h.presenter.calls], ["connected", "low_battery"])

    def test_reconnect_rearms_low_battery(self):
        h = Harness()
        h.watcher.sync(True, 10)
        h.watcher.on_connected_changed(False)
        h.watcher.on_bluez_battery(10)
        h.watcher.on_connected_changed(True)
        self.assertEqual(len(h.presenter.events("low_battery")), 2)

    def test_battery_ignored_while_disconnected(self):
        h = Harness()
        h.watcher.on_bluez_battery(5)
        h.watcher.on_budslink_battery(lr(5, 5))
        self.assertEqual(h.presenter.calls, [])


if __name__ == "__main__":
    unittest.main()
