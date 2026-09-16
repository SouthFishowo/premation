/**
 * `npm run bench` — the timed benchmark suites (`*.bench.test.ts`).
 *
 * Same transforms, aliases and setup as the unit suite (jest.config.cjs), but
 * only the root project, only bench files, and never in the default `jest`
 * run, which ignores them. Results print to the console and are written as
 * JSON under `.artifacts/bench/` (gitignored) so a later change can be
 * compared against an earlier run on the same machine.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const base = { ...require('./jest.config.cjs') };
// The root project only — the workspace packages hold no benches.
delete base.projects;

module.exports = {
  ...base,
  testMatch: ['**/?(*.)+(bench.test).[jt]s?(x)'],
  testPathIgnorePatterns: base.testPathIgnorePatterns.filter((p) => !p.includes('bench')),
  // Benchmarks are slow by nature; one scenario can take tens of seconds
  // under jsdom + ts-jest.
  testTimeout: 300000,
};
