# Speed ramps and retiming

Select a video, audio-carrying video, or composition layer and open **Speed**
in the inspector. One control decides how its source is timed:

**Normal · Speed % · Frames**

- **Speed %** — keyframe playback speed as a percentage: 100% here, 20% there,
  300% after the beat. This is Twixtor's *Speed %* mode and After Effects'
  Timewarp *Adjust Time By: Speed*.
- **Frames** — keyframe *which source frame* shows at each moment. Twixtor's
  *Frame Num* mode, AE's Time Remap — shown in frames rather than seconds to
  two decimals, which could not name a frame.
- **Normal** — plays as shot.

Switching modes **converts** rather than discarding: Speed → Frames bakes the
curve into remap keys; Frames → Speed turns each segment's average slope into a
speed and keeps the frame at every old key. Both are one undo step.

## The Speed section

- **Speed** field with a stopwatch. One point = a constant speed; turn the
  stopwatch on to shape a curve; the ◆ navigator adds and steps between points.
- **Speed curve** across the clip bar, on a log scale (50% and 200% sit the
  same distance from 100%, and the 10–40% slow-motion band gets room). Drag a
  point up/down for speed and sideways to move it; drags snap to 100%.
  Double-click to add a point, Delete to remove it, arrow keys to nudge
  (Shift for bigger steps), click or drag the background to scrub.
- **Ramp** — how speed leaves the selected point: *Smooth* (eased), *Linear*,
  or *Instant* (a hard cut in speed).
- **Presets** across the whole clip: Velocity, Hero, Bullet, Montage, Flash In,
  Flash Out, Jump Cut.
- **Footage budget** — "Plays 3.20s of footage in 5.00s". When a speed-up runs
  out of source, the graph tints the rest of the bar, the section says when,
  and **Fit to footage** scales the whole curve to end on the last frame.
- **Smooth motion** — Off / Blend (Frame Mix) / Optical flow (Pixel Motion).
  Slowing below 100% turns on Optical flow when blending was off.

The one-click commands (**Ramp to 25%**, 50%, back to 100%, 200%, Freeze) and
the presets are also in the command palette and under Layer ▸ Time.

## Why speed cannot just be sampled

Speed is a *rate*. What the renderer needs is which source frame to show at a
given composition time, which is the **integral** of speed. Keyframe a speed
value and sample it per frame and the result is wrong everywhere: ramp 100% →
50% and the footage does not decelerate, it jumps to a different frame and then
plays at some third rate.

So the speed keys are the document, and `core/animation/retime.ts` integrates
them on demand:

- **Hold** segments integrate as `v·d`, **linear** ones as
  `v₀·d + (v₁−v₀)·d²/2L` — both exact.
- **Shaped** segments (Smooth, bezier handles, expressions) integrate the curve
  the engine actually evaluates, on 64 panels per segment — far below a frame
  of error, and what you see in the graph is what plays.
- The table is cached per track and rebuilt only when the keys change.

`retime.test.ts` checks every case against a 20,000-step numerical integration
of the engine's own samples, not against hand-derived numbers.

### Why not generate remap keyframes instead

Writing the integral out as `timeRemap` keys gives the document two
representations of one decision, and the moment anything edits the derived one
— the graph editor, a paste, an AI tool — they silently disagree. The Speed
track is the only record; consumers ask `retimedChainTime` for the answer.

When a speed curve IS converted to Frames, a linear speed change still bakes to
exactly two keys: over such a segment source time is a quadratic, and a cubic
Bézier with x handles at 1/3 and 2/3 represents any quadratic exactly
(`rampBezier` in `speedRamp.ts`):

```
y(u) = a·u + b·u²        a = 2v₀/(v₀+v₁),  b = (v₁−v₀)/(v₀+v₁),  a + b = 1
y₁ = a/3                 y₂ = (b + 2a)/3
```

## Axes, and why the first frame never jumps

- **Speed keys live on the layer's ordinary keyframe axis** (the clip map,
  `sourceIn + frame − start`). The curve moves with the clip when the bar is
  dragged, and the diamonds, graph editor and inspector use the conversion every
  other property does.
- **The integral starts at the bar's in-point**, where the bar's own `sourceIn`
  frame shows. Changing speed never moves the first frame of a trimmed clip.
- **Frame Number keys** are the classic `timeRemap` track on the chain axis;
  the inspector converts to and from source frames through the bar's offset
  and the footage's own frame rate.

## One path for every consumer

`retimedChainTime(anim, nodeId, t, clip)` answers "what chain-axis time would a
remap track hold here" for either mode. The renderer's `sourceTime`, frame
blending, nested precomp folds (`buildSnapshot`, `TimelineController`) and
audio varispeed (`audioRetimeSegments`) all resolve through it, so picture and
sound follow the same curve.

> **Fixed alongside.** The clip map asked whether a bar was live at the remap
> VALUE's frame, and fell through to raw comp time when it was not. A retimed
> value legitimately leaves the bar's range — 200% near the out-point reads past
> it, slow motion near a trimmed in-point reads before it — so those frames
> showed unrelated footage. Retimed values now extrapolate from the nearest bar
> (`pickRetimeBar`). Audio had the same fault in a different form: it read the
> buffer at the raw remap value, ignoring the bar's `inSec − startSec` offset.
> Pinned by `retimeBarOffset.test.ts` and `retimeSpeedRender.test.ts`.

## What it applies to

**Anything with a source to retime: video, audio, and pre-comps.** A shape or
solid is excluded: a retime feeds `sourceTime` only and does not move the
layer's own transform keyframes — the same separation After Effects makes. A
shape has no source, so nothing would read the value.

Known limits: Time Stretch and loop apply on top of a retime rather than being
folded into the speed axis; Frame Number (`timeRemap`) keys stay on the chain
axis, so they do not follow a dragged bar the way Speed % keys do; optical
flow is block matching, which can warp on very fast motion at very low speeds.

## Layout

```
core/animation/
  retime.ts                 pure: modes, the speed integral, retimedChainTime
  retimeCommands.ts         mode switching + conversion, presets, fit, summary
  speedRamp.ts              pure: exact Bézier for a linear speed change
  speedRampCommands.ts      one-click ramps at the playhead
layout/Inspector/
  RetimeSection.tsx         Normal / Speed % / Frames section
  RetimeGraph.tsx           in-inspector speed / source-frame curve
```
