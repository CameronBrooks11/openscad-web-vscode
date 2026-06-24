// Host-side (extension → viewer) view of the Layer-0 viewer protocol.
//
// The *authoritative* protocol — including the full TypeScript types and the
// `VIEWER_PROTOCOL_VERSION` constant — ships inside the vendored viewer artifact
// at `media/viewer/protocol/` (`index.d.ts` / `index.js`). This module is a thin,
// dependency-free mirror of the message shapes the extension actually sends and
// receives. The runtime version is NOT hard-coded here: it is read from the
// artifact's `viewer-manifest.json` (see `viewerArtifact.ts`) so a viewer the
// extension wasn't built against fails the `ready` version check loudly.
//
// Contract reference: openscad-web `docs/EMBEDDING-VSCODE.md` and ADR 0005.

/** A camera pose, host-neutral. Mirrors `CameraPose` in the shipped protocol. */
export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

/** Fit-aware named camera views (mirrors the viewer's `VIEWER_NAMED_VIEWS`). */
export const NAMED_VIEWS = ['Diagonal', 'Front', 'Right', 'Back', 'Left', 'Top', 'Bottom'] as const;
export type NamedView = (typeof NAMED_VIEWS)[number];

/** Host → viewer. Mirrors `ViewerInbound` in `media/viewer/protocol/index.d.ts`. */
export type ViewerInbound =
  | { type: 'setGeometry'; offText: string }
  | {
      type: 'setViewerSettings';
      color?: string;
      showAxes?: boolean;
      active?: boolean;
      background?: string;
      showControls?: boolean;
    }
  | { type: 'setCamera'; camera: CameraPose }
  | { type: 'setNamedView'; view: NamedView }
  | { type: 'dispose' };

/** Viewer → host. The outbound subset the extension reacts to. */
export type ViewerOutbound =
  | { type: 'ready'; protocolVersion: number; capabilities: string[] }
  | { type: 'geometry-set'; opId?: string }
  | { type: 'geometry-loaded'; thumbhash?: string; opId?: string }
  | { type: 'viewer-settings-set'; opId?: string }
  | { type: 'camera-set'; opId?: string }
  | { type: 'named-view-set'; opId?: string }
  | { type: 'disposed'; opId?: string }
  | { type: 'camera-change'; camera: CameraPose }
  | { type: 'error'; code: string; reason: string; opId?: string };

/** An inbound message as it travels on the wire (version-stamped, correlatable). */
export type WireInbound = ViewerInbound & { protocolVersion: number; opId?: string };

/** Stamp an inbound message for sending. */
export function stampInbound(
  message: ViewerInbound,
  protocolVersion: number,
  opId?: string,
): WireInbound {
  return { ...message, protocolVersion, ...(opId !== undefined ? { opId } : {}) };
}
