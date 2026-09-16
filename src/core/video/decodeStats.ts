/**
 * Counters for the exact video pipeline — what was ASKED for versus what was
 * actually decoded and shown.
 *
 * Scrubbing speed is not one number. A scrub that "feels slow" can be a
 * decoder that is slow, or a decoder that is fast but busy with frames the
 * playhead left behind half a second ago; only the second is fixable above the
 * codec, and only the ratio of decodes to presented frames tells the two apart.
 * So the session, the decode worker and the texture upload each bump a counter
 * here, and `window.__motionVideoDecode` exposes them for a live probe:
 *
 *   __motionVideoDecode.reset(); <scrub for 5 s>; __motionVideoDecode.stats()
 *
 * Plain module state, no timers, no allocation per count — this sits on the
 * per-frame path.
 */

export interface VideoDecodeStats {
  /** Random-access frame requests (`ExactVideoSource.frameAt`). */
  seekRequests: number;
  /** Requests that actually fed a GOP prefix to a decoder. */
  seekDecodes: number;
  /** Requests served from the session's own GOP cache. */
  seekHits: number;
  /** Requests dropped because a newer seek replaced them (latest-wins). */
  superseded: number;
  /** In-flight GOP decodes stopped mid-way (decoder reset) by a newer seek. */
  abortedDecodes: number;
  /** Frames the decoder emitted, kept or not. */
  framesOutput: number;
  /** Frames dropped below the retain window without a copy being made. */
  framesDropped: number;
  /** Exact frames uploaded to the GPU, by upload source kind. */
  uploadsVideoFrame: number;
  uploadsBitmap: number;
  uploadsCanvas: number;
  /** Decode-worker restarts after a crash or a hang. */
  workerRestarts: number;
}

function zero(): VideoDecodeStats {
  return {
    seekRequests: 0,
    seekDecodes: 0,
    seekHits: 0,
    superseded: 0,
    abortedDecodes: 0,
    framesOutput: 0,
    framesDropped: 0,
    uploadsVideoFrame: 0,
    uploadsBitmap: 0,
    uploadsCanvas: 0,
    workerRestarts: 0,
  };
}

/** The live counters. Mutated in place by the pipeline. */
export const videoDecodeStats: VideoDecodeStats = zero();

export function resetVideoDecodeStats(): void {
  Object.assign(videoDecodeStats, zero());
}

export function snapshotVideoDecodeStats(): VideoDecodeStats {
  return { ...videoDecodeStats };
}

// The probe handle. Assigned once at module load; a page without `window`
// (worker, jest node env) simply doesn't get one.
if (typeof window !== 'undefined') {
  (window as unknown as { __motionVideoDecode?: unknown }).__motionVideoDecode = {
    stats: snapshotVideoDecodeStats,
    reset: resetVideoDecodeStats,
  };
}
