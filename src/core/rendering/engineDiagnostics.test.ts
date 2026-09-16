/**
 * Preview surfacing of engine diagnostics: once, rate-limited, viewport only.
 *
 * The failure mode this guards is noise in both directions — a 60 fps viewport
 * re-announcing the same broken layer every frame, or a thumbnail render
 * toasting problems the user is already being told about by the viewport.
 */

const mockNotify = jest.fn();
jest.mock('@stores/uiStore', () => ({
  useUIStore: { getState: () => ({ notify: (...a: unknown[]) => mockNotify(...a) }) },
}));

import {
  reportFrameDiagnostics,
  notifyGpuRecovered,
  notifyGpuRecoveryFailed,
  resetEngineDiagnostics,
} from './engineDiagnostics';
import { describeLayerError, errorMessage, pushLayerError, MAX_LAYER_ERRORS_PER_FRAME } from './layerErrors';

const d = (detail: string) => ({ code: 'layer-error', detail });

beforeEach(() => {
  resetEngineDiagnostics();
  mockNotify.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('reportFrameDiagnostics', () => {
  it('toasts a new problem once, however many frames repeat it', () => {
    for (let f = 0; f < 60; f++) reportFrameDiagnostics([d('Layer "A" failed')], 'viewport', 'motion-webgpu', 1000 + f * 16);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]![0]).toEqual(expect.objectContaining({ level: 'warning', message: 'Layer "A" failed' }));
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('rate-limits distinct problems into one toast that counts the rest', () => {
    reportFrameDiagnostics([d('one')], 'viewport', 'e', 0);
    reportFrameDiagnostics([d('two')], 'viewport', 'e', 100);
    reportFrameDiagnostics([d('three')], 'viewport', 'e', 200);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    reportFrameDiagnostics([d('four')], 'viewport', 'e', 10_000);
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockNotify.mock.calls[1]![0].message).toMatch(/four \(\+2 more/);
    // Every one of them is still in the console.
    expect(console.warn).toHaveBeenCalledTimes(4);
  });

  it('auxiliary renders log but never toast', () => {
    reportFrameDiagnostics([d('thumb problem')], 'auxiliary', 'e', 0);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('an empty frame does nothing', () => {
    reportFrameDiagnostics([], 'viewport', 'e', 0);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('GPU recovery notices', () => {
  it('recovered: one info toast on the viewport, none for auxiliary', () => {
    notifyGpuRecovered('viewport', 'motion-webgpu', 'unknown: reset');
    notifyGpuRecovered('auxiliary', 'motion-webgpu', 'unknown: reset');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]![0]).toEqual(expect.objectContaining({ message: 'Graphics were reset — recovered', group: 'engine-gpu-loss' }));
  });

  it('failed: a sticky error, because the preview stays down until the user acts', () => {
    notifyGpuRecoveryFailed('viewport', 'motion-webgpu', 'reopen the project');
    expect(mockNotify.mock.calls[0]![0]).toEqual(expect.objectContaining({ level: 'error', sticky: true, durationMs: 0 }));
  });
});

describe('layerErrors helpers', () => {
  it('allocates lazily and caps a pathological frame', () => {
    let list = null as ReturnType<typeof pushLayerError> | null;
    for (let i = 0; i < 100; i++) list = pushLayerError(list, { layerId: `L${i}`, stage: 'snapshot', message: 'x' });
    expect(list).toHaveLength(MAX_LAYER_ERRORS_PER_FRAME);
  });

  it('describes a layer by name when known, and keeps messages to one line', () => {
    expect(describeLayerError({ layerId: 'n1', layerName: 'Title', stage: 'snapshot', message: 'boom' }))
      .toBe('Layer "Title" failed while building the frame and was skipped: boom');
    expect(describeLayerError({ layerId: 'n1', stage: 'scene', message: 'boom' })).toMatch(/^Layer n1 failed while preparing/);
    expect(errorMessage(new TypeError('a\nstack'))).toBe('TypeError: a');
  });
});
