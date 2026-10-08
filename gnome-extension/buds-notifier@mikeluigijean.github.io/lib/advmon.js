// BlueZ advertisement monitors (system bus): the Bluetooth chip filters LE advertisements in
// hardware and BlueZ calls DeviceFound for matches. Only used with controller-patterns
// support — never falls back to continuous software scanning.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ADVMON_MANAGER} from './bluez.js';
import {patternBytes} from './patterns.js';

const APP_PATH = '/io/github/mikeluigijean/BudsNotifier/advmon';
const MONITOR_IFACE = 'org.bluez.AdvertisementMonitor1';
const AD_TYPE_COMPLETE_NAME = 0x09;
// "Adv Monitor Manager created with ... max number of supported patterns:16" (AX201).
const MAX_PATTERNS = 16;

const OBJECT_MANAGER_XML = `<node>
  <interface name="org.freedesktop.DBus.ObjectManager">
    <method name="GetManagedObjects">
      <arg type="a{oa{sa{sv}}}" direction="out"/>
    </method>
  </interface>
</node>`;

const MONITOR_XML = `<node>
  <interface name="${MONITOR_IFACE}">
    <method name="Release"/>
    <method name="Activate"/>
    <method name="DeviceFound"><arg type="o" direction="in"/></method>
    <method name="DeviceLost"><arg type="o" direction="in"/></method>
  </interface>
</node>`;

export function supportsHardwareFiltering(adapter) {
    return (adapter?.advmonFeatures ?? []).includes('controller-patterns');
}

export class AdvertisementMonitors {
    // onFound(advertiserPath); rssi: {found, lost} in dBm
    constructor({onFound, rssi}) {
        this._onFound = onFound;
        this.rssi = rssi;
        this._bus = Gio.DBus.system;
        this._monitors = [];       // [{exported, path, pattern}]
        this._manager = null;
        this._adapterPath = null;
        this._registered = false;
    }

    // Replace the watched names. One monitor per name: the AX201 rejects monitors whose
    // patterns add up to more than about one name (MGMT status 0x0d).
    async update(adapterPath, names) {
        names = names.slice(0, MAX_PATTERNS);
        const same = adapterPath === this._adapterPath &&
            JSON.stringify(names) === JSON.stringify(this._monitors.map(m => m.pattern));
        if (same && this._registered)
            return;
        this.stop();
        if (!adapterPath || !names.length)
            return;

        this._adapterPath = adapterPath;
        names.forEach((pattern, i) => {
            const path = `${APP_PATH}/monitor${i}`;
            const exported = Gio.DBusExportedObject.wrapJSObject(MONITOR_XML, {
                Release: () => console.debug(`buds-notifier: monitor ${i} released`),
                Activate: () => console.debug(`buds-notifier: monitor ${i} active`),
                DeviceFound: device => this._onFound(device),
                DeviceLost: () => {},
            });
            exported.export(this._bus, path);
            this._monitors.push({exported, path, pattern});
        });
        this._manager = Gio.DBusExportedObject.wrapJSObject(OBJECT_MANAGER_XML, {
            GetManagedObjects: () => this._managedObjects(),
        });
        this._manager.export(this._bus, APP_PATH);

        try {
            await this._call('RegisterMonitor');
            this._registered = true;
        } catch (e) {
            console.warn(`buds-notifier: RegisterMonitor failed: ${e.message}`);
            this.stop();
        }
    }

    // Synchronous so disable() leaves nothing exported. D-Bus keeps per-connection message
    // order, so a following RegisterMonitor reaches BlueZ after this UnregisterMonitor.
    stop() {
        if (this._registered) {
            this._registered = false;
            this._call('UnregisterMonitor').catch(e =>
                console.debug(`buds-notifier: UnregisterMonitor: ${e.message}`));
        }
        for (const m of this._monitors)
            m.exported.unexport();
        this._monitors = [];
        this._manager?.unexport();
        this._manager = null;
        this._adapterPath = null;
    }

    get patterns() {
        return this._monitors.map(m => m.pattern);
    }

    _managedObjects() {
        const objects = {};
        for (const m of this._monitors) {
            objects[m.path] = {
                [MONITOR_IFACE]: {
                    Type: new GLib.Variant('s', 'or_patterns'),
                    Patterns: new GLib.Variant('a(yyay)',
                        [[0, AD_TYPE_COMPLETE_NAME, patternBytes(m.pattern)]]),
                    RSSIHighThreshold: new GLib.Variant('n', this.rssi.found),
                    RSSIHighTimeout: new GLib.Variant('q', 1),
                    RSSILowThreshold: new GLib.Variant('n', this.rssi.lost),
                    RSSILowTimeout: new GLib.Variant('q', 30),
                },
            };
        }
        return objects;
    }

    _call(method) {
        return new Promise((resolve, reject) => {
            this._bus.call('org.bluez', this._adapterPath, ADVMON_MANAGER, method,
                new GLib.Variant('(o)', [APP_PATH]), null, Gio.DBusCallFlags.NONE, -1, null,
                (bus, res) => {
                    try {
                        resolve(bus.call_finish(res));
                    } catch (e) {
                        if (e instanceof GLib.Error)
                            Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                });
        });
    }
}
