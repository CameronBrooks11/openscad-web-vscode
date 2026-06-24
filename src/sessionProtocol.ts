// Host-side (extension ↔ session) view of the Layer-1 session protocol.
//
// The *authoritative* protocol — full types + `SESSION_PROTOCOL_VERSION` — ships
// inside the vendored session artifact at `media/session/protocol/` (`session.d.ts`
// etc.). This module is a thin, dependency-free mirror of the message shapes the
// extension actually sends and receives, in the same spirit as `protocol.ts` for
// the L0 viewer. The runtime version is NOT hard-coded here: it is read from the
// artifact's `session-manifest.json` (see `sessionArtifact.ts`) so a session the
// extension wasn't built against fails the `ready` version check loudly.
//
// Unlike the L0 viewer (read-only OFF), L1 drives a live compile: the host pushes
// a project (`setProject` + edits), the session compiles in-webview and renders
// in-process, and streams back terminal `OperationResult`s — a PUSH STREAM that is
// NOT 1:1 with commands (one edit fans out to syntaxCheck + preview + render, each
// its own `operationId`). The host correlates by `operationId` / `kind` /
// `sourceRevision`, never by command.
//
// Contract reference: openscad-web `docs/EMBEDDING-VSCODE.md` §6 and ADR 0009.

/** A text source file in a project (text-first; binary deferred upstream, #172). */
export interface ProjectFile {
  path: string;
  content: string;
}

/** Host → session. Mirrors `SessionInbound` in the shipped L1 protocol. */
export type SessionInbound =
  | { type: 'setProject'; files: ProjectFile[]; entryPoint?: string }
  | { type: 'updateFile'; path: string; content: string }
  | { type: 'removeFile'; path: string }
  | { type: 'setEntryPoint'; path: string }
  | { type: 'cancel' }
  | { type: 'dispose' };

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** A host-neutral compiler marker. Line/column are 1-based (openscad-web/ADR 0001). */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
  /** File the diagnostic belongs to (e.g. `/home/main.scad`), for routing. */
  path?: string;
}

export type OperationKind = 'syntaxCheck' | 'preview' | 'render' | 'export';

/** An immutable handle to a produced artifact's bytes (fetch by id is #197). */
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
  // P3: this is the L1 *result-payload* version (`L1_PROTOCOL_VERSION`), a DIFFERENT
  // axis from the session WIRE version pinned in the manifest. Do NOT gate it against
  // the manifest's `protocolVersion` — they version different things (ADR 0005).
  protocolVersion: number;
  sessionId: string;
  operationId: string;
  sourceRevision: number;
  kind: OperationKind;
  elapsedMillis: number;
  diagnostics: Diagnostic[];
  logText: string;
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

/** Session → host. The outbound subset the extension reacts to. */
export type SessionOutbound =
  | { type: 'ready'; protocolVersion: number; capabilities: string[] }
  | { type: 'operation-result'; protocolVersion: number; result: OperationResult }
  | { type: 'error'; protocolVersion: number; code: string; reason: string };

/** An inbound message as it travels on the wire (version-stamped). L1 commands are
 *  not individually acked — the host correlates the result push stream — so there
 *  is no per-message opId here (unlike the L0 viewer). */
export type WireSessionInbound = SessionInbound & { protocolVersion: number };

/** Stamp an inbound session message for sending. */
export function stampSessionInbound(
  message: SessionInbound,
  protocolVersion: number,
): WireSessionInbound {
  return { ...message, protocolVersion };
}
