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

/**
 * A source file in a project (protocol v2, upstream #172): editable text, or a
 * binary asset's exact bytes as a `Uint8Array` via structured clone (never
 * base64; VS Code revives typed arrays for extensions declaring
 * `engines.vscode >= 1.57`). Exactly one of `content`/`bytes`. Bytes at a
 * text-suffix path must be valid UTF-8 (the session treats them as text).
 */
export type ProjectFile =
  | { path: string; content: string; bytes?: never }
  | { path: string; bytes: Uint8Array; content?: never };

/** One runtime user library (upstream #195 / ADR 0010): identity is the
 *  `use <Name/…>` token (single safe segment); files are RELATIVE paths inside
 *  the library; `meta` is opaque passthrough for a future library manager. */
export type SessionLibraryFile =
  | { path: string; content: string; bytes?: never }
  | { path: string; bytes: Uint8Array; content?: never };
export type SessionLibrary = {
  name: string;
  files: SessionLibraryFile[];
  meta?: { version?: string; source?: string };
};

/** Mirror of the session's library-name rule: it becomes a root symlink
 *  verbatim, so single safe segment, never `.`/`..` or a reserved mount. */
export const SESSION_LIBRARY_NAME_RE = /^[A-Za-z0-9._-]+$/;
export const SESSION_RESERVED_LIBRARY_NAMES = new Set([
  'fonts',
  'home',
  'tmp',
  'libraries',
  'locale',
  'dev',
  'proc',
  '.',
  '..',
]);

/** The export formats a host may request (protocol v2, upstream #216). */
export const SESSION_EXPORT_FORMATS = ['stl', 'off', 'glb', '3mf', 'svg', 'dxf'] as const;
export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

/** Host → session. Mirrors `SessionInbound` in the shipped L1 protocol. */
export type SessionInbound =
  | { type: 'setProject'; files: ProjectFile[]; entryPoint?: string; requestId?: string }
  | { type: 'updateFile'; path: string; content: string }
  | { type: 'removeFile'; path: string }
  | { type: 'setEntryPoint'; path: string }
  | { type: 'setLibraries'; libraries: SessionLibrary[]; requestId?: string }
  | { type: 'render'; requestId?: string }
  | { type: 'export'; format: SessionExportFormat; requestId?: string }
  | { type: 'getArtifact'; artifactId: string; requestId: string }
  | { type: 'cancel'; requestId?: string }
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
  /** Echo of the initiating command's requestId (protocol v2 additive, #223) —
   *  today only `export` threads one; absent on session-initiated results. */
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

/** The correlated reply to `getArtifact` (protocol v2, upstream #197): the
 *  artifact's immutable identity + its exact bytes, or `available: false` for an
 *  unknown/evicted id or a failed blob read. */
export type SessionArtifactReply =
  | {
      type: 'artifact';
      protocolVersion: number;
      requestId: string;
      available: true;
      artifact: ArtifactRef;
      bytes: Uint8Array;
    }
  | { type: 'artifact'; protocolVersion: number; requestId: string; available: false };

/** The reply to a `setProject` that carried a requestId (upstream #227): the
 *  engine's ASSIGNED revision for that push. Accept exactly the results
 *  carrying it; an acked revision equal to the previous one means the push was
 *  REJECTED (path/size validation). */
export type SessionProjectAck = {
  type: 'project-ack';
  protocolVersion: number;
  requestId: string;
  sourceRevision: number;
};

/** The reply to a `setLibraries` that carried a requestId (upstream #195):
 *  the revision the set applied at. A validated set always applies, so the
 *  revision always advances; validation failures surface only as an
 *  uncorrelated `error` — treat a missing ack as a host bug. */
export type SessionLibrariesAck = {
  type: 'libraries-ack';
  protocolVersion: number;
  requestId: string;
  sourceRevision: number;
};

/** Session → host. The outbound subset the extension reacts to. */
export type SessionOutbound =
  | { type: 'ready'; protocolVersion: number; capabilities: string[] }
  | SessionProjectAck
  | SessionLibrariesAck
  | { type: 'operation-result'; protocolVersion: number; result: OperationResult }
  | SessionArtifactReply
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
