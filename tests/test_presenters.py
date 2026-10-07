import unittest

from buds_notifier.battery import Battery, Slot
from buds_notifier.presenters import NO_HANDLE
from buds_notifier.presenters.notification_presenter import NotificationPresenter
from buds_notifier.presenters.shell_presenter import ShellPresenter
from tests.fakes import FakeNotifications, FakePopups


def make(accept=True):
    popups = FakePopups(accept)
    notifications = FakeNotifications()
    return ShellPresenter(popups, NotificationPresenter(notifications)), popups, notifications


class ShellPresenterTest(unittest.TestCase):
    def test_connected_card_with_battery(self):
        presenter, popups, notifications = make()
        handle = presenter.connected("Buds", Battery(left=Slot(61), right=Slot(44)))
        self.assertEqual(handle, ("shell", 1))
        card = popups.shown[0][1]
        self.assertEqual(card["kind"], "connected")
        self.assertEqual(card["battery"]["left"], {"level": 61, "charging": False})
        self.assertIsNone(card["battery"]["case"])
        self.assertEqual(notifications.sent, [])

    def test_update_in_place_passes_replaces_id(self):
        presenter, popups, _ = make()
        handle = presenter.connected("Buds", None)
        presenter.connected("Buds", Battery(single=44), replaces=handle)
        self.assertEqual(popups.shown[1][1]["replaces_id"], 1)

    def test_falls_back_to_notification_when_extension_declines(self):
        presenter, _, notifications = make(accept=False)
        handle = presenter.connected("Buds", Battery(left=Slot(61), right=Slot(44)))
        self.assertEqual(handle[0], "notification")
        self.assertEqual(notifications.sent[0]["summary"], "Buds connected")
        self.assertEqual(notifications.sent[0]["body"], "Battery: L 61% · R 44%")

    def test_fallback_for_every_event(self):
        presenter, _, notifications = make(accept=False)
        presenter.disconnected("Buds")
        presenter.low_battery("Buds", Battery(single=9))
        presenter.nearby("Buds", lambda: None)
        presenter.connect_failed("Buds", "oops")
        self.assertEqual([n["summary"] for n in notifications.sent],
                         ["Buds disconnected", "Buds battery low", "Buds nearby",
                          "Couldn't connect Buds"])

    def test_nearby_connect_action_runs_callback(self):
        presenter, popups, _ = make()
        clicked = []
        handle = presenter.nearby("Buds", lambda: clicked.append(True))
        presenter.on_action(handle[1], "dismiss")
        self.assertEqual(clicked, [])
        presenter.on_action(handle[1], "connect")
        self.assertEqual(clicked, [True])
        presenter.on_closed(handle[1], "action")
        presenter.on_action(handle[1], "connect")  # stale card: ignored
        self.assertEqual(clicked, [True])

    def test_close_routes_to_backend(self):
        presenter, popups, notifications = make()
        presenter.close(("shell", 7))
        presenter.close(("notification", 101))
        presenter.close(NO_HANDLE)
        self.assertEqual(popups.closed, [7])
        self.assertEqual(notifications.closed, [101])

    def test_shell_handle_not_passed_to_fallback(self):
        presenter, popups, notifications = make()
        handle = presenter.nearby("Buds", lambda: None)
        popups.accept = False  # e.g. Do Not Disturb turned on meanwhile
        presenter.nearby("Buds", lambda: None, replaces=handle)
        self.assertEqual(notifications.sent[0]["replaces_id"], 0)


if __name__ == "__main__":
    unittest.main()
