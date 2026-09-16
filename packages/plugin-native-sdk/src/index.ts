/**
 * The native plugin SDK — types only.
 *
 * See `abi.ts` for the contract and `../include/motion_plugin_abi.h` for the
 * same thing in C. There is deliberately no runtime export: the decisions about
 * whether a binary may load belong to the editor, not to a package an addon
 * author depends on.
 */

export * from './abi';
