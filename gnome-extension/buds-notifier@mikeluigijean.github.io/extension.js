// Buds Notifier Popups: draws Windows-style cards bottom-right on behalf of the
// buds-notifier service, which drives it over the session bus.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BudsCard} from './card.js';

const BUS_NAME = 'io.github.mikeluigijean.BudsNotifier.Shell';
const OBJECT_PATH = '/io/github/mikeluigijean/BudsNotifier/Shell';
const IFACE_XML = `
<node>
  <interface name="io.github.mikeluigijean.BudsNotifier.Shell1">
    <method name="Show">
      <arg type="s" direction="in" name="card_json"/>
      <arg type="u" direction="out" name="id"/>
    </method>
    <method name="Close">
      <arg type="u" direction="in" name="id"/>
    </method>
    <signal name="ActionInvoked">
      <arg type="u" name="id"/>
      <arg type="s" name="action"/>
    </signal>
    <signal name="Closed">
      <arg type="u" name="id"/>
      <arg type="s" name="reason"/>
    </signal>
  </interface>
</node>`;

const DEFAULT_TIMEOUT = {'nearby': 20, 'connected': 8, 'disconnected': 6, 'low-battery': 10, 'error': 10};
const MARGIN = 16;
const SLIDE = 24;
const ANIMATION_MS = 220;

export default class BudsNotifierExtension extends Extension {
    enable() {
        this._nextId = 1;
        this._card = null;
        this._cardId = 0;
        this._timeoutId = 0;
        this._timeoutSeconds = 0;
        this._notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._gicon = Gio.FileIcon.new(this.dir.get_child('icons').get_child('earbuds-symbolic.svg'));

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        this._closeCard('disabled', false);
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._dbus?.unexport();
        this._dbus = null;
        this._notificationSettings = null;
        this._gicon = null;
    }

    // D-Bus: returns 0 when the card can't be shown now (Do Not Disturb, locked screen),
    // so the service falls back to a regular (queued) notification.
    Show(cardJson) {
        if (!this._notificationSettings.get_boolean('show-banners') || Main.sessionMode.isLocked)
            return 0;

        let card;
        try {
            card = JSON.parse(cardJson);
        } catch (e) {
            console.warn(`buds-notifier: invalid card JSON: ${e.message}`);
            return 0;
        }

        // In-place update (e.g. battery arriving after "connected"): keep id, no animation.
        if (card.replaces_id && card.replaces_id === this._cardId && this._card) {
            this._card.setContent(card);
            this._place(false);
            this._startTimeout(card);
            return this._cardId;
        }

        this._closeCard('replaced', false);
        const id = this._nextId++;
        this._cardId = id;
        const widget = new BudsCard(this._gicon);
        this._card = widget;
        widget.setContent(card);
        widget.connect('action', (_card, action) => {
            this._emit('ActionInvoked', id, action);
            this._closeCard('action', true);
        });
        widget.connect('dismiss', () => this._closeCard('dismissed', true));
        // Hovering pauses auto-hide; leaving gives a few more seconds.
        widget.connect('notify::hover', () => {
            if (this._card !== widget)
                return;
            if (widget.hover)
                this._stopTimeout();
            else
                this._startTimeout({timeout: 3});
        });

        Main.layoutManager.addTopChrome(this._card);
        this._place(true);
        this._startTimeout(card);
        return id;
    }

    Close(id) {
        if (id && id === this._cardId)
            this._closeCard('closed', true);
    }

    _place(animate) {
        const monitor = Main.layoutManager.primaryIndex;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const [, width] = this._card.get_preferred_width(-1);
        const [, height] = this._card.get_preferred_height(width);
        this._card.set_position(
            area.x + area.width - width - MARGIN,
            area.y + area.height - height - MARGIN);

        if (!animate)
            return;
        this._card.opacity = 0;
        this._card.translation_y = SLIDE;
        this._card.ease({
            opacity: 255,
            translation_y: 0,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _startTimeout(card) {
        this._stopTimeout();
        const seconds = card.timeout ?? DEFAULT_TIMEOUT[card.kind] ?? 8;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = 0;
            this._closeCard('expired', true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _closeCard(reason, animate) {
        this._stopTimeout();
        const card = this._card;
        const id = this._cardId;
        if (!card)
            return;
        this._card = null;
        this._cardId = 0;
        this._emit('Closed', id, reason);

        // Destroying the actor also untracks it from the layout manager.
        const remove = () => card.destroy();
        if (!animate) {
            remove();
            return;
        }
        card.reactive = false;
        card.ease({
            opacity: 0,
            translation_y: SLIDE,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: remove,
        });
    }

    _emit(signal, id, value) {
        this._dbus?.emit_signal(signal, new GLib.Variant('(us)', [id, value]));
    }
}
