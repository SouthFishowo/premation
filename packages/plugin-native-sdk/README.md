# Premation native plugin SDK

A plugin may ship a **compiled** module — an N-API addon, or a Rust/C++ `cdylib`
behind an N-API shim — for work no script will do fast enough: decoders,
trackers, solvers, big pixel kernels.

It runs **out of process**. One Electron `utilityProcess` per plugin, started on
first use, stopped when idle, killed and restarted when it hangs or crashes. The
editor keeps rendering either way; the frame that needed the addon goes out with
the layer unchanged and the failure is reported against the plugin by name.

This package is the contract and nothing else:

| Path | What it is |
| --- | --- |
| `include/motion_plugin_abi.h` | The ABI: version macros, the five exports, the string constants |
| `src/abi.ts` | The same contract as TypeScript types, for a shim or an editor |
| `example/` | A working addon, both build files, and the plugin folder around it |

Nothing here is compiled by the editor's build or by its CI. There is no native
toolchain in this repository and adding one is not planned: an addon is built by
the person who wrote it, on the platforms they support, and shipped as bytes.

## The five exports

```c
uint32 motion_plugin_abi_version(void);          /* MOTION_PLUGIN_ABI_VERSION */
object motion_plugin_register(object hostInfo);  /* once per process */
object motion_plugin_describe(void);             /* what this addon implements */
object motion_plugin_render(object request);     /* the work — synchronous */
void   motion_plugin_dispose(void);              /* normal shutdown only */
```

`motion_plugin_abi_version` is called first and alone. It returns
`major * 1000 + minor`. The host refuses a **different MAJOR** and a **newer
MINOR**, naming both versions — it never calls into a binary whose contract it
does not agree about.

`motion_plugin_render` dispatches on `request.call`:

- `"effect"` — pixels in, pixels out. You are handed an `input` and an `output`
  buffer of the same size in the layout you asked for in
  `describe().pixelFormat` (default: premultiplied 32-bit float RGBA). Write
  into `output` and return it, or return `{ ok: true, identity: true }` to say
  you changed nothing and let the host skip the copy back.
- `"generate"` — a frame of instanced geometry for a generator layer.
- `"invoke"` — `{ method, payload }` for anything that is not pixels.

Answer only the calls you list in `describe().calls`; the host refuses the rest
before it reaches you.

## Building the example

```sh
cd packages/plugin-native-sdk/example
npm install                 # node-addon-api headers only
```

**node-gyp** (simplest):

```sh
npx node-gyp rebuild
# → build/Release/motion_example.node
```

**cmake-js** (use this when the addon has real dependencies):

```sh
npx cmake-js compile --runtime electron --runtime-version <electron version>
# → build/Release/motion_example.node
```

### Build against Electron, not against Node

The addon is loaded by an Electron `utilityProcess`, so it must be built for
Electron's V8 — that is what `--runtime electron --runtime-version` above does,
and what `@electron/rebuild` does for an addon with dependencies. An addon built
for plain Node loads in a Node shell and fails in the editor, which is the worst
possible order in which to find out.

N-API insulates you from V8's version, so a Node-API addon built for one
Electron line keeps working across the next; a Nan/V8 addon does not. Build
Node-API.

### Per platform

The manifest names one binary per `platform-arch` pair, and the host picks by
`process.platform` + `process.arch` at load:

```jsonc
"native": {
  "abi": 1,
  "platforms": {
    "win32-x64":    "bin/win32-x64/motion_example.node",
    "darwin-arm64": "bin/darwin-arm64/motion_example.node",
    "darwin-x64":   "bin/darwin-x64/motion_example.node",
    "linux-x64":    "bin/linux-x64/motion_example.node"
  }
}
```

A package with no entry for the machine it is installed on is listed as
**unavailable on this platform** — not as broken, and not as an error the user
has to interpret. Ship a JavaScript or WebAssembly fallback (see
`example/plugin/fallback.js`) and that user still gets the effect, slowly.

macOS binaries must be signed and hardened-runtime compatible, or Gatekeeper
refuses them on a machine that did not build them.

## Packing and signing

```sh
node scripts/pack-plugin.mjs ./my-plugin --native --key ./plugin-key.json
```

`--native` is required: without it the packer refuses compiled files and says
so. With it, the binaries named in `native.platforms` are packaged, and the
SHA-256 of each is written into the manifest's `native.hashes`.

Native code is **unsandboxed**, so the editor requires both:

1. a valid signature over the package (`--key`, or Developer Mode for an
   unsigned working copy), and
2. a separate consent step naming the binary and its hash, worded for what it
   is: code that runs with the user's full privileges, outside the sandbox.

Changing the binary changes its hash, which re-asks. Revoking the plugin kills
its process.

## Rules for the addon itself

- **Write globals only in `register`.** The host may have two render calls in
  flight when you declare `threadSafety: "full"`; anything written during a
  render has to be per-call.
- **Declare `threadSafety` honestly.** `unsafe` serialises every call to your
  process, `instance` serialises per effect instance, `full` runs them
  concurrently. Over-declaring costs one wrong frame in a hundred, which is
  unreportable; under-declaring costs throughput and nothing else.
- **Do not block on anything external.** The host holds a hard per-call timeout
  and kills the process when it expires. Blocking on the CPU is what this tier
  is for; blocking on a socket is not.
- **Do not keep a reference to a pixel buffer after you answer.** Its memory is
  transferred back to the host, and reading it afterwards reads memory that
  belongs to another process.
- **`dispose` is not guaranteed.** It runs on an idle shutdown, a reload and a
  revocation; it does not run when the process is killed for hanging or
  crashing. Nothing whose absence would corrupt a user's disk may depend on it.
