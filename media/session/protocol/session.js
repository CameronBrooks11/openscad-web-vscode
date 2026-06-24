// The Layer-1 session protocol — the public, DOM-free wire contract a host (e.g. a
// VS Code extension) imports to drive a compile session type-safely (ADR 0009 /
// #194). The session counterpart to the Layer-0 viewer barrel (index.ts): it is
// compiled (JS + .d.ts) to `dist-session/protocol/` by `build:session` and shipped
// inside the versioned, hashed session artifact (see build-session-manifest.mjs).
// Nothing here imports outside src/protocol/ (lint-enforced), so it stays
// distributable on its own.
export * from "./session-transport.js";
export * from "./session-contract.js";
export { isRecord, stampOutbound } from "./envelope.js";
