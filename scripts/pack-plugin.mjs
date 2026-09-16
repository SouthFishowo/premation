#!/usr/bin/env node
/**
 * Turn a plugin folder into a `.mplugin` package — and, optionally, sign it.
 *
 *   node scripts/pack-plugin.mjs ./my-plugin
 *   node scripts/pack-plugin.mjs ./my-plugin --out dist/my-plugin.mplugin
 *   node scripts/pack-plugin.mjs ./my-plugin --key ./plugin-key.json
 *
 * ── Why this exists next to `sign-plugin.mjs` ────────────────────────────────
 *
 * That one is about the REGISTRY: make a key, sign bytes, upload. This one is
 * about the folder tier — the `.mplugin` a user drops into their plugins
 * directory, or a vendor installer writes there. The two produce compatible
 * signatures deliberately (same curve, same digest, same detached form), so a
 * package signed for the registry verifies locally and vice versa.
 *
 * ── What the check is worth ──────────────────────────────────────────────────
 *
 * Everything here is also checked by the editor when it reads the package, and
 * that check is the one that matters — it runs on the user's machine over the
 * bytes actually being installed. The value of running it HERE is when the
 * author finds out. "This package has no plugin.json at its root" is a fixable
 * sentence at pack time and a support ticket after a release.
 *
 * The manifest GRAMMAR is not fully validated here, and that is deliberate
 * rather than an omission. `parseManifest` is TypeScript in the renderer's
 * module graph, and a second implementation in this file would be a second
 * definition of the format, free to drift from the one that gates an install —
 * the exact failure `fixtures-hash.mjs` exists to prevent between repos. What
 * is checked here is what a PACKAGER can check without owning the grammar:
 * the file layout, the paths the manifest points at, the extension allowlist
 * and the size ceilings.
 */

import { createHash, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, basename, resolve, dirname, extname } from 'node:path';
import { zipSync } from 'fflate';

/**
 * The ceilings and the allowlist, mirrored from the app.
 *
 * Duplicated rather than imported for the reason above: this is a plain Node
 * script and the app's copies are TypeScript. Drift here can only make the
 * packer refuse something the editor would have taken — never the reverse —
 * because the editor re-checks all of it.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 5000;

const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.html', '.htm', '.css', '.svg', '.txt', '.md', '.wgsl', '.glsl']);
const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.wasm',
  '.bin', '.onnx', '.glb', '.gltf', '.ttf', '.otf', '.woff2',
  '.cube', '.exr', '.hdr', '.mp3', '.wav',
]);
/** Named so the refusal can say WHY, rather than "unknown extension". */
const NATIVE_EXT = new Set(['.node', '.dll', '.so', '.dylib', '.exe', '.dSYM', '.msi']);

const MANIFEST_NAME = 'plugin.json';

/** Flags that take no value. Without this, `--native --key k` eats `--key`. */
const BOOLEAN_FLAGS = new Set(['native']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) out[name] = true;
      else { out[name] = argv[i + 1]; i += 1; }
    } else out._.push(a);
  }
  return out;
}

const problems = [];
function problem(msg) { problems.push(msg); }

/** Folders a pack walks past — the same convention the app's scanner uses. */
function isSkippedFolder(name) {
  return name.endsWith('()') || name.startsWith('~') || name.startsWith('.') || name === 'node_modules';
}

/**
 * Collect the files that belong in the package.
 *
 * Refusals are COLLECTED rather than thrown one at a time: a folder usually
 * fails for more than one reason, and fixing them one run at a time is the
 * slowest possible way to learn what they are.
 */
function collectFiles(root, allowNative) {
  const files = new Map();
  let total = 0;

  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isSkippedFolder(entry.name)) continue;
        walk(full, relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      const isNative = NATIVE_EXT.has(ext);
      if (isNative) {
        /*
          Compiled code is packaged only when it is ASKED for.

          `--native` is not a convenience flag, it is the author saying out loud
          that this package contains a program. Everything downstream of that
          is different — the editor needs a signature AND a separate consent
          step naming the binary, and the user is told it runs outside the
          sandbox — and none of that should be reachable by dropping a `.dll`
          into a folder and not noticing.
        */
        if (!allowNative) {
          problem(
            `${relPath} is a native module. A .mplugin carries JavaScript, WebAssembly and data by `
            + 'default; compiled libraries are a separate tier with its own consent step. Pass '
            + '--native to package it, and --key to sign it (an unsigned native plugin loads only '
            + 'in Developer Mode).',
          );
          continue;
        }
      }
      if (!isNative && entry.name !== MANIFEST_NAME && !TEXT_EXT.has(ext) && !ASSET_EXT.has(ext)) continue;

      const size = statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        problem(`${relPath} is ${Math.round(size / 1024 / 1024)} MB; the limit for one file is ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      total += size;
      files.set(relPath, new Uint8Array(readFileSync(full)));
    }
  };

  walk(root, '');

  if (files.size > MAX_FILES) problem(`The package holds ${files.size} files; the limit is ${MAX_FILES}.`);
  if (total > MAX_PACKAGE_BYTES) {
    problem(`The package is ${Math.round(total / 1024 / 1024)} MB; the limit is ${MAX_PACKAGE_BYTES / 1024 / 1024} MB.`);
  }
  return files;
}

/**
 * Check the layout the editor will check, and report every failure at once.
 *
 * Returns the parsed manifest, or null. The fields read here are exactly the
 * ones a PACKAGER needs — an id to name the file, a version to put in it, and
 * the paths it must prove exist.
 */
function checkPackage(files) {
  const manifestBytes = files.get(MANIFEST_NAME);
  if (!manifestBytes) {
    problem(`No ${MANIFEST_NAME} at the root of the folder. That file is what makes a folder a plugin.`);
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (err) {
    problem(`${MANIFEST_NAME} is not valid JSON: ${err.message}`);
    return null;
  }

  for (const field of ['id', 'name', 'version', 'description', 'main']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      problem(`${MANIFEST_NAME} is missing "${field}".`);
    }
  }
  if (typeof manifest.apiVersion !== 'number') problem(`${MANIFEST_NAME} is missing a numeric "apiVersion".`);

  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (typeof manifest.main === 'string' && !files.has(norm(manifest.main))) {
    problem(`"main" points at ${manifest.main}, which is not in the folder.`);
  }
  for (const panel of manifest.contributes?.panels ?? []) {
    if (panel?.entry && !files.has(norm(panel.entry))) {
      problem(`Panel "${panel.id}" points at ${panel.entry}, which is not in the folder.`);
    }
  }
  if (typeof manifest.panel === 'string' && !files.has(norm(manifest.panel))) {
    problem(`"panel" points at ${manifest.panel}, which is not in the folder.`);
  }

  return manifest;
}

/**
 * Record a SHA-256 for every binary the manifest declares, into the manifest.
 *
 * Why the hashes go INSIDE the package rather than beside it: the package is
 * signed as a whole, so a hash written here is covered by that signature, and
 * a hash in a sidecar is not. The editor does not trust these numbers — it
 * measures the file it is about to load — but it can say something much more
 * useful when they disagree: "this binary is not the one the package was built
 * with", rather than "the hash changed", which tells a user nothing about who
 * changed it.
 *
 * Mutates `manifest` and rewrites `plugin.json` in `files`, because the zip is
 * built from that map moments later and the hashes have to be in the bytes
 * that get signed.
 */
function recordNativeHashes(files, manifest) {
  const native = manifest.native;
  if (!native || typeof native !== 'object') {
    problem(
      '--native was passed and this package declares no "native" block. Add one naming a binary '
      + 'per platform-arch, or drop the flag.',
    );
    return;
  }
  const platforms = native.platforms;
  if (!platforms || typeof platforms !== 'object') {
    problem('"native.platforms" must map a platform-arch key ("win32-x64") to a path in this folder.');
    return;
  }
  if (typeof native.abi !== 'number') {
    problem('"native.abi" must be the whole MAJOR ABI number the module was built against.');
  }

  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const hashes = {};
  for (const [key, value] of Object.entries(platforms)) {
    const path = norm(value);
    const bytes = files.get(path);
    if (!bytes) {
      problem(`"native.platforms.${key}" points at ${value}, which is not in the folder.`);
      continue;
    }
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
  }

  manifest.native = { ...native, hashes };
  files.set(MANIFEST_NAME, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
}

/** ECDSA P-256 / SHA-256, IEEE-P1363 — what the editor's verifier accepts. */
function signBytes(bytes, record) {
  const key = createPrivateKey({
    key: Buffer.from(record.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return nodeSign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args._[0];
  if (!source) {
    console.log(`
  Pack a plugin folder into a .mplugin package

    node scripts/pack-plugin.mjs <folder> [--out <file>] [--key <plugin-key.json>] [--native]

    --out     where to write the package (default: <id>-<version>.mplugin beside the folder)
    --key     also write <out>.sig, so the package loads without Developer Mode
    --native  package the compiled modules "native.platforms" names, and record
              a sha256 for each in the manifest. Without it a native module is
              refused, so a package cannot contain a program by accident.
`);
    process.exitCode = 1;
    return;
  }

  const root = resolve(source);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`\n  ${source} is not a folder.\n`);
    process.exitCode = 1;
    return;
  }

  const native = args.native === true;
  const files = collectFiles(root, native);
  const manifest = checkPackage(files);
  // After `checkPackage`, so a malformed manifest is reported once rather than
  // once here and once there; and before the zip, because the hashes have to be
  // in the bytes that get signed.
  if (manifest && native) recordNativeHashes(files, manifest);

  if (problems.length > 0) {
    console.error(`\n  ${basename(root)} cannot be packaged:\n`);
    for (const p of problems) console.error(`    • ${p}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  const out = resolve(
    args.out ?? join(dirname(root), `${manifest.id}-${manifest.version}.mplugin`),
  );
  mkdirSync(dirname(out), { recursive: true });

  // Flat at the root, not wrapped in a directory. The reader strips a single
  // wrapping directory anyway, so both work — this is the shape that reads
  // correctly in any zip tool.
  const bytes = zipSync(Object.fromEntries(files), { level: 9 });
  writeFileSync(out, bytes);

  console.log(`\n  ${manifest.name} ${manifest.version}`);
  console.log(`  ${out}`);
  console.log(`  ${files.size} files, ${(bytes.length / 1024).toFixed(1)} KB`);
  console.log(`  sha256  ${createHash('sha256').update(bytes).digest('hex')}`);

  if (args.key) {
    if (!existsSync(args.key)) {
      console.error(`\n  No key at ${args.key}. Run: node scripts/sign-plugin.mjs keygen\n`);
      process.exitCode = 1;
      return;
    }
    const record = JSON.parse(readFileSync(args.key, 'utf8'));
    if (!record.privateKey || !record.publicKey) {
      console.error(`\n  ${args.key} is not a key file written by keygen.\n`);
      process.exitCode = 1;
      return;
    }
    const sidecar = {
      algorithm: 'ECDSA-P256-SHA256',
      signature: signBytes(bytes, record),
      publicKey: record.publicKey,
    };
    writeFileSync(`${out}.sig`, `${JSON.stringify(sidecar, null, 2)}\n`);
    console.log(`  signed  ${out}.sig`);
    console.log('\n  A signed package loads without Developer Mode. Keep the key file.');
  } else {
    console.log('\n  Unsigned. It will load only with Developer Mode on — pass --key to sign it.');
    if (native) {
      // Worth its own line rather than folding into the sentence above: an
      // unsigned package with a program in it is the one combination where
      // "it will load in Developer Mode" understates what is at stake.
      console.log('  This package contains a compiled module. Unsigned, it runs only on machines');
      console.log('  with Developer Mode on, and only after the user allows the binary by name.');
    }
  }
  console.log('');
}

main();
