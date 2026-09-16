/**
 * Generator layer kinds — a plugin that produces geometry every frame.
 *
 * The four modules behind this barrel, in the order a frame travels through
 * them:
 *
 *   `generatorContract`  what a plugin returns, and what the host will accept.
 *   `generatorState`     how a stateful simulation survives a scrub.
 *   `generatorScheduler` when the plugin's code runs, and what is shown while
 *                        it does.
 *   `generatorLayers`    the seam `buildSnapshot` calls, once per generator
 *                        layer and never otherwise.
 *
 * `generatorLayers` is deliberately NOT re-exported here: it imports the layer
 * kind registry and the scene node type, and the renderer-side consumers of
 * this barrel want the contract alone.
 */

export {
  GEN_MESH_VERTEX_STRIDE,
  GEN_STRIDE,
  GEN_STRIDE_UV,
  GEN_STRIDES,
  GENERATOR_PRIMITIVES,
  MAX_GENERATOR_INSTANCES,
  MAX_GENERATOR_MESH_INDICES,
  MAX_GENERATOR_MESH_VERTICES,
  emptyGeneratorFrame,
  generatorBoundsOf,
  measureInstanceBounds,
  validateGeneratorFrame,
  type GeneratorFrame,
  type GeneratorFrameRequest,
  type GeneratorFrameResult,
  type GeneratorMesh,
  type GeneratorPrimitive,
} from './generatorContract';

export {
  DEFAULT_CHECKPOINT_INTERVAL,
  MAX_CATCH_UP_PER_TURN,
  MAX_CHECKPOINTS,
  createStateCache,
  planSeek,
  recordFrame,
  resetStateCache,
  type GeneratorStateCache,
  type SeekPlan,
} from './generatorState';

export {
  GENERATE_BUDGET_MS,
  GENERATE_EXPORT_BUDGET_MS,
  MAX_CONSECUTIVE_FAILURES,
  hasGeneratorLayers,
  latestGeneratorBounds,
  requestGeneratorFrame,
  resetGenerators,
  resetGeneratorsForPlugin,
  resetGeneratorsForTests,
  setGeneratorExactMode,
  setGeneratorRunner,
  settleGenerators,
  takeGeneratorErrors,
  type GeneratorDemand,
  type GeneratorError,
  type GeneratorRunner,
} from './generatorScheduler';
