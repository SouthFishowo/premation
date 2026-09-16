/**
 * Where recovery snapshots live: an append-only ring beside the settings.
 *
 * ## Why not the settings store any more
 *
 * The newest snapshot AND a keep-N ring of whole snapshots used to be values in
 * `SettingsManager`, whose backend serialises the ENTIRE settings object on
 * every write. So each autosave rewrote every kept snapshot, and so did every
 * unrelated preference write in between — a panel resize re-stringified five
 * full documents on the main thread (127 MB for a 2000-layer project). Past the
 * origin's storage quota that write failed whole, taking every other setting
 * down with it.
 *
 * ## Layout
 *
 *   `motion-editor.recovery.index`     small JSON: newest-first entries + `latest`
 *   `motion-editor.recovery.snap.<id>` one compressed body per snapshot
 *
 * localStorage (not IndexedDB) because the launch-time recovery offer reads the
 * snapshot synchronously during boot.
 *
 * ## Crash safety is the write ORDER
 *
 *   1. write the new body under a fresh key — nothing references it yet;
 *   2. write the index (one `setItem`, atomic) pointing `latest` at it;
 *   3. delete bodies the index no longer lists.
 *
 * Dying anywhere before 2 leaves the previous index — and so the previous
 * snapshot — untouched; the stray body is swept by step 3 of the next write.
 * Dying after 2 leaves at worst an extra body, swept the same way. A body that
 * is unreadable anyway (a truncated write, quota eviction) is skipped by the
 * reader in favour of the next-newest entry.
 */

export interface RecoveryKV {
  getItem(key: string): string | null;
  /** May throw — quota exceeded, storage disabled. */
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export const RECOVERY_INDEX_KEY = 'motion-editor.recovery.index';
export const RECOVERY_BODY_KEY_PREFIX = 'motion-editor.recovery.snap.';

export interface RecoveryIndexEntry {
  id: string;
  projectId: string;
  savedAt: number;
  time: number;
}

export interface RecoveryIndex {
  v: 1;
  /** The entry the launch-time offer uses; null once the offer was cleared. */
  latest: string | null;
  /** Newest first. */
  entries: RecoveryIndexEntry[];
}

export function recoveryBodyKey(id: string): string {
  return RECOVERY_BODY_KEY_PREFIX + id;
}

/** The browser's localStorage behind the {@link RecoveryKV} seam, or null without one. */
export function localStorageKV(): RecoveryKV | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const ls = localStorage;
    return {
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

function isEntry(e: unknown): e is RecoveryIndexEntry {
  const x = e as Partial<RecoveryIndexEntry> | null;
  return !!x && typeof x.id === 'string' && typeof x.projectId === 'string'
    && typeof x.savedAt === 'number' && typeof x.time === 'number';
}

export function readRecoveryIndex(kv: RecoveryKV): RecoveryIndex | null {
  try {
    const raw = kv.getItem(RECOVERY_INDEX_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RecoveryIndex> | null;
    if (!v || v.v !== 1 || !Array.isArray(v.entries)) return null;
    return { v: 1, latest: typeof v.latest === 'string' ? v.latest : null, entries: v.entries.filter(isEntry) };
  } catch {
    return null;
  }
}

function writeIndex(kv: RecoveryKV, index: RecoveryIndex): void {
  kv.setItem(RECOVERY_INDEX_KEY, JSON.stringify(index));
}

/** Delete every stored body whose id is not in `keep` (orphans included). */
function pruneBodies(kv: RecoveryKV, keep: ReadonlySet<string>): void {
  try {
    for (const k of kv.keys()) {
      if (k.startsWith(RECOVERY_BODY_KEY_PREFIX) && !keep.has(k.slice(RECOVERY_BODY_KEY_PREFIX.length))) {
        kv.removeItem(k);
      }
    }
  } catch {
    /* the next write sweeps again */
  }
}

/**
 * Append one snapshot and make it the latest, keeping at most `keep`.
 *
 * Returns false when it could not be stored. The index is then exactly what it
 * was, so the previous snapshot is still the one on offer.
 */
export function appendRecoverySnapshot(
  kv: RecoveryKV,
  entry: RecoveryIndexEntry,
  body: string,
  keep: number,
): boolean {
  const prev = readRecoveryIndex(kv) ?? { v: 1 as const, latest: null, entries: [] };
  const older = prev.entries.filter((e) => e.id !== entry.id);
  const evicted = new Set<string>();

  // 1 — the body, under a key nothing references yet.
  for (;;) {
    try {
      kv.setItem(recoveryBodyKey(entry.id), body);
      break;
    } catch {
      // Out of room: give the OLDEST snapshots' space to the newest. Never the
      // one currently on offer — if this write then fails too, that one must
      // still be there.
      const victim = [...older].reverse().find((e) => !evicted.has(e.id) && e.id !== prev.latest);
      if (!victim) return false;
      try { kv.removeItem(recoveryBodyKey(victim.id)); } catch { /* counted as gone either way */ }
      evicted.add(victim.id);
    }
  }

  // 2 — the index: the atomic switch to the new snapshot.
  const entries = [entry, ...older.filter((e) => !evicted.has(e.id))].slice(0, Math.max(1, keep));
  try {
    writeIndex(kv, { v: 1, latest: entry.id, entries });
  } catch {
    try { kv.removeItem(recoveryBodyKey(entry.id)); } catch { /* swept next time */ }
    return false;
  }

  // 3 — sweep what the index no longer lists.
  pruneBodies(kv, new Set(entries.map((e) => e.id)));
  return true;
}

/**
 * Re-stamp the latest entry without rewriting its body — an autosave tick whose
 * document is byte-identical to the stored one. Index-only, so it is cheap.
 */
export function touchRecoveryLatest(kv: RecoveryKV, savedAt: number): boolean {
  const index = readRecoveryIndex(kv);
  if (!index || index.latest === null) return false;
  const entries = index.entries.map((e) => (e.id === index.latest ? { ...e, savedAt } : e));
  try {
    writeIndex(kv, { ...index, entries });
    return true;
  } catch {
    return false;
  }
}

/** Withdraw the launch-time offer. The kept ring stays, as it always did. */
export function clearRecoveryLatest(kv: RecoveryKV): void {
  const index = readRecoveryIndex(kv);
  if (!index || index.latest === null) return;
  try {
    writeIndex(kv, { ...index, latest: null });
  } catch {
    /* nothing better to do */
  }
}
