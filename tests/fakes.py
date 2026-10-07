"""Test doubles shared by the watcher and presenter tests."""

from buds_notifier.presenters import NO_HANDLE


class FakePresenter:
    """Records calls as (event, kwargs) and hands out ("fake", n) handles."""

    def __init__(self):
        self.calls = []
        self.closed = []
        self._next = 1

    def _record(self, event, replaces=NO_HANDLE, **data):
        handle = replaces if replaces[1] else ("fake", self._next)
        if not replaces[1]:
            self._next += 1
        self.calls.append((event, {"handle": handle, "replaces": replaces, **data}))
        return handle

    def connected(self, name, battery, replaces=NO_HANDLE):
        return self._record("connected", replaces, name=name, battery=battery)

    def disconnected(self, name):
        return self._record("disconnected", name=name)

    def low_battery(self, name, battery):
        return self._record("low_battery", name=name, battery=battery)

    def nearby(self, name, on_connect, replaces=NO_HANDLE):
        return self._record("nearby", replaces, name=name, on_connect=on_connect)

    def connect_failed(self, name, error, replaces=NO_HANDLE):
        return self._record("connect_failed", replaces, name=name, error=error)

    def close(self, handle):
        self.closed.append(handle)

    def events(self, event=None):
        return [data for e, data in self.calls if event is None or e == event]


class FakeNotifications:
    """Stands in for NotificationService."""

    def __init__(self):
        self.sent = []
        self.closed = []
        self._next = 100

    def notify(self, summary, body="", icon="audio-headset", replaces_id=0, actions=None, urgency=1):
        notification_id = replaces_id or self._next
        self._next += 1
        self.sent.append({"id": notification_id, "summary": summary, "body": body,
                          "replaces_id": replaces_id, "actions": actions, "urgency": urgency})
        return notification_id

    def close(self, notification_id):
        self.closed.append(notification_id)


class FakePopups:
    """Stands in for ShellPopupService; `accept=False` simulates no extension / DND."""

    def __init__(self, accept=True):
        self.accept = accept
        self.shown = []
        self.closed = []
        self._next = 1

    def show(self, card):
        if not self.accept:
            return 0
        card_id = card.get("replaces_id") or self._next
        self._next += 1
        self.shown.append((card_id, card))
        return card_id

    def close(self, card_id):
        self.closed.append(card_id)
