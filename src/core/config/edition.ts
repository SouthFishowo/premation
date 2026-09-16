/**
 * Which edition of the app this build is.
 *
 * There are two, and the difference is entirely about whether motion-back
 * exists:
 *
 *  • `'server'` — the hosted product. Accounts, cloud projects, billing, the
 *    encrypted sync vault and the AI gateway all work exactly as they always
 *    have. This is the DEFAULT, so a build that says nothing gets today's
 *    behaviour byte for byte.
 *
 *  • `'local'` — the open-source desktop edition. There is no backend to talk
 *    to, so every surface that only makes sense with one is absent rather than
 *    broken: no sign-in, no dashboard, no billing, no sync. The assistant runs
 *    bring-your-own-key through the OS keystore instead of the hosted gateway.
 *    Projects, assets, version history and export are all local (see
 *    `isLocalFirst`, which this edition implies).
 *
 * The value is a module-level variable set once at boot by `setEdition`, not
 * read from `import.meta.env` here — `import.meta` trips Jest under this repo's
 * CJS transform, so the env read lives in the app entry (`main.tsx`), which
 * tests never import, and tests set the edition directly. This mirrors
 * `./flags`, deliberately: one pattern for build-time switches, not two.
 *
 * Call sites should prefer the capability predicates below over asking which
 * edition it is. `billingEnabled()` says WHY the code is gated; `isLocalEdition()`
 * only says where it happens to be true today — and the day a third edition or
 * a self-hosted backend appears, the capability reads still mean what they say.
 */

export type Edition = 'server' | 'local';

/** Default 'server': an unconfigured build behaves exactly as it did before. */
let edition: Edition = 'server';

/** Parse an env string into an edition. Anything unrecognised means 'server'. */
export function parseEdition(raw: string | undefined | null): Edition {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'local' || v === 'oss' ? 'local' : 'server';
}

export function getEdition(): Edition {
  return edition;
}

/** Set at boot from the build env; also the test seam. */
export function setEdition(next: Edition): void {
  edition = next;
}

export function isLocalEdition(): boolean {
  return edition === 'local';
}

export function isServerEdition(): boolean {
  return edition === 'server';
}

// ── Capabilities ────────────────────────────────────────────────────────────
// Each one answers "can this build do X", and every one of them is true in the
// server edition. Read these, not the edition.

/**
 * Accounts: sign-in, registration, OAuth, sessions, password reset.
 *
 * Off in the local edition, which is what removes the auth routes entirely —
 * `RequireAuth` cannot gate what has no credential to check.
 */
export const cloudAccountsEnabled = (): boolean => isServerEdition();

/**
 * Cloud project storage: the dashboard, cloud autosave, cloud thumbnails, the
 * server-side version history, and the cloud asset library.
 *
 * Off in the local edition — the `.motion` bundle on disk is the project.
 */
export const cloudProjectsEnabled = (): boolean => isServerEdition();

/** Plans, credits and checkout. */
export const billingEnabled = (): boolean => isServerEdition();

/** The opt-in, client-encrypted, paid project-sync vault. */
export const cloudSyncEnabled = (): boolean => isServerEdition();

/**
 * The assistant — the whole surface, not just the transport.
 *
 * On in both editions. The local edition runs bring-your-own-key through the
 * OS keystore and `electron/aiProxy.ts`; the server edition runs through
 * motion-back. Read `aiRunsThroughBackend()` when the question is where the
 * key lives — that is the only thing that differs.
 *
 * ── This gate is load-bearing ───────────────────────────────────────────────
 *
 * Surfaces are gated individually (panel registry, panel renderers, the
 * Customize dialog's AI tab, the AI-focus workspace) and in the main process
 * (`electron/edition.ts`, which gates IPC registration). `editionAiSurface.test.ts`
 * asserts those surfaces stay wired to this predicate. Flipping it off again
 * is one line; leaving the surfaces ungated while this is false would hide
 * nothing.
 */
export const aiEnabled = (): boolean => true;

/**
 * Does the assistant run through the backend, or through the desktop shell?
 *
 * Read this rather than the edition when the question is "where does the key
 * live", because that is the only thing that actually differs. The server edition
 * proxies through motion-back (which encrypts keys at rest with AI_KEY_SECRET);
 * the local edition uses the OS keystore and the main process.
 */
export const aiRunsThroughBackend = (): boolean => isServerEdition();

/**
 * Plugins — the sandbox, the host API, and installing from a local file.
 *
 * ON in both editions. The local edition was briefly plugin-less on the
 * argument that the registry, review queue and revocation list are what make
 * running third-party code defensible. That conflated two things. Those
 * mechanisms protect REGISTRY installs; a package the user picked from their own
 * disk never went through them in either edition. What actually protects a
 * local install is the same in both: the manifest parsed before any code
 * exists, the per-permission consent screen, the signature check when the
 * package carries one, and the Worker sandbox. None of those need a backend.
 * An offline After-Effects-style editor that cannot load a plugin file is the
 * product with its most-requested capability removed.
 *
 * What stays server-only is everything that needs motion-back — browsing and
 * downloading from the registry, update checks, the revocation list, the
 * account's installed-set sync, publishing — and that is `pluginRegistryEnabled`
 * below, asked at the network boundary in `registry.ts`, plus
 * `pluginPublishEnabled` in the main process.
 *
 * ── Still load-bearing ───────────────────────────────────────────────────────
 *
 * Every plugin surface still reads this predicate individually — the panel
 * registry, the Plugins menu group, the layer-creation entries, the effects
 * browser folder, the command palette, and the host's boot in `Providers` — and
 * `editionPluginSurface.test.ts` keeps that list honest, so turning the feature
 * off again for some future build is one line that actually hides everything.
 *
 * Deliberately never gated: reading plugin content out of a DOCUMENT. A project
 * containing a custom layer kind, a plugin effect or a proxy subtree opens,
 * renders and re-saves byte-identically without the plugin installed.
 * `uninstalledDocumentRoundTrip.test.ts` is that property.
 */
export const pluginsEnabled = (): boolean => true;

/**
 * The hosted plugin registry (browse / download / update checks).
 *
 * Narrower than `pluginsEnabled` and kept separate on purpose: this is the
 * question "may this code make a network request to the marketplace", and it is
 * asked deep inside `registry.ts`, where the answer must hold whatever the UI
 * above it did. A local build making one request to our backend on boot is a
 * telemetry problem regardless of which surface is hidden, so the network gate
 * lives at the network, not at the button.
 */
export const pluginRegistryEnabled = (): boolean => isServerEdition();
