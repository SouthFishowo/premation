/**
 * The JavaScript twin of the native effect.
 *
 * Every native plugin should ship one. A binary exists for three platform-arch
 * pairs at most; a user on a fourth, a user who declined the native consent
 * step, and a user whose plugin process has been disabled for the session after
 * repeated crashes all land here. Without it their layer renders unchanged and
 * nothing says why.
 *
 * It is also the thing to diff against while developing the addon: the same
 * arithmetic, in premultiplied float, so a disagreement is a bug in the binary
 * rather than a difference of colour space.
 *
 * This is an ordinary CPU kernel — the signature `docs/PLUGINS.md` documents
 * for `contributes.effects[].cpu`, and it knows nothing about the native tier.
 */

export function render(input, output, width, height, params) {
  const gain = Math.pow(2, Number(params.stops) || 0);
  const count = width * height * 4;
  for (let i = 0; i < count; i += 4) {
    output[i] = input[i] * gain;
    output[i + 1] = input[i + 1] * gain;
    output[i + 2] = input[i + 2] * gain;
    output[i + 3] = input[i + 3];
  }
}
