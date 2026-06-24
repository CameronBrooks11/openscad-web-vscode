import { type ProtocolErrorCode } from './envelope.js';
/** Bump on any breaking change to the L0 inbound/outbound shapes. */
export declare const VIEWER_PROTOCOL_VERSION = 1;
export declare const MAX_OFF_LENGTH: number;
/** A camera pose, host-neutral (matches the viewer's CameraState shape). */
export type CameraPose = {
    position: [number, number, number];
    target: [number, number, number];
    zoom: number;
};
/**
 * Canonical fit-aware named views a host can request via `setNamedView`. Unlike
 * `setCamera` (a raw pose), these frame the model to its bounds viewer-side, so a
 * host need not know the geometry's scale. Mirrors the viewer's `NAMED_POSITIONS`
 * names exactly (a viewer-side test guards against drift, since this layer must
 * not import the viewer).
 */
export declare const VIEWER_NAMED_VIEWS: readonly ["Diagonal", "Front", "Right", "Back", "Left", "Top", "Bottom"];
export type NamedView = (typeof VIEWER_NAMED_VIEWS)[number];
/** Fields every inbound message may carry for correlation (ADR 0005 envelope). */
type Correlated = {
    opId?: string;
    sessionId?: string;
};
export type ViewerInbound = ({
    type: 'setGeometry';
    offText: string;
} & Correlated) | ({
    type: 'setViewerSettings';
    color?: string;
    showAxes?: boolean;
    active?: boolean;
    background?: string;
    showControls?: boolean;
} & Correlated) | ({
    type: 'setCamera';
    camera: CameraPose;
} & Correlated) | ({
    type: 'setNamedView';
    view: NamedView;
} & Correlated) | ({
    type: 'dispose';
} & Correlated);
export type ViewerValidation = {
    ok: true;
    message: ViewerInbound;
} | {
    ok: false;
    code: ProtocolErrorCode;
    reason: string;
    opId?: string;
};
/**
 * Validate an untrusted inbound viewer message against the L0 protocol. Returns
 * the narrowed message or a structured rejection the host can be told about.
 */
export declare function validateViewerInbound(data: unknown): ViewerValidation;
export declare function viewerReady(capabilities: string[]): {
    protocolVersion: number;
    type: string;
};
export declare function viewerGeometryLoaded(thumbhash?: string, opId?: string): {
    protocolVersion: number;
    type: string;
};
export declare function viewerCameraChange(camera: CameraPose): {
    protocolVersion: number;
    type: string;
};
export declare function viewerError(code: ProtocolErrorCode | string, reason: string, opId?: string): {
    protocolVersion: number;
    type: string;
};
export declare const viewerGeometrySet: (opId?: string) => {
    protocolVersion: number;
    type: string;
};
export declare const viewerSettingsSet: (opId?: string) => {
    protocolVersion: number;
    type: string;
};
export declare const viewerCameraSet: (opId?: string) => {
    protocolVersion: number;
    type: string;
};
export declare const viewerNamedViewSet: (opId?: string) => {
    protocolVersion: number;
    type: string;
};
export declare const viewerDisposed: (opId?: string) => {
    protocolVersion: number;
    type: string;
};
export {};
