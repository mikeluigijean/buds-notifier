// One headset: connection, battery and low-battery events -> presenter. Pure JS.
import {fromSingle, hasBuds, lowestLevel} from './battery.js';

// Battery details arriving this soon after connecting update the "connected" popup in place.
export const UPDATE_WINDOW_MS = 15000;
// BlueZ reports the battery a few seconds after connecting (~4.6 s measured with Galaxy Buds3
// Pro): wait up to this long so the "connected" popup can show it right away.
export const BATTERY_WAIT_MS = 6000;

export class ConnectionWatcher {
    // presenter: {connected(device, battery, replaces) -> handle, disconnected(device),
    //             lowBattery(device, battery)}
    // timer: {add(ms, callback) -> id, remove(id)}; without it the card is shown immediately.
    constructor(device, presenter, {lowPercent, rearmPercent, now = () => Date.now(), timer = null}) {
        this.device = device;
        this._presenter = presenter;
        this._low = lowPercent;
        this._rearm = rearmPercent;
        this._now = now;
        this._timer = timer;
        this._waitId = null;

        this._connected = false;
        this._bluezLevel = null;   // BlueZ Battery1: one value
        this._budslink = null;     // BudsLink: per-bud (+ case)
        this._lowWarned = false;
        this._handle = null;
        this._connectedAt = 0;
    }

    destroy() {
        this._cancelWait();
    }

    setThresholds(lowPercent, rearmPercent) {
        this._low = lowPercent;
        this._rearm = rearmPercent;
    }

    get connected() {
        return this._connected;
    }

    get battery() {
        if (hasBuds(this._budslink))
            return this._budslink;
        return fromSingle(this._bluezLevel);
    }

    // Adopt current state silently (startup, bluetoothd restart).
    sync(connected, bluezLevel, budslink = null) {
        this._connected = connected;
        this._bluezLevel = connected ? bluezLevel : null;
        this._budslink = connected ? budslink : null;
        this._handle = null;
        this._lowWarned = false;
        if (connected)
            this._checkLow();
    }

    onConnectedChanged(connected) {
        if (connected === this._connected)
            return;
        this._connected = connected;

        if (connected) {
            this._lowWarned = false;
            this._connectedAt = this._now();
            if (this.battery === null && this._timer)
                this._waitId = this._timer.add(BATTERY_WAIT_MS, () => this._showConnected());
            else
                this._showConnected();
        } else {
            this._cancelWait();
            this._bluezLevel = null;
            this._budslink = null;
            this._handle = null;
            this._presenter.disconnected(this.device);
        }
    }

    onBluezBattery(level) {
        this._bluezLevel = level;
        this._batteryChanged();
    }

    onBudsLinkBattery(battery) {
        this._budslink = battery;
        this._batteryChanged();
    }

    _showConnected() {
        this._waitId = null;
        this._handle = this._presenter.connected(this.device, this.battery, null);
        this._checkLow();
    }

    _cancelWait() {
        if (this._waitId !== null) {
            this._timer.remove(this._waitId);
            this._waitId = null;
        }
    }

    _batteryChanged() {
        if (!this._connected)
            return;
        if (this._waitId !== null) {
            if (this.battery === null)
                return;  // e.g. only the case reported so far: keep waiting
            this._cancelWait();
            this._showConnected();
            return;
        }
        if (this._handle && this._now() - this._connectedAt <= UPDATE_WINDOW_MS)
            this._handle = this._presenter.connected(this.device, this.battery, this._handle);
        this._checkLow();
    }

    _checkLow() {
        const battery = this.battery;
        const level = lowestLevel(battery);
        if (level === null)
            return;
        if (level >= this._rearm) {
            this._lowWarned = false;
        } else if (level < this._low && !this._lowWarned) {
            this._lowWarned = true;
            this._presenter.lowBattery(this.device, battery);
        }
    }
}
