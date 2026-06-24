/** Generic protocol-level rejection reasons (shared error vocabulary). */
export type ProtocolErrorCode = 'malformed' | 'unsupported-version' | 'unknown-type' | 'invalid-payload' | 'too-large';
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * Whether `value` is a plain JSON value (primitive, or array/plain-object
 * thereof). Exotic structured-cloneable types — `ArrayBuffer`, typed arrays,
 * `Map`, `Set`, `Blob`, `Date`, class instances, functions, symbols — are
 * rejected. `JSON.stringify` collapses those to `"{}"`/`undefined`, which would
 * let a multi-megabyte payload slip an encoded-size limit, so a value crossing
 * the boundary must be genuinely JSON-shaped. Assumes an acyclic input (callers
 * stringify first, which rejects cycles).
 */
export declare function isPlainJsonValue(value: unknown): boolean;
/**
 * Whether an inbound message's origin is trusted. With no configured
 * `parentOrigin` only this document's own origin is trusted (same-origin mode);
 * a configured `parentOrigin` is then the sole trusted origin (explicit-origin
 * mode). The wildcard is never trusted — there is no default acceptance of
 * arbitrary parent origins.
 */
export declare function isTrustedOrigin(eventOrigin: string, parentOrigin: string | null, selfOrigin: string): boolean;
/** Stamp an outbound payload with a protocol version. */
export declare function stampOutbound(protocolVersion: number, type: string, payload?: Record<string, unknown>): {
    protocolVersion: number;
    type: string;
};
