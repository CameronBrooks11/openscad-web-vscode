// Layer-0 viewer transport (ADR 0005): the message set for a read-only,
// host-embedded geometry viewer. A host (iframe / VS Code webview) sends OFF
// geometry and viewer settings; the viewer reports ready/camera/errors. No
// compile and no artifacts — pure display. Built on the shared envelope core,
// DOM-free so the validation is unit-testable in isolation.
import { isRecord, stampOutbound } from "./envelope.js";
/** Bump on any breaking change to the L0 inbound/outbound shapes. */
export const VIEWER_PROTOCOL_VERSION = 1;
// OFF geometry text from a (trusted) host can be large; cap it as DoS hygiene.
// Measured in UTF-16 code units.
export const MAX_OFF_LENGTH = 64 * 1024 * 1024;
/**
 * Canonical fit-aware named views a host can request via `setNamedView`. Unlike
 * `setCamera` (a raw pose), these frame the model to its bounds viewer-side, so a
 * host need not know the geometry's scale. Mirrors the viewer's `NAMED_POSITIONS`
 * names exactly (a viewer-side test guards against drift, since this layer must
 * not import the viewer).
 */
export const VIEWER_NAMED_VIEWS = [
    'Diagonal',
    'Front',
    'Right',
    'Back',
    'Left',
    'Top',
    'Bottom',
];
function readString(v) {
    return typeof v === 'string' ? v : undefined;
}
function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
function readTriple(v) {
    return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber)
        ? [v[0], v[1], v[2]]
        : null;
}
function readCameraPose(v) {
    if (!isRecord(v))
        return null;
    const position = readTriple(v.position);
    const target = readTriple(v.target);
    if (!position || !target || !isFiniteNumber(v.zoom))
        return null;
    return { position, target, zoom: v.zoom };
}
function correlation(data) {
    const opId = readString(data.opId);
    const sessionId = readString(data.sessionId);
    return { ...(opId ? { opId } : {}), ...(sessionId ? { sessionId } : {}) };
}
/**
 * Validate an untrusted inbound viewer message against the L0 protocol. Returns
 * the narrowed message or a structured rejection the host can be told about.
 */
export function validateViewerInbound(data) {
    if (!isRecord(data)) {
        return { ok: false, code: 'malformed', reason: 'message is not an object' };
    }
    const opId = readString(data.opId);
    if (data.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
        return {
            ok: false,
            code: 'unsupported-version',
            reason: `expected protocolVersion ${VIEWER_PROTOCOL_VERSION}`,
            opId,
        };
    }
    if (typeof data.type !== 'string') {
        return { ok: false, code: 'malformed', reason: 'missing message type', opId };
    }
    const corr = correlation(data);
    switch (data.type) {
        case 'setGeometry': {
            if (typeof data.offText !== 'string') {
                return { ok: false, code: 'invalid-payload', reason: 'offText must be a string', opId };
            }
            if (data.offText.length > MAX_OFF_LENGTH) {
                return { ok: false, code: 'too-large', reason: 'offText exceeds the size limit', opId };
            }
            return { ok: true, message: { type: 'setGeometry', offText: data.offText, ...corr } };
        }
        case 'setViewerSettings': {
            const color = data.color === undefined ? undefined : readString(data.color);
            if (data.color !== undefined && color === undefined) {
                return { ok: false, code: 'invalid-payload', reason: 'color must be a string', opId };
            }
            if (data.showAxes !== undefined && typeof data.showAxes !== 'boolean') {
                return { ok: false, code: 'invalid-payload', reason: 'showAxes must be a boolean', opId };
            }
            if (data.active !== undefined && typeof data.active !== 'boolean') {
                return { ok: false, code: 'invalid-payload', reason: 'active must be a boolean', opId };
            }
            const background = data.background === undefined ? undefined : readString(data.background);
            if (data.background !== undefined && background === undefined) {
                return { ok: false, code: 'invalid-payload', reason: 'background must be a string', opId };
            }
            if (data.showControls !== undefined && typeof data.showControls !== 'boolean') {
                return {
                    ok: false,
                    code: 'invalid-payload',
                    reason: 'showControls must be a boolean',
                    opId,
                };
            }
            return {
                ok: true,
                message: {
                    type: 'setViewerSettings',
                    ...(color !== undefined ? { color } : {}),
                    ...(data.showAxes !== undefined ? { showAxes: data.showAxes } : {}),
                    ...(data.active !== undefined ? { active: data.active } : {}),
                    ...(background !== undefined ? { background } : {}),
                    ...(data.showControls !== undefined
                        ? { showControls: data.showControls }
                        : {}),
                    ...corr,
                },
            };
        }
        case 'setCamera': {
            const camera = readCameraPose(data.camera);
            if (!camera) {
                return { ok: false, code: 'invalid-payload', reason: 'invalid camera pose', opId };
            }
            return { ok: true, message: { type: 'setCamera', camera, ...corr } };
        }
        case 'setNamedView': {
            if (typeof data.view !== 'string' ||
                !VIEWER_NAMED_VIEWS.includes(data.view)) {
                return { ok: false, code: 'invalid-payload', reason: 'unknown named view', opId };
            }
            return { ok: true, message: { type: 'setNamedView', view: data.view, ...corr } };
        }
        case 'dispose':
            return { ok: true, message: { type: 'dispose', ...corr } };
        default:
            return { ok: false, code: 'unknown-type', reason: `unknown type "${data.type}"`, opId };
    }
}
// Outbound builders (viewer → host), version-stamped.
export function viewerReady(capabilities) {
    return stampOutbound(VIEWER_PROTOCOL_VERSION, 'ready', { capabilities });
}
export function viewerGeometryLoaded(thumbhash, opId) {
    return stampOutbound(VIEWER_PROTOCOL_VERSION, 'geometry-loaded', {
        ...(thumbhash !== undefined ? { thumbhash } : {}),
        ...(opId !== undefined ? { opId } : {}),
    });
}
export function viewerCameraChange(camera) {
    return stampOutbound(VIEWER_PROTOCOL_VERSION, 'camera-change', { camera });
}
export function viewerError(code, reason, opId) {
    return stampOutbound(VIEWER_PROTOCOL_VERSION, 'error', {
        code,
        reason,
        ...(opId !== undefined ? { opId } : {}),
    });
}
// Correlated acknowledgements that a command was applied, echoing its opId.
// `viewer-settings-set`, `camera-set`, and `disposed` are terminal (those
// commands apply synchronously). `geometry-set` only confirms the geometry was
// *accepted* — its render outcome arrives later as a `geometry-loaded` or an
// `error`, correlated by the same opId.
function ack(type, opId) {
    return stampOutbound(VIEWER_PROTOCOL_VERSION, type, opId !== undefined ? { opId } : {});
}
export const viewerGeometrySet = (opId) => ack('geometry-set', opId);
export const viewerSettingsSet = (opId) => ack('viewer-settings-set', opId);
export const viewerCameraSet = (opId) => ack('camera-set', opId);
export const viewerNamedViewSet = (opId) => ack('named-view-set', opId);
export const viewerDisposed = (opId) => ack('disposed', opId);
