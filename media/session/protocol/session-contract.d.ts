/**
 * Layer-1 result-payload version (ADR 0005 axis). Distinct from the session WIRE
 * version (`SESSION_PROTOCOL_VERSION`, src/protocol/session-transport.ts) and the
 * embed wire (`EMBED_PROTOCOL_VERSION`): this versions the `OperationResult` shape.
 */
export declare const L1_PROTOCOL_VERSION = 1;
export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export interface Diagnostic {
    severity: DiagnosticSeverity;
    message: string;
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    /** Optional source/tool that produced the diagnostic. */
    source?: string;
    /**
     * File the diagnostic belongs to, as reported by the compiler (e.g.
     * `/home/playground.scad`), so a host routes the marker to the right editor
     * model instead of dumping every file's diagnostics on the active one.
     */
    path?: string;
}
/**
 * A source file in a host-supplied project (#123/#172): editable text, or a
 * binary asset's exact bytes (e.g. an `.stl`/`.png` referenced via `import()` /
 * `surface()`). Bytes ride structured clone as a `Uint8Array` — never base64 —
 * and land as a content-less `local` source whose bytes live on the session FS
 * (ADR 0006). Exactly one of `content`/`bytes` per file. `bytes` at a
 * text-suffix path must be valid UTF-8 and are treated as `content` (so a host
 * may read every workspace file as a buffer and push uniformly).
 */
export type ProjectFile = {
    path: string;
    content: string;
    bytes?: never;
} | {
    path: string;
    bytes: Uint8Array;
    content?: never;
};
export type OperationKind = 'syntaxCheck' | 'preview' | 'render' | 'export';
/**
 * An immutable handle to a produced artifact's exact bytes. `artifactId` keys a
 * per-session store so the bytes can be fetched by id (#197) — not a racy
 * "current output".
 */
export interface ArtifactRef {
    artifactId: string;
    operationId: string;
    sourceRevision: number;
    format: string;
    mediaType: string;
    size: number;
    name: string;
}
interface OperationResultBase {
    protocolVersion: number;
    sessionId: string;
    operationId: string;
    /** Echoed from the command; the #56/#99 stale-drop is unchanged. */
    sourceRevision: number;
    kind: OperationKind;
    elapsedMillis: number;
    /** Host-neutral markers (ADR 0001). */
    diagnostics: Diagnostic[];
    logText: string;
    /**
     * Echo of the initiating command's `requestId`, on every terminal of the
     * operation it started (#223). Today only `export { requestId? }` threads
     * one through; absent for operations the session started itself (auto
     * previews/syntax checks) or when the command carried none. Additive —
     * optional, so the L1 payload version is unchanged.
     */
    requestId?: string;
}
export interface OperationSuccess extends OperationResultBase {
    status: 'success';
    artifact?: ArtifactRef;
}
export interface OperationFailure extends OperationResultBase {
    status: 'error';
    code: string;
    reason: string;
}
export interface OperationCancelled extends OperationResultBase {
    status: 'cancelled';
}
/** Exactly one terminal result per `operationId`. */
export type OperationResult = OperationSuccess | OperationFailure | OperationCancelled;
/** The shared, version-independent fields of a terminal result (constructor input). */
export type OperationBase = Omit<OperationResultBase, 'protocolVersion'>;
export {};
