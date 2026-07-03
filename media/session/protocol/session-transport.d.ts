import { type ProtocolErrorCode } from './envelope.js';
import type { ArtifactRef, OperationResult, ProjectFile } from './session-contract.js';
/**
 * Bump on any breaking change to the session INBOUND/OUTBOUND message shapes. This
 * is the session WIRE version — distinct from `L1_PROTOCOL_VERSION`, which versions
 * the nested `OperationResult` payload (ADR 0005: each binding owns its version).
 *
 * v2: added the `getArtifact` command + `artifact` reply (#197), binary project
 * files (#172), and the `export` command (#216) — one bump; v2 never shipped
 * between them.
 */
export declare const SESSION_PROTOCOL_VERSION = 2;
export declare const SESSION_MAX_FILE_LENGTH: number;
export declare const SESSION_MAX_FILES = 2048;
export declare const SESSION_MAX_TOTAL_LENGTH: number;
export declare const SESSION_MAX_PATH_LENGTH = 4096;
/** Cap for opaque ids (`artifactId` is a v4 UUID, `requestId` host-chosen). */
export declare const SESSION_MAX_ID_LENGTH = 256;
/** The inbound command types, advertised in `ready` so a host can feature-detect. */
export declare const SESSION_COMMANDS: readonly ["setProject", "updateFile", "removeFile", "setEntryPoint", "render", "export", "getArtifact", "cancel", "dispose"];
/** The export formats a host may request (#216) — the app's own format set.
 *  3D: stl/off/glb/3mf; 2D: svg/dxf. The session exports the CURRENT model's
 *  dimensionality; a mismatched request (e.g. `svg` for a 3D model) terminates
 *  as an export-kind failure result, never silence. */
export declare const SESSION_EXPORT_FORMATS: readonly ["stl", "off", "glb", "3mf", "svg", "dxf"];
export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];
/** Host → session. Mirrors `ProjectContract` (src/state/project-contract.ts) 1:1,
 *  plus `export` (#216), `getArtifact` (bytes-by-id, #197), and `dispose` for
 *  worker teardown. */
export type SessionInbound = {
    type: 'setProject';
    files: ProjectFile[];
    entryPoint?: string;
} | {
    type: 'updateFile';
    path: string;
    content: string;
} | {
    type: 'removeFile';
    path: string;
} | {
    type: 'setEntryPoint';
    path: string;
} | {
    type: 'render';
    requestId?: string;
} | {
    type: 'export';
    format: SessionExportFormat;
    requestId?: string;
} | {
    type: 'getArtifact';
    artifactId: string;
    requestId: string;
} | {
    type: 'cancel';
} | {
    type: 'dispose';
};
export type SessionValidation = {
    ok: true;
    message: SessionInbound;
} | {
    ok: false;
    code: ProtocolErrorCode;
    reason: string;
};
/**
 * Validate an untrusted inbound session message against the L1 protocol. Returns
 * the narrowed message or a structured rejection the host can be told about. Shape
 * + size only — path safety / canonicalization is the in-process `ProjectStore`'s
 * job (and lives behind the protocol's import fence).
 */
export declare function validateSessionInbound(data: unknown): SessionValidation;
/** Announce readiness + the supported inbound commands (host feature-detection). */
export declare function sessionReady(capabilities: readonly string[]): {
    protocolVersion: number;
    type: string;
};
/**
 * Forward a terminal compile result. These are a PUSH STREAM, NOT 1:1 with
 * commands: one edit fans out to multiple results (syntaxCheck + preview render +
 * …), each a distinct `operationId`. The host correlates by `sourceRevision` +
 * `kind` (e.g. render the highest-revision `preview`/`render`), never by command.
 * The nested `result` keeps its own `L1_PROTOCOL_VERSION`.
 */
export declare function sessionOperationResult(result: OperationResult): {
    protocolVersion: number;
    type: string;
};
/** The correlated reply to `getArtifact` — exported so a host's vendored `.d.ts`
 *  carries the exact reply shape instead of a hand-maintained mirror. */
export type SessionArtifactReply = {
    protocolVersion: number;
    type: 'artifact';
    requestId: string;
    available: true;
    artifact: ArtifactRef;
    bytes: Uint8Array;
} | {
    protocolVersion: number;
    type: 'artifact';
    requestId: string;
    available: false;
};
/**
 * Reply to `getArtifact` (#197): the artifact's immutable identity + its EXACT
 * bytes, or `available: false` when the id is unknown, evicted from the
 * per-session store (ADR 0008), or its blob read failed. Echoes the request's
 * `requestId`. The bytes ride structured clone as a `Uint8Array` — the one place
 * bytes cross this wire (display renders in-process and never does).
 */
export declare function sessionArtifact(requestId: string, resolved: {
    artifact: ArtifactRef;
    bytes: Uint8Array;
} | undefined): SessionArtifactReply;
/** A protocol-level rejection of an inbound message (validation failure). */
export declare function sessionError(code: ProtocolErrorCode | string, reason: string): {
    protocolVersion: number;
    type: string;
};
