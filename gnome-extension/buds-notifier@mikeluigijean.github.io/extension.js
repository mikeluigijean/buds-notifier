// Buds Notifier: popup cards for any paired Bluetooth earbuds/headset — connected (with
// left/right/case battery via BudsLink), disconnected, low battery, and nearby + Connect.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AdvertisementMonitors, supportsHardwareFiltering} from './lib/advmon.js';
import {batteryText} from './lib/battery.js';
import {BluezClient, isHeadset} from './lib/bluez.js';
import {BudsLinkClient} from './lib/budslink.js';
import {ConnectionWatcher} from './lib/connectionWatcher.js';
import {NearbyWatcher} from './lib/nearbyWatcher.js';
import {namePatterns} from './lib/patterns.js';
import {Popups} from './lib/popups.js';

// Session-bus API. Status() and ShowTestCard() serve the preferences window. Show/Close/Activate
// (arbitrary cards, "press a button") exist for automated testing and only work while the hidden
// `developer-api` setting is on, so other apps can't spoof cards or trigger Connect.
const BUS_NAME = 'io.github.mikeluigijean.BudsNotifier.Shell';
const OBJECT_PATH = '/io/github/mikeluigijean/BudsNotifier/Shell';
const IFACE_XML = `<node>
  <interface name="io.github.mikeluigijean.BudsNotifier.Shell1">
    <method name="Show"><arg type="s" direction="in" name="card_json"/><arg type="u" direction="out" name="id"/></method>
    <method name="Close"><arg type="u" direction="in" name="id"/></method>
    <method name="Activate"><arg type="u" direction="in" name="id"/><arg type="s" direction="in" name="action"/><arg type="b" direction="out" name="handled"/></method>
    <method name="Status"><arg type="s" direction="out" name="status_json"/></method>
    <method name="ShowTestCard"/>
    <signal name="ActionInvoked"><arg type="u" name="id"/><arg type="s" name="action"/></signal>
    <signal name="Closed"><arg type="u" name="id"/><arg type="s" name="reason"/></signal>
  </interface>
</node>`;

const REFRESH_DELAY_MS = 500;

export default class BudsNotifierExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._watchers = new Map();   // BlueZ device path -> ConnectionWatcher
        this._refreshId = 0;
        this._bluezReady = false;
        // One-shot timers for watchers, all removed in disable().
        this._timerIds = new Set();
        this._timer = {
            add: (ms, callback) => {
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                    this._timerIds.delete(id);
                    callback();
                    return GLib.SOURCE_REMOVE;
                });
                this._timerIds.add(id);
                return id;
            },
            remove: id => {
                if (this._timerIds.delete(id))
                    GLib.source_remove(id);
            },
        };

        const gicon = Gio.FileIcon.new(this.dir.get_child('icons').get_child('earbuds-symbolic.svg'));
        this._popups = new Popups(gicon, {
            onClosed: (id, reason) => this._emit('Closed', id, reason),
            onAction: (id, action) => this._emit('ActionInvoked', id, action),
        });
        this._presenter = this._createPresenter();

        this._budslink = new BudsLinkClient((path, battery) =>
            this._watchers.get(path)?.onBudsLinkBattery(battery));
        this._bluez = new BluezClient((type, device, value) => this._onBluez(type, device, value));
        this._nearby = new NearbyWatcher({
            presenter: this._presenter,
            devices: () => [...this._watchers.values()].map(w => ({
                path: w.device.path, alias: w.device.alias, connected: w.device.connected,
                patterns: namePatterns(w.device),
            })),
            nameAt: path => this._bluez.nameAt(path),
            connect: device => this._bluez.connectClassic(device),
            cooldownMs: this._settings.get_int('nearby-cooldown-seconds') * 1000,
        });
        this._advmon = new AdvertisementMonitors({
            onFound: path => this._nearby.onDeviceFound(path),
            rssi: this._rssi(),
        });

        this._settings.connectObject('changed', (_s, key) => this._onSettingChanged(key), this);
        this._budslink.start().finally(() => this._bluez?.start());

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME,
            Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._settings.disconnectObject(this);
        for (const w of this._watchers.values())
            w.destroy();
        for (const id of this._timerIds)
            GLib.source_remove(id);
        this._timerIds.clear();
        this._advmon.stop();
        this._bluez.stop();
        this._budslink.stop();
        this._popups.destroy();
        if (this._nameId)
            Gio.bus_unown_name(this._nameId);
        this._nameId = 0;
        this._dbus.unexport();
        this._watchers.clear();
        this._dbus = this._popups = this._presenter = this._bluez = this._budslink = null;
        this._nearby = this._advmon = this._settings = this._watchers = this._timer = this._timerIds = null;
    }

    // ---- what to show ----

    _createPresenter() {
        const popups = this._popups;
        return {
            connected: (device, battery, replaces) => {
                const card = {kind: 'connected', title: device.alias, subtitle: 'Connected', battery};
                // Battery updates only refresh a card/notification that's still there.
                return replaces ? popups.update(card, replaces) : popups.show(card);
            },
            disconnected: device => popups.show({kind: 'disconnected', title: device.alias, subtitle: 'Disconnected'}),
            lowBattery: (device, battery) =>
                popups.show({kind: 'low-battery', title: device.alias, subtitle: 'Battery low', battery}),
            nearby: (device, onConnect, replaces) => popups.show({
                kind: 'nearby', title: device.alias, subtitle: 'Nearby — not connected',
                buttons: [{id: 'connect', label: 'Connect'}, {id: 'dismiss', label: 'Dismiss'}],
            }, {connect: onConnect}, replaces),
            connectFailed: (device, error, replaces) =>
                popups.show({kind: 'error', title: device.alias, subtitle: `Couldn't connect: ${error}`}, {}, replaces),
            close: handle => popups.close(handle),
        };
    }

    // ---- BlueZ events ----

    _onBluez(type, device, value) {
        const watcher = device ? this._watchers.get(device.path) : null;
        switch (type) {
        case 'ready':
            this._bluezReady = true;
            this._refresh(true);
            this._welcome();
            break;
        case 'vanished':
            this._bluezReady = false;
            this._advmon.stop();
            for (const [path, w] of this._watchers) {
                w.sync(false, null);
                this._budslink.release(path);
            }
            break;
        case 'added':
        case 'changed':
        case 'removed':
            if (device.paired || watcher)
                this._scheduleRefresh();
            break;
        case 'connected':
            if (watcher) {
                // BlueZ may keep Battery1 across a reconnect without re-announcing it.
                if (value)
                    watcher.onBluezBattery(device.battery);
                watcher.onConnectedChanged(value);
                this._nearby.onConnectedChanged(device, value);
                this._holdBudsLink(device, value);
            }
            break;
        case 'battery':
            watcher?.onBluezBattery(value);
            break;
        }
    }

    _isWatched(device) {
        const address = device.address.toUpperCase();
        if (this._settings.get_strv('excluded-devices').includes(address))
            return false;
        return isHeadset(device) || this._settings.get_strv('included-devices').includes(address);
    }

    _scheduleRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._refreshId = 0;
            this._refresh(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Sync watchers with the paired, watched devices. resync: adopt every device's state again
    // (after BlueZ (re)appeared, device objects are new).
    _refresh(resync) {
        if (!this._bluezReady)
            return;
        const watched = new Map(this._bluez.pairedAudioDevices()
            .filter(d => this._isWatched(d)).map(d => [d.path, d]));

        for (const [path, w] of this._watchers) {
            if (!watched.has(path)) {
                w.destroy();
                this._watchers.delete(path);
                this._budslink.release(path);
                this._nearby.forget(path);
            }
        }
        for (const [path, device] of watched) {
            let w = this._watchers.get(path);
            const isNew = !w;
            if (isNew) {
                w = new ConnectionWatcher(device, this._presenter, {...this._thresholds(), timer: this._timer});
                this._watchers.set(path, w);
            }
            w.device = device;
            if (isNew || resync) {
                w.sync(device.connected, device.battery);
                this._holdBudsLink(device, device.connected);
            }
        }
        this._updateNearby();
    }

    _holdBudsLink(device, connected) {
        if (connected && this._settings.get_boolean('use-budslink'))
            this._budslink.hold(device.path);
        else
            this._budslink.release(device.path);
    }

    _hardwareAdapter() {
        return [...this._bluez.adapters.values()].find(a => supportsHardwareFiltering(a)) ?? null;
    }

    _updateNearby() {
        const adapter = this._hardwareAdapter();
        if (!this._settings.get_boolean('nearby-enabled') || !adapter) {
            this._advmon.stop();
            return;
        }
        const names = [...new Set([...this._watchers.values()].flatMap(w => namePatterns(w.device)))];
        this._advmon.update(adapter.path, names).catch(e =>
            console.warn(`buds-notifier: nearby monitors: ${e.message}`));
    }

    _welcome() {
        if (this._settings.get_boolean('welcome-shown'))
            return;
        this._settings.set_boolean('welcome-shown', true);
        const names = [...this._watchers.values()].map(w => w.device.alias);
        this._popups.show({
            kind: 'info',
            title: 'Buds Notifier is ready',
            subtitle: names.length ? `Watching ${names.join(', ')}` : 'No paired earbuds yet',
            body: names.length ? '' : 'Pair your earbuds in Settings → Bluetooth; they are picked up automatically.',
        });
    }

    // ---- settings ----

    _thresholds() {
        return {
            lowPercent: this._settings.get_int('low-battery-percent'),
            rearmPercent: this._settings.get_int('low-battery-rearm-percent'),
        };
    }

    _rssi() {
        return {found: this._settings.get_int('nearby-rssi-found'), lost: this._settings.get_int('nearby-rssi-lost')};
    }

    _onSettingChanged(key) {
        switch (key) {
        case 'low-battery-percent':
        case 'low-battery-rearm-percent': {
            const {lowPercent, rearmPercent} = this._thresholds();
            for (const w of this._watchers.values())
                w.setThresholds(lowPercent, rearmPercent);
            break;
        }
        case 'nearby-cooldown-seconds':
            this._nearby.cooldownMs = this._settings.get_int(key) * 1000;
            break;
        case 'nearby-rssi-found':
        case 'nearby-rssi-lost':
        case 'nearby-enabled':
            this._advmon.rssi = this._rssi();
            this._advmon.stop();
            this._updateNearby();
            break;
        case 'excluded-devices':
        case 'included-devices':
            this._refresh(false);
            break;
        case 'use-budslink':
            for (const w of this._watchers.values()) {
                this._holdBudsLink(w.device, w.device.connected);
                if (!this._settings.get_boolean(key))
                    w.onBudsLinkBattery(null);
            }
            break;
        }
    }

    // ---- D-Bus API ----

    Show(cardJson) {
        if (!this._settings.get_boolean('developer-api'))
            return 0;
        try {
            return this._popups.showCard(JSON.parse(cardJson));
        } catch (e) {
            console.warn(`buds-notifier: invalid card JSON: ${e.message}`);
            return 0;
        }
    }

    Close(id) {
        if (this._settings.get_boolean('developer-api'))
            this._popups.closeCard(id);
    }

    Activate(id, action) {
        return this._settings.get_boolean('developer-api') && this._popups.activate(id, action);
    }

    ShowTestCard() {
        this._popups.show({
            kind: 'connected', title: 'Test earbuds', subtitle: 'Connected',
            battery: {slots: [
                {key: 'left', label: 'Left', level: 80, charging: false},
                {key: 'right', label: 'Right', level: 64, charging: false},
                {key: 'case', label: 'Case', level: 45, charging: true}]},
        });
    }

    Status() {
        const adapter = this._hardwareAdapter();
        return JSON.stringify({
            bluez: this._bluezReady,
            cardsAllowed: this._popups.canShowCards,
            devices: this._bluez.pairedAudioDevices().map(d => ({
                alias: d.alias,
                address: d.address,
                icon: d.icon,
                connected: d.connected,
                watched: this._watchers.has(d.path),
                headset: isHeadset(d),
                battery: this._watchers.has(d.path) ? batteryText(this._watchers.get(d.path).battery) : null,
            })),
            nearby: {
                enabled: this._settings.get_boolean('nearby-enabled'),
                hardwareFiltering: Boolean(adapter),
                adapters: [...this._bluez.adapters.values()].map(a => ({path: a.path, features: a.advmonFeatures})),
                patterns: this._advmon.patterns,
            },
            budslink: {installed: this._budslink.installed, enabled: this._settings.get_boolean('use-budslink')},
            recent: this._popups.history,
        });
    }

    _emit(signal, id, value) {
        this._dbus?.emit_signal(signal, new GLib.Variant('(us)', [id, value]));
    }
}
