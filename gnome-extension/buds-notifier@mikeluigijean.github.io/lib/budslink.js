// BudsLink client (session bus): per-bud and case battery for many earbuds brands.
//
// BudsLink only talks to the buds while some client holds it (HoldService + heartbeat), so we
// hold it only while at least one watched headset is connected. Its device paths mirror
// BlueZ's: /org/bluez/hci0/dev_X -> /io/github/maniacx/BudsLink/Devices/hci0/dev_X.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseBudsLink} from './battery.js';

const BUDSLINK = 'io.github.maniacx.BudsLink';
const MANAGER_PATH = '/io/github/maniacx/BudsLink';
const MANAGER_IFACE = 'io.github.maniacx.BudsLink.DeviceManager';
const DEVICE_IFACE = 'io.github.maniacx.BudsLink.Device';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const CLIENT_ID = 'buds-notifier@mikeluigijean.github.io';
const HEARTBEAT_SECONDS = 120;
const DEVICE_PREFIX = `${MANAGER_PATH}/Devices/`;

function budsLinkPath(bluezPath) {
    return DEVICE_PREFIX + bluezPath.replace(/^\/org\/bluez\//, '');
}

function bluezPath(budslinkPath) {
    return `/org/bluez/${budslinkPath.slice(DEVICE_PREFIX.length)}`;
}

export class BudsLinkClient {
    // onBattery(bluezDevicePath, battery|null)
    constructor(onBattery) {
        this._onBattery = onBattery;
        this._bus = Gio.DBus.session;
        this._held = new Set();       // bluez paths we hold BudsLink for
        this._heartbeatId = 0;
        this._subscriptions = [];
        this.installed = false;
    }

    async start() {
        const sub = (iface, member, cb) => this._subscriptions.push(this._bus.signal_subscribe(
            BUDSLINK, iface, member, null, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, path, _i, _m, params) => cb(path, params.recursiveUnpack())));
        sub(PROPERTIES, 'PropertiesChanged', (path, [iface, changed]) => {
            if (iface === DEVICE_IFACE && 'State' in changed && path.startsWith(DEVICE_PREFIX)) {
                const bluez = bluezPath(path);
                if (this._held.has(bluez))
                    this.read(bluez).then(b => this._onBattery(bluez, b));
            }
        });
        sub(MANAGER_IFACE, 'DeviceAdded', (_p, [path]) => {
            const bluez = bluezPath(path);
            if (this._held.has(bluez))
                this.read(bluez).then(b => this._onBattery(bluez, b));
        });

        try {
            const [names] = (await this._call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListActivatableNames', null)).recursiveUnpack();
            this.installed = names.includes(BUDSLINK);
        } catch {
            this.installed = false;
        }
    }

    stop() {
        for (const id of this._subscriptions)
            this._bus.signal_unsubscribe(id);
        this._subscriptions = [];
        this._releaseAll();
    }

    // Hold BudsLink while the headset is connected; D-Bus activates it if needed.
    hold(devicePath) {
        if (!this.installed)
            return;
        const first = this._held.size === 0;
        this._held.add(devicePath);
        if (first) {
            this._manager('HoldService');
            this._heartbeatId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HEARTBEAT_SECONDS, () => {
                this._manager('HoldService');
                return GLib.SOURCE_CONTINUE;
            });
        }
        this.read(devicePath).then(b => this._onBattery(devicePath, b));
    }

    release(devicePath) {
        if (!this._held.delete(devicePath) || this._held.size)
            return;
        this._releaseAll();
    }

    _releaseAll() {
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = 0;
            this._manager('ReleaseService');
        }
        this._held.clear();
    }

    async read(devicePath) {
        if (!this.installed)
            return null;
        try {
            const path = budsLinkPath(devicePath);
            const [props] = (await this._call(BUDSLINK, path, PROPERTIES, 'GetAll',
                new GLib.Variant('(s)', [DEVICE_IFACE]))).recursiveUnpack();
            return parseBudsLink(props.State, props.Config);
        } catch {
            return null;  // BudsLink doesn't know (or doesn't support) this device (yet)
        }
    }

    _manager(method) {
        this._call(BUDSLINK, MANAGER_PATH, MANAGER_IFACE, method, new GLib.Variant('(s)', [CLIENT_ID]))
            .catch(e => console.debug(`buds-notifier: BudsLink ${method}: ${e.message}`));
    }

    _call(name, path, iface, method, params) {
        return new Promise((resolve, reject) => {
            this._bus.call(name, path, iface, method, params, null, Gio.DBusCallFlags.NONE, 10000, null,
                (bus, res) => {
                    try {
                        resolve(bus.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
