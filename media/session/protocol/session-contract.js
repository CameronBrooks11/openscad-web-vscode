// Layer-1 session contract — the DOM-free data types a host and an OpenScadSession
// exchange (ADR 0008/0009). They live in the protocol layer because they ARE the
// wire payloads: a host (a VS Code webview) pushes a project and receives compile
// operation results. Kept import-free so the protocol stays distributable
// (lint-fenced). The in-process result CONSTRUCTORS and the scheduler command
// shapes (OperationCommand/CancelCommand) stay in src/runner/compile-contract.ts,
// the diagnostic UTILITIES stay in src/diagnostics.ts, and the ProjectStore stays
// in src/state — each re-exports the types it owned from here.
/**
 * Layer-1 result-payload version (ADR 0005 axis). Distinct from the session WIRE
 * version (`SESSION_PROTOCOL_VERSION`, src/protocol/session-transport.ts) and the
 * embed wire (`EMBED_PROTOCOL_VERSION`): this versions the `OperationResult` shape.
 */
export const L1_PROTOCOL_VERSION = 1;
