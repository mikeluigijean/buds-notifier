// BlueZ client (system bus): paired audio devices, connection, battery, advertised names,
// classic (BR/EDR) connect. Only Gio/GLib, so it also runs under plain gjs.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BLUEZ = 'org.bluez';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const ADAPTER = 'org.bluez.Adapter1';
const DEVICE = 'org.bluez.Device1';
const BATTERY = 'org.bluez.Battery1';
export const ADVMON_MANAGER = 'org.bluez.AdvertisementMonitorManager1';
const A2DP_SINK = '0000110b-0000-1000-8000-00805f9b34fb';

const HEADSET_ICONS = new Set(['audio-headset', 'audio-headphones']);

function unpack(variant) {
    return variant.recursiveUnpack();
}

// A device worth watching by default: earbuds, headsets, headphones (not speakers).
export function isHeadset(device) {
    return HEADSET_ICONS.has(device.icon);
}

export function isAudio(device) {
    return device.icon?.startsWith('audio-') || device.uuids.includes(A2DP_SINK);
}

function makeDevice(path, props) {
    return {
        path,
        address: props.Address ?? '',
        addressType: props.AddressType ?? '',
        alias: props.Alias ?? props.Address ?? path,
        name: props.Name ?? null,
        paired: Boolean(props.Paired),
        connected: Boolean(props.Connected),
        icon: props.Icon ?? null,
        uuids: props.UUIDs ?? [],
        adapter: props.Adapter ?? null,
        battery: null,
    };
}

export class BluezClient {
    // onEvent(type, device|null, value): 'added', 'removed', 'changed' (alias/paired/icon/name),
    // 'connected' (value: bool), 'battery' (value: level|null), 'ready', 'vanished'
    constructor(onEvent) {
        this._onEvent = onEvent;
        this._bus = Gio.DBus.system;
        this.devices = new Map();      // path -> device (every Device1, incl. random-address LE entries)
        this.adapters = new Map();     // path -> {path, advmonFeatures: [] | null}
        this._subscriptions = [];
        this._cancellable = new Gio.Cancellable();
    }

    start() {
        const sub = (iface, member, cb) => this._subscriptions.push(this._bus.signal_subscribe(
            BLUEZ, iface, member, null, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, path, _i, _m, params) => cb(path, params)));
        sub(OBJECT_MANAGER, 'InterfacesAdded', (_p, params) => {
            const [path, ifaces] = unpack(params);
            this._addInterfaces(path, ifaces, true);
        });
        sub(OBJECT_MANAGER, 'InterfacesRemoved', (_p, params) => {
            const [path, ifaces] = unpack(params);
            this._removeInterfaces(path, ifaces);
        });
        sub(PROPERTIES, 'PropertiesChanged', (path, params) => {
            const [iface, changed] = unpack(params);
            this._onPropertiesChanged(path, iface, changed);
        });
        this._watchId = Gio.bus_watch_name_on_connection(this._bus, BLUEZ,
            Gio.BusNameWatcherFlags.NONE, () => this._load(), () => this._vanished());
    }

    stop() {
        this._cancellable.cancel();
        if (this._watchId)
            Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        for (const id of this._subscriptions)
            this._bus.signal_unsubscribe(id);
        this._subscriptions = [];
        this.devices.clear();
        this.adapters.clear();
    }

    pairedAudioDevices() {
        return [...this.devices.values()].filter(d => d.paired && isAudio(d));
    }

    nameAt(path) {
        return this.devices.get(path)?.name ?? null;
    }

    // Connect the music profile explicitly: Device1.Connect() on dual-mode earbuds can pick
    // the LE bearer and fail (le-connection-abort-by-local).
    async connectClassic(device) {
        const current = this.devices.get(device.path);
        if (!current?.paired || current.addressType !== 'public')
            throw new Error('not a paired device with a public address');
        await this._call(device.path, DEVICE, 'ConnectProfile', new GLib.Variant('(s)', [A2DP_SINK]), 30000);
    }

    async _load() {
        let objects;
        try {
            const reply = await this._call('/', OBJECT_MANAGER, 'GetManagedObjects', null);
            [objects] = unpack(reply);
        } catch (e) {
            console.warn(`buds-notifier: BlueZ GetManagedObjects failed: ${e.message}`);
            return;
        }
        for (const [path, ifaces] of Object.entries(objects))
            this._addInterfaces(path, ifaces, false);
        this._onEvent('ready', null, null);
    }

    _vanished() {
        const hadDevices = this.devices.size > 0;
        this.devices.clear();
        this.adapters.clear();
        if (hadDevices)
            this._onEvent('vanished', null, null);
    }

    _addInterfaces(path, ifaces, notify) {
        if (ifaces[ADAPTER]) {
            this.adapters.set(path, {path, advmonFeatures: ifaces[ADVMON_MANAGER]?.SupportedFeatures ?? null});
        } else if (ifaces[ADVMON_MANAGER] && this.adapters.has(path)) {
            this.adapters.get(path).advmonFeatures = ifaces[ADVMON_MANAGER].SupportedFeatures ?? [];
        }
        if (ifaces[DEVICE]) {
            const device = makeDevice(path, ifaces[DEVICE]);
            device.battery = ifaces[BATTERY]?.Percentage ?? null;
            this.devices.set(path, device);
            if (notify)
                this._onEvent('added', device, null);
        } else if (ifaces[BATTERY] && this.devices.has(path)) {
            const device = this.devices.get(path);
            device.battery = ifaces[BATTERY].Percentage ?? null;
            this._onEvent('battery', device, device.battery);
        }
    }

    _removeInterfaces(path, ifaces) {
        const device = this.devices.get(path);
        if (ifaces.includes(DEVICE)) {
            this.devices.delete(path);
            if (device)
                this._onEvent('removed', device, null);
        } else if (ifaces.includes(BATTERY) && device) {
            device.battery = null;
            this._onEvent('battery', device, null);
        }
        if (ifaces.includes(ADAPTER))
            this.adapters.delete(path);
    }

    _onPropertiesChanged(path, iface, changed) {
        const device = this.devices.get(path);
        if (iface === BATTERY && device && 'Percentage' in changed) {
            device.battery = changed.Percentage;
            this._onEvent('battery', device, device.battery);
            return;
        }
        if (iface === ADVMON_MANAGER && this.adapters.has(path) && 'SupportedFeatures' in changed) {
            this.adapters.get(path).advmonFeatures = changed.SupportedFeatures;
            return;
        }
        if (iface !== DEVICE || !device)
            return;

        if ('Name' in changed)
            device.name = changed.Name;
        let identityChanged = false;
        for (const [prop, key] of [['Alias', 'alias'], ['Paired', 'paired'], ['Icon', 'icon'],
            ['UUIDs', 'uuids'], ['AddressType', 'addressType'], ['Name', 'name']]) {
            if (prop in changed) {
                device[key] = changed[prop];
                identityChanged = true;
            }
        }
        if (identityChanged)
            this._onEvent('changed', device, null);
        if ('Connected' in changed && Boolean(changed.Connected) !== device.connected) {
            device.connected = Boolean(changed.Connected);
            this._onEvent('connected', device, device.connected);
        }
    }

    _call(path, iface, method, params, timeout = -1) {
        return new Promise((resolve, reject) => {
            this._bus.call(BLUEZ, path, iface, method, params, null,
                Gio.DBusCallFlags.NONE, timeout, this._cancellable, (bus, res) => {
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
