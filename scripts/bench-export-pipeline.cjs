#!/usr/bin/env node
/**
 * Export throughput: the streaming ffmpeg pipe vs the staged image sequence.
 *
 *   node scripts/bench-export-pipeline.cjs [--frames 120] [--formats mp4,mov] [--keep]
 *
 * End to end through the REAL headless CLI (`premation render`), so every cost
 * is in the number: the offline render, readback, IPC, ffmpeg. The two runs
 * differ only in MOTION_EXPORT_PIPELINE (`staged` forces the old path; unset
 * streams). Each format also gets a pixel check: ffmpeg `framemd5` of both
 * outputs, which must match for formats that staged PNG (mov) and is reported,
 * not asserted, for formats that staged JPEG (mp4 — the stream drops a lossy
 * JPEG generation, so its pixels are expected to differ slightly).
 *
 * Needs `npm run electron:compile && npm run build:local` first, ffmpeg on
 * PATH (or FFMPEG_PATH), and a GPU-capable session. Skips (exit 0) when any of
 * those is missing, so CI without them stays green.
 *
 * The fixture is a 1920x1080 comp: a solid background, six animated shapes and
 * three text layers, written by `src/core/export/exportBenchFixture.test.ts`
 * (run through jest so it serialises with the app's own document code).
 */

const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const MAIN = path.join(REPO, 'dist-electron', 'main.js');
const RENDERER = path.join(REPO, 'dist', 'index.html');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const FRAMES = Number(arg('frames', '120'));
const FORMATS = arg('formats', 'mp4,mov').split(',');
const KEEP = argv.includes('--keep');

function skip(reason) {
  console.log(`[bench-export] skipped: ${reason}`);
  process.exit(0);
}

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
if (spawnSync(ffmpeg, ['-version']).status !== 0) skip('ffmpeg is not available');
if (!existsSync(MAIN) || !existsSync(RENDERER)) skip('run `npm run electron:compile && npm run build:local` first');

const work = mkdtempSync(path.join(tmpdir(), 'bench-export-'));
const fixture = path.join(work, 'bench.json');

const gen = spawnSync(
  process.execPath,
  [path.join(REPO, 'node_modules', 'jest', 'bin', 'jest.js'), 'src/core/export/exportBenchFixture.test.ts'],
  { cwd: REPO, env: { ...process.env, MOTION_EXPORT_BENCH_FIXTURE: fixture }, encoding: 'utf8' },
);
if (!existsSync(fixture)) {
  console.error(gen.stdout, gen.stderr);
  throw new Error('fixture generation failed');
}

const electron = require(path.join(REPO, 'node_modules', 'electron'));

function render(format, pipeline, out) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MOTION_EDITION: 'local' };
    if (pipeline === 'staged') env.MOTION_EXPORT_PIPELINE = 'staged';
    else delete env.MOTION_EXPORT_PIPELINE;
    const started = Date.now();
    const child = spawn(
      electron,
      [MAIN, 'render', fixture, '--format', format, '--range', `0-${FRAMES - 1}`, '--out', out, '--quiet', '--json'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const ms = Date.now() - started;
      if (code !== 0 || !existsSync(out)) reject(new Error(`${format}/${pipeline} exited ${code}:\n${log.slice(-2000)}`));
      else resolve({ ms, bytes: statSync(out).size });
    });
  });
}

function framemd5(file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return r.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

(async () => {
  const rows = [];
  for (const format of FORMATS) {
    // Warm-up render (shader compile, font load) so neither measured run pays it.
    await render(format, 'stream', path.join(work, `warm.${format}`)).catch(() => undefined);
    const staged = await render(format, 'staged', path.join(work, `staged.${format}`));
    const stream = await render(format, 'stream', path.join(work, `stream.${format}`));
    const a = framemd5(path.join(work, `staged.${format}`));
    const b = framemd5(path.join(work, `stream.${format}`));
    const same = a.length === b.length && a.every((h, i) => h === b[i]);
    rows.push({
      format,
      frames: FRAMES,
      stagedMs: staged.ms,
      streamMs: stream.ms,
      stagedFps: +(FRAMES / (staged.ms / 1000)).toFixed(1),
      streamFps: +(FRAMES / (stream.ms / 1000)).toFixed(1),
      speedup: +(staged.ms / stream.ms).toFixed(2),
      decodedFrames: `${a.length}/${b.length}`,
      identicalPixels: same,
    });
  }
  console.table(rows);
  console.log(JSON.stringify(rows));
  if (!KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`[bench-export] outputs kept in ${work}`);
})().catch((err) => {
  console.error(err);
  if (!KEEP) rmSync(work, { recursive: true, force: true });
  process.exit(1);
});
