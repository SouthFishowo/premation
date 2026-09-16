/**
 * The plugin's ordinary entry module.
 *
 * Worth reading for what is NOT here: nothing loads the addon, nothing names
 * the binary, and nothing checks the platform. A native plugin's sandboxed
 * entry is the same script it would be without one — the host loads the binary
 * from the manifest's `native` block, into its own process, after the trust
 * gate, and calls it directly when it renders the effect.
 *
 * That separation is the whole security argument. If this file could reach the
 * addon, the addon's privileges would be reachable from a script, and the
 * consent the user gave for one would be consent for the other.
 */

export function activate(motion) {
  motion.log('Example Native Exposure is active.');
}
