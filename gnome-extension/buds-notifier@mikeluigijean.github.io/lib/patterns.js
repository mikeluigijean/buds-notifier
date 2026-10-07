// Which advertised names identify a paired headset when it broadcasts over LE.
// Pure JS (testable with plain gjs).
//
// Headsets usually broadcast the name they were given (the BlueZ Name, or the Alias you set).
// Galaxy Buds also broadcast "<model> (XXXX)" with XXXX = last 4 hex digits of the address.

// The controller rejects patterns much longer than one name (measured on an Intel AX201:
// one 22-byte pattern per monitor works). LE names are at most 29 bytes in a legacy packet.
const MAX_BYTES = 29;
// Short/generic names would match strangers' devices.
const MIN_CHARS = 6;

const encoder = new TextEncoder();

export function namePatterns(device) {
    const names = new Set();
    for (const name of [device.alias, device.name]) {
        if (typeof name === 'string' && name.length >= MIN_CHARS &&
            encoder.encode(name).length <= MAX_BYTES)
            names.add(name);
    }
    return [...names];
}

export function matchesDevice(advertisedName, patterns) {
    return typeof advertisedName === 'string' && patterns.some(p => advertisedName.startsWith(p));
}

export function patternBytes(pattern) {
    return encoder.encode(pattern);
}
