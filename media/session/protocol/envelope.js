// Shared host↔app message-protocol core (ADR 0005).
//
// Transport-agnostic, DOM-free primitives that every protocol binding reuses:
// the embed iframe protocol (src/embed/protocol.ts), the read-only viewer
// transport, and the future host-neutral session protocol. Each binding owns its
// own protocol version, message set, and correlation field; this module owns only
// the version-stamped envelope, origin checking, and the shared validators.
export function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/**
 * Whether `value` is a plain JSON value (primitive, or array/plain-object
 * thereof). Exotic structured-cloneable types — `ArrayBuffer`, typed arrays,
 * `Map`, `Set`, `Blob`, `Date`, class instances, functions, symbols — are
 * rejected. `JSON.stringify` collapses those to `"{}"`/`undefined`, which would
 * let a multi-megabyte payload slip an encoded-size limit, so a value crossing
 * the boundary must be genuinely JSON-shaped. Assumes an acyclic input (callers
 * stringify first, which rejects cycles).
 */
export function isPlainJsonValue(value) {
    if (value === null)
        return true;
    const t = typeof value;
    if (t === 'string' || t === 'boolean')
        return true;
    if (t === 'number')
        return Number.isFinite(value);
    if (t !== 'object')
        return false; // function, symbol, bigint, undefined
    if (Array.isArray(value))
        return value.every(isPlainJsonValue);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        return false; // exotic object
    return Object.values(value).every(isPlainJsonValue);
}
/**
 * Whether an inbound message's origin is trusted. With no configured
 * `parentOrigin` only this document's own origin is trusted (same-origin mode);
 * a configured `parentOrigin` is then the sole trusted origin (explicit-origin
 * mode). The wildcard is never trusted — there is no default acceptance of
 * arbitrary parent origins.
 */
export function isTrustedOrigin(eventOrigin, parentOrigin, selfOrigin) {
    return eventOrigin === (parentOrigin ?? selfOrigin);
}
/** Stamp an outbound payload with a protocol version. */
export function stampOutbound(protocolVersion, type, payload = {}) {
    return { protocolVersion, type, ...payload };
}
