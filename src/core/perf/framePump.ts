/**
 * framePump — lets the playback clock render the viewport in the SAME
 * animation frame it advanced the playhead in.
 *
 * The render loop is rAF-coalesced (`WorkspaceController.requestRender`), which
 * is right for everything that asks for a redraw from an event handler. It was
 * wrong for playback: the pump ticks inside a rAF callback, a redraw requested
 * from there lands in the NEXT frame, so every played frame reached the screen
 * one vsync late — and, before the clock subscription, only after a React
 * commit had carried the new time to the viewport's effect.
 *
 * The pump (and a coalesced scrub) calls {@link flushRenderNow} right after it
 * moves the clock. The registered flusher runs a pending redraw immediately and
 * cancels its queued rAF; with nothing pending it does nothing. Passing the rAF
 * timestamp lets the flusher refuse a second render inside one frame.
 *
 * A dependency-free module on purpose: the timeline imports it, and pulling
 * the workspace controller (and the engine behind it) into the timeline's
 * module graph for one call would be a poor trade.
 */

type Flusher = (frameTs?: number) => void;

let flusher: Flusher | null = null;

/** Register the viewport's flusher. Returns the disposer. */
export function setRenderFlusher(fn: Flusher): () => void {
  flusher = fn;
  return () => {
    if (flusher === fn) flusher = null;
  };
}

/**
 * Run a pending viewport redraw now, inside the caller's frame. `frameTs` is
 * the rAF timestamp when called from a rAF callback (omit it from a timer).
 */
export function flushRenderNow(frameTs?: number): void {
  flusher?.(frameTs);
}
