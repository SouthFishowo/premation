/**
 * Jest config for the native SDK.
 *
 * It holds no tests and is not expected to: the SDK is a header, a set of
 * types and an example addon, and what has to be PINNED about it — that its
 * version numbers match the editor's — is checked from the editor's own suite
 * (`src/core/plugins/native/nativeAbiPinned.test.ts`), which is the side that
 * would be wrong if they drifted.
 *
 * The file exists because the root config globs `packages/*` as jest projects,
 * and a project without a config falls back to defaults that do not match the
 * rest of the repo. `passWithNoTests` is NOT set here: it is not a per-project
 * option, and setting it emits a validation warning on every run of the whole
 * repo. Run this package alone with `npx jest --passWithNoTests`.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
};
