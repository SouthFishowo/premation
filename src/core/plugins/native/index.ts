/**
 * The native plugin tier, from the renderer's side.
 *
 * The modules behind this barrel, in the order a plugin travels through them:
 *
 *   `nativeAbi`        the contract and the version check
 *   `nativePlatforms`  which binary, out of the several a package ships
 *   `nativeTrust`      whether it may run: signature, consent, the pinned hash
 *   `nativeInstall`    getting an archive's binary somewhere loadable
 *   `nativeBuffers`    who owns a pixel buffer at each moment
 *   `nativeScheduler`  when a call runs, and what happens to the queue
 *   `nativeClient`     the seam the rest of the app calls
 *
 * Importing this barrel starts nothing. No process exists until
 * `loadNativePlugin` is called, and no scheduler until the first call after
 * that — a project with no native plugin pays for the module graph and nothing
 * else.
 */

export {
  NATIVE_ABI_MAJOR,
  NATIVE_ABI_MINOR,
  NATIVE_ABI_VERSION,
  NATIVE_EXPORTS,
  checkNativeAbi,
  nativeAbiMajor,
  nativeAbiMinor,
  type NativeCallKind,
  type NativeCallOutcome,
  type NativeDescribe,
  type NativeEffectRequest,
  type NativeFrameInfo,
  type NativeGenerateRequest,
  type NativeInvokeRequest,
  type NativePixelFormat,
  type NativeRefusal,
  type NativeRequest,
  type NativeResult,
} from './nativeAbi';

export {
  KNOWN_NATIVE_PLATFORMS,
  nativePlatformKey,
  nativePlatformLabel,
  selectNativeBinary,
  type NativeSelection,
} from './nativePlatforms';

export {
  getNativeConsent,
  killNativeConsent,
  nativeConsentSummary,
  nativeTrustVerdict,
  needsNativeConsent,
  recordNativeConsent,
  resetNativeConsentForTests,
  shortHash,
  subscribeNativeConsent,
  type NativeConsent,
  type NativeTrustVerdict,
} from './nativeTrust';

export {
  MAX_SWEEPS_PER_BOOT,
  manifestForStaged,
  nativeHashesFrom,
  sha256Hex,
  stageNativeBinary,
  stagingPlatformKey,
  sweepStagedNative,
  unstageNativePlugin,
  type StagedNative,
} from './nativeInstall';

export {
  BufferHandoffError,
  assertReadable,
  collectTransfers,
  detachBuffer,
  handOff,
  isHandedOff,
  reclaim,
  reclaimAll,
  shareBuffer,
} from './nativeBuffers';

export {
  NATIVE_BUDGET_COOLDOWN_MS,
  NATIVE_PREVIEW_BUDGET_MS,
  NativeScheduler,
  hasNativeWork,
  nativeScheduler,
  resetNativeSchedulerForTests,
  setNativeExactMode,
  settleNative,
  takeNativeErrors,
  type NativeDispatch,
  type NativeJob,
} from './nativeScheduler';

export {
  allNativeStatuses,
  invokeNative,
  killNativePlugin,
  loadNativePlugin,
  nativeReady,
  nativeStatus,
  nativeTierAvailable,
  reloadNativePlugin,
  resetNativeClientForTests,
  runNativeEffect,
  runNativeGenerate,
  subscribeNativeStatus,
  unloadNativePlugin,
  watchNativeEvents,
  type NativeLoadInput,
  type NativeStatus,
} from './nativeClient';
