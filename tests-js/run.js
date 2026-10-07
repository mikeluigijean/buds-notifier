// Unit tests for the extension's pure-JS modules.  Run:  gjs -m tests-js/run.js
import GLib from 'gi://GLib';

const EXT = '../gnome-extension/buds-notifier@mikeluigijean.github.io/lib';
const battery = await import(`${EXT}/battery.js`);
const patterns = await import(`${EXT}/patterns.js`);
const {ConnectionWatcher, UPDATE_WINDOW_MS, BATTERY_WAIT_MS} = await import(`${EXT}/connectionWatcher.js`);
const {NearbyWatcher} = await import(`${EXT}/nearbyWatcher.js`);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function eq(actual, expected, msg = '') {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg}\n  expected ${e}\n  got      ${a}`);
}

// ---------- battery ----------
const GALAXY_CONFIG = JSON.stringify({battery1Icon: 'earbuds-stem-left',
    battery2Icon: 'earbuds-stem-right', battery3Icon: 'case-normal'});
// Shape observed from BudsLink 0.2.1 with Galaxy Buds3 Pro (buds out of the case).
const GALAXY_STATE = {battery1Level: 61, battery1Status: 'discharging',
    battery2Level: 44, battery2Status: 'discharging',
    battery3Level: 0, battery3Status: 'disconnected'};

test('parse observed Galaxy state', () => {
    eq(battery.parseBudsLink(JSON.stringify(GALAXY_STATE), GALAXY_CONFIG), {slots: [
        {key: 'left', label: 'Left', level: 61, charging: false},
        {key: 'right', label: 'Right', level: 44, charging: false}]});
});
test('parse charging case', () => {
    const state = {...GALAXY_STATE, battery3Level: 80, battery3Status: 'charging'};
    eq(battery.parseBudsLink(JSON.stringify(state), GALAXY_CONFIG).slots[2],
        {key: 'case', label: 'Case', level: 80, charging: true});
});
test('parse single-battery headphones', () => {
    const state = {battery1Level: 70, battery1Status: 'discharging', battery2Status: 'not-reported'};
    eq(battery.parseBudsLink(JSON.stringify(state), JSON.stringify({battery1Icon: 'headphones'})),
        {slots: [{key: 'other', label: 'Battery', level: 70, charging: false}]});
});
test('parse garbage / nothing reported', () => {
    eq(battery.parseBudsLink('nope', null), null);
    eq(battery.parseBudsLink(JSON.stringify({battery1Status: 'not-reported'}), '{}'), null);
});
test('lowest level excludes case', () => {
    const b = {slots: [{key: 'left', level: 61}, {key: 'right', level: 44}, {key: 'case', level: 5}]};
    eq(battery.lowestLevel(b), 44);
    eq(battery.lowestLevel(battery.fromSingle(30)), 30);
    eq(battery.lowestLevel({slots: [{key: 'case', level: 5}]}), null);
});
test('battery text', () => {
    eq(battery.batteryText({slots: [{label: 'Left', level: 61}, {label: 'Right', level: 44, charging: true}]}),
        'Left 61% · Right 44% (charging)');
    eq(battery.batteryText(null), 'Battery: unknown');
});

// ---------- patterns ----------
test('patterns from alias and name, deduped, length limits', () => {
    eq(patterns.namePatterns({alias: "Alice's Buds3 Pro", name: "Alice's Buds3 Pro"}), ["Alice's Buds3 Pro"]);
    eq(patterns.namePatterns({alias: 'My buds', name: 'Galaxy Buds3 Pro (EEFF)'}),
        ['My buds', 'Galaxy Buds3 Pro (EEFF)']);
    eq(patterns.namePatterns({alias: 'Buds', name: 'x'.repeat(40)}), []);
});
test('matching is prefix based', () => {
    eq(patterns.matchesDevice('Galaxy Buds3 Pro (EEFF) LE', ['Galaxy Buds3 Pro (EEFF)']), true);
    eq(patterns.matchesDevice('Galaxy Buds3 Pro (1234) LE', ['Galaxy Buds3 Pro (EEFF)']), false);
    eq(patterns.matchesDevice(null, ['x']), false);
});

// ---------- connection watcher ----------
class FakePresenter {
    constructor() { this.calls = []; this.closed = []; this._n = 1; }
    _rec(event, replaces, data) {
        const handle = replaces ?? `h${this._n++}`;
        this.calls.push({event, handle, replaces, ...data});
        return handle;
    }
    connected(device, battery, replaces) { return this._rec('connected', replaces, {battery}); }
    disconnected(device) { return this._rec('disconnected', null, {}); }
    lowBattery(device, battery) { return this._rec('lowBattery', null, {battery}); }
    nearby(device, onConnect, replaces) { return this._rec('nearby', replaces, {device: device.path, onConnect}); }
    connectFailed(device, error, replaces) { return this._rec('connectFailed', replaces, {error}); }
    close(handle) { this.closed.push(handle); }
    events(e) { return this.calls.filter(c => c.event === e); }
}
const DEV = {path: '/org/bluez/hci0/dev_AA', alias: 'Buds'};
const lr = (l, r, c) => ({slots: [{key: 'left', label: 'Left', level: l, charging: false},
    {key: 'right', label: 'Right', level: r, charging: false},
    ...(c === undefined ? [] : [{key: 'case', label: 'Case', level: c, charging: false}])]});

function connHarness() {
    const h = {now: 1000, presenter: new FakePresenter()};
    h.watcher = new ConnectionWatcher(DEV, h.presenter, {lowPercent: 15, rearmPercent: 20, now: () => h.now});
    return h;
}

test('sync is silent', () => {
    const h = connHarness();
    h.watcher.sync(true, 50);
    eq(h.presenter.calls.length, 0);
});
test('connect shows bluez battery', () => {
    const h = connHarness();
    h.watcher.onBluezBattery(71);
    h.watcher.onConnectedChanged(true);
    eq(h.presenter.events('connected')[0].battery, battery.fromSingle(71));
});
test('battery known before reconnect is shown on the connected card', () => {
    const h = connHarness();
    h.watcher.sync(true, 70);
    h.watcher.onConnectedChanged(false);
    h.watcher.onBluezBattery(70);  // what the extension passes in from BlueZ on reconnect
    h.watcher.onConnectedChanged(true);
    eq(h.presenter.events('connected')[0].battery, battery.fromSingle(70));
});
test('budslink preferred; case-only budslink falls back to bluez', () => {
    const h = connHarness();
    h.watcher.onBluezBattery(44);
    h.watcher.onBudsLinkBattery({slots: [{key: 'case', level: 80}]});
    eq(h.watcher.battery, battery.fromSingle(44));
    h.watcher.onBudsLinkBattery(lr(61, 44));
    eq(h.watcher.battery, lr(61, 44));
});
test('battery soon after connect updates same popup, later does not', () => {
    const h = connHarness();
    h.watcher.onConnectedChanged(true);
    h.now += 3000;
    h.watcher.onBudsLinkBattery(lr(61, 44, 80));
    const [first, second] = h.presenter.events('connected');
    eq(second.replaces, first.handle);
    h.now += UPDATE_WINDOW_MS;
    h.watcher.onBluezBattery(40);
    eq(h.presenter.events('connected').length, 2);
});
test('duplicate state ignored; disconnect clears battery', () => {
    const h = connHarness();
    h.watcher.onConnectedChanged(false);
    h.watcher.onConnectedChanged(true);
    h.watcher.onConnectedChanged(true);
    h.watcher.onConnectedChanged(false);
    eq(h.presenter.calls.map(c => c.event), ['connected', 'disconnected']);
    eq(h.watcher.battery, null);
});
test('low battery: lowest bud, hysteresis, case ignored', () => {
    const h = connHarness();
    h.watcher.sync(true, null, lr(60, 30, 50));
    h.watcher.onBudsLinkBattery(lr(60, 14, 50));  // warn
    h.watcher.onBudsLinkBattery(lr(59, 12, 50));
    h.watcher.onBudsLinkBattery(lr(59, 16, 50));  // between thresholds
    h.watcher.onBudsLinkBattery(lr(58, 13, 5));   // case low: irrelevant
    eq(h.presenter.events('lowBattery').length, 1);
    h.watcher.onBudsLinkBattery(lr(58, 20, 5));   // re-arm
    h.watcher.onBudsLinkBattery(lr(58, 14, 5));
    eq(h.presenter.events('lowBattery').length, 2);
});
test('low battery at connect and after reconnect', () => {
    const h = connHarness();
    h.watcher.onBluezBattery(10);
    h.watcher.onConnectedChanged(true);
    h.watcher.onConnectedChanged(false);
    h.watcher.onBluezBattery(10);
    h.watcher.onConnectedChanged(true);
    eq(h.presenter.calls.map(c => c.event),
        ['connected', 'lowBattery', 'disconnected', 'connected', 'lowBattery']);
});

class FakeTimer {
    constructor() { this.pending = new Map(); this._n = 1; }
    add(ms, cb) { const id = this._n++; this.pending.set(id, {ms, cb}); return id; }
    remove(id) { this.pending.delete(id); }
    fire() { for (const [id, {cb}] of [...this.pending]) { this.pending.delete(id); cb(); } }
}
function waitHarness() {
    const h = {now: 1000, presenter: new FakePresenter(), timer: new FakeTimer()};
    h.watcher = new ConnectionWatcher(DEV, h.presenter,
        {lowPercent: 15, rearmPercent: 20, now: () => h.now, timer: h.timer});
    return h;
}
test('connected card waits for the battery, shown as soon as it arrives', () => {
    const h = waitHarness();
    h.watcher.onConnectedChanged(true);
    eq(h.presenter.calls.length, 0);
    eq([...h.timer.pending.values()][0].ms, BATTERY_WAIT_MS);
    h.watcher.onBudsLinkBattery({slots: [{key: 'case', label: 'Case', level: 50}]});  // case only
    eq(h.presenter.calls.length, 0);
    h.watcher.onBluezBattery(78);
    eq(h.presenter.events('connected')[0].battery, battery.fromSingle(78));
    eq(h.timer.pending.size, 0);
});
test('connected card shown without battery after the wait', () => {
    const h = waitHarness();
    h.watcher.onConnectedChanged(true);
    h.timer.fire();
    eq(h.presenter.events('connected')[0].battery, null);
});
test('disconnect during the wait cancels the connected card', () => {
    const h = waitHarness();
    h.watcher.onConnectedChanged(true);
    h.watcher.onConnectedChanged(false);
    eq(h.timer.pending.size, 0);
    eq(h.presenter.calls.map(c => c.event), ['disconnected']);
});

// ---------- nearby watcher ----------
const NAMES = {'/le1': "Alice's Buds3 Pro", '/le2': 'Galaxy Buds3 Pro (EEFF) LE',
    '/generic': 'Buds3 Pro', '/other': 'Galaxy Buds3 Pro (1234) LE', '/bob': "Bob's Buds"};

function nearbyHarness() {
    const h = {now: 1000, presenter: new FakePresenter(), connects: [], connectError: null,
        devices: [
            {path: '/dev_alice', alias: "Alice's Buds3 Pro", connected: false,
                patterns: ["Alice's Buds3 Pro", 'Galaxy Buds3 Pro (EEFF)']},
            {path: '/dev_bob', alias: "Bob's Buds", connected: true, patterns: ["Bob's Buds"]},
        ]};
    h.watcher = new NearbyWatcher({
        presenter: h.presenter, devices: () => h.devices, nameAt: p => NAMES[p] ?? null,
        connect: async d => {
            h.connects.push(d.path);
            if (h.connectError)
                throw new Error(h.connectError);
        },
        cooldownMs: 60000, now: () => h.now,
    });
    return h;
}

test('nearby: matching names, ignoring strangers and connected devices', () => {
    const h = nearbyHarness();
    eq(h.watcher.onDeviceFound('/le1')?.path, '/dev_alice');
    for (const p of ['/generic', '/other', '/unknown', '/bob'])
        eq(h.watcher.onDeviceFound(p), null, p);
    eq(h.presenter.events('nearby').length, 1);
});
test('nearby: cooldown per device, then replaces previous', () => {
    const h = nearbyHarness();
    h.watcher.onDeviceFound('/le1');
    h.watcher.onDeviceFound('/le2');
    eq(h.presenter.events('nearby').length, 1);
    h.now += 61000;
    h.watcher.onDeviceFound('/le2');
    const [a, b] = h.presenter.events('nearby');
    eq(b.replaces, a.handle);
});
test('nearby: connect error ignored when the headset got connected anyway', async () => {
    const h = nearbyHarness();
    h.watcher.onDeviceFound('/le1');
    h.connectError = 'br-connection-refused';
    h.devices[0].connected = true;  // buds reconnected by themselves meanwhile
    await h.presenter.events('nearby')[0].onConnect();
    eq(h.presenter.events('connectFailed').length, 0);
});
test('nearby: connect success silent, failure shown, connected closes', async () => {
    const h = nearbyHarness();
    h.watcher.onDeviceFound('/le1');
    await h.presenter.events('nearby')[0].onConnect();
    eq(h.connects, ['/dev_alice']);
    eq(h.presenter.events('connectFailed').length, 0);
    h.connectError = 'br-connection-page-timeout';
    await h.presenter.events('nearby')[0].onConnect();
    eq(h.presenter.events('connectFailed')[0].error, 'br-connection-page-timeout');
    h.watcher.onConnectedChanged(h.devices[0], true);
    eq(h.presenter.closed.length, 1);
});

// ---------- run ----------
let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
print(`\n${tests.length - failed}/${tests.length} passed`);
if (failed)
    imports.system.exit(1);
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => GLib.SOURCE_REMOVE);
