import { type ProtocolErrorCode } from './envelope.js';
import type { OperationResult, ProjectFile } from './session-contract.js';
/**
 * Bump on any breaking change to the session INBOUND/OUTBOUND message shapes. This
 * is the session WIRE version — distinct from `L1_PROTOCOL_VERSION`, which versions
 * the nested `OperationResult` payload (ADR 0005: each binding owns its version).
 */
export declare const SESSION_PROTOCOL_VERSION = 1;
export declare const SESSION_MAX_FILE_LENGTH: number;
export declare const SESSION_MAX_FILES = 2048;
export declare const SESSION_MAX_TOTAL_LENGTH: number;
export declare const SESSION_MAX_PATH_LENGTH = 4096;
/** The inbound command types, advertised in `ready` so a host can feature-detect. */
export declare const SESSION_COMMANDS: readonly ["setProject", "updateFile", "removeFile", "setEntryPoint", "cancel", "dispose"];
/** Host → session. Mirrors `ProjectContract` (src/state/project-contract.ts) 1:1,
 *  plus `dispose` for worker teardown. */
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
/** A protocol-level rejection of an inbound message (validation failure). */
export declare function sessionError(code: ProtocolErrorCode | string, reason: string): {
    protocolVersion: number;
    type: string;
};
