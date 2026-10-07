// Shows events as top-right cards, or as regular notifications in the message list when a card
// can't be shown (Do Not Disturb, locked screen). Runs inside GNOME Shell.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {BudsCard} from '../card.js';
import {batteryText} from './battery.js';

const DEFAULT_TIMEOUT = {'nearby': 20, 'connected': 8, 'disconnected': 6, 'low-battery': 10,
    'error': 10, 'info': 12};
const MARGIN = 16;
const SLIDE = -24; // cards slide down into place from just above
const ANIMATION_MS = 220;

export class Popups {
    // onClosed(id, reason) / onAction(id, action) observe every card (used by the D-Bus API).
    constructor(gicon, {onClosed = () => {}, onAction = () => {}} = {}) {
        this._gicon = gicon;
        this._onClosed = onClosed;
        this._onAction = onAction;
        this._notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._nextId = 1;
        this._card = null;
        this._cardId = 0;
        this._cardActions = {};
        this._timeoutId = 0;
        this._source = null;
        this.history = [];  // recent {time, kind, title, subtitle, via} for Status()
    }

    destroy() {
        this._closeCard('disabled', false);
        this._source?.destroy();
        this._source = null;
        this._notificationSettings = null;
    }

    get canShowCards() {
        return this._notificationSettings.get_boolean('show-banners') && !Main.sessionMode.isLocked;
    }

    // card: {kind, title, subtitle, battery?, buttons?: [{id, label}], timeout?}
    // actions: {id: callback}. replaces: a handle returned earlier (updated in place if possible).
    // Returns a handle: {type: 'card', id} | {type: 'notification', notification} | null.
    show(card, actions = {}, replaces = null) {
        const handle = this._show(card, actions, replaces);
        this._remember(card, handle?.type);
        return handle;
    }

    _remember(card, via) {
        this.history.push({time: new Date().toISOString(), kind: card.kind, title: card.title,
            subtitle: card.subtitle ?? '', battery: card.battery ? batteryText(card.battery) : null, via});
        this.history.splice(0, this.history.length - 20);
    }

    _show(card, actions, replaces) {
        if (this.canShowCards) {
            const id = this.showCard(card, actions, replaces?.type === 'card' ? replaces.id : 0);
            if (id)
                return {type: 'card', id};
        }
        return this._notify(card, actions, replaces?.type === 'notification' ? replaces.notification : null);
    }

    // Refresh what a handle shows, only if it's still visible (never re-pops a closed card).
    update(card, handle) {
        if (handle?.type === 'card' && handle.id === this._cardId && this.canShowCards) {
            this.showCard(card, this._cardActions, handle.id);
            this._remember(card, 'card-update');
        } else if (handle?.type === 'notification' && this._source?.notifications.includes(handle.notification)) {
            this._notify(card, {}, handle.notification);
            this._remember(card, 'notification-update');
        }
        return handle;
    }

    close(handle) {
        if (handle?.type === 'card')
            this.closeCard(handle.id);
        else if (handle?.type === 'notification')
            handle.notification.destroy();
    }

    // Returns the card id, or 0 if cards can't be shown now.
    showCard(card, actions = {}, replacesId = 0) {
        if (!this.canShowCards)
            return 0;

        if (replacesId && replacesId === this._cardId && this._card) {
            this._card.setContent(card);
            this._cardActions = actions;
            this._place(false);
            this._startTimeout(card);
            return this._cardId;
        }

        this._closeCard('replaced', false);
        const id = this._nextId++;
        const widget = new BudsCard(this._gicon);
        this._card = widget;
        this._cardId = id;
        this._cardActions = actions;
        widget.setContent(card);
        widget.connect('action', (_w, action) => this.activate(id, action));
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

        Main.layoutManager.addTopChrome(widget);
        this._place(true);
        this._startTimeout(card);
        return id;
    }

    closeCard(id) {
        if (id && id === this._cardId)
            this._closeCard('closed', true);
    }

    // Same as clicking a card button (also used by the D-Bus test API).
    activate(id, action) {
        if (id !== this._cardId)
            return false;
        const callback = this._cardActions[action];
        this._onAction(id, action);
        this._closeCard('action', true);
        callback?.();
        return true;
    }

    _notify(card, actions, existing) {
        const title = card.subtitle ? `${card.title}: ${card.subtitle}` : card.title;
        const body = card.battery ? batteryText(card.battery) : (card.body ?? '');
        const urgency = card.kind === 'low-battery' || card.kind === 'error'
            ? MessageTray.Urgency.HIGH : MessageTray.Urgency.NORMAL;

        if (existing && this._source?.notifications.includes(existing)) {
            existing.set({title, body});
            return {type: 'notification', notification: existing};
        }

        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Buds Notifier', iconName: 'audio-headphones-symbolic'});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({
            source: this._source, title, body, gicon: this._gicon, urgency,
        });
        for (const {id, label} of card.buttons ?? []) {
            if (actions[id])
                notification.addAction(label, actions[id]);
        }
        this._source.addNotification(notification);
        return {type: 'notification', notification};
    }

    _place(animate) {
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const [, width] = this._card.get_preferred_width(-1);
        this._card.set_position(area.x + area.width - width - MARGIN, area.y + MARGIN);
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
        this._cardActions = {};
        this._onClosed(id, reason);

        // Destroying the actor also untracks it from the layout manager.
        if (!animate) {
            card.destroy();
            return;
        }
        card.reactive = false;
        card.ease({
            opacity: 0,
            translation_y: SLIDE,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => card.destroy(),
        });
    }
}
