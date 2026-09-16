/**
 * One plugin's own output, where a person can read it.
 *
 * A plugin runs in a Worker. Its `console.log` lands in a DevTools window the
 * user of a packaged app does not have — so an author debugging their own
 * plugin had nowhere to look, and a user reporting "it does nothing" had
 * nothing to attach. The host has kept the last 200 lines per plugin for a
 * while (`PluginHost.appendLog`); this is the surface that shows them.
 *
 * Stack frames arrive already MAPPED: the worker substitutes each blob URL it
 * minted for the package path whose source it holds, so a frame reads
 * `at draw (lib/draw.js:41:9)` rather than `at draw (blob:null/6f2a…:41:9)`.
 * That mapping has to happen in the worker, because it is the only side that
 * knows which URL holds which file.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import styles from './LocalPlugins.module.css';

export function PluginLogSheet({
  pluginId,
  onClose,
}: {
  pluginId: string;
  onClose: () => void;
}): JSX.Element {
  const name = usePluginStore((s) => s.get(pluginId)?.manifest.name) ?? pluginId;
  // Re-read on every host revision rather than holding a copy: the log is
  // appended to from the worker's message handler, and a snapshot taken at
  // mount would stop updating exactly while an author is watching it fail.
  const [, bump] = useState(0);
  const bodyRef = useRef<HTMLPreElement>(null);

  useEffect(() => pluginHost.subscribe(() => bump((n) => n + 1)), []);

  const lines = pluginHost.log(pluginId);
  const info = pluginHost.info(pluginId);

  // Pinned to the newest line, which is the one that matters when something
  // just went wrong.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const copy = useCallback(() => {
    const text = lines.map((l) => `[${(l.at / 1000).toFixed(2)}s] ${l.level}: ${l.text}`).join('\n');
    void navigator.clipboard?.writeText(text);
  }, [lines]);

  return (
    <div className={styles.logOverlay} role="dialog" aria-modal="true" aria-label={`${name} log`}>
      <div className={styles.logSheet}>
        <header className={styles.logHead}>
          <span className={styles.logTitle}>{name}</span>
          <span className={styles.logStatus}>{info.status}{info.error ? ` — ${info.error}` : ''}</span>
          <div className={styles.headActions}>
            <button type="button" className={styles.action} onClick={copy}>Copy</button>
            <button
              type="button"
              className={styles.action}
              onClick={() => { pluginHost.clearLog(pluginId); bump((n) => n + 1); }}
            >
              Clear
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Close log"
              onClick={onClose}
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
        </header>
        <pre ref={bodyRef} className={styles.logBody}>
          {lines.length === 0
            ? 'Nothing logged yet. Anything this plugin prints with console.log appears here.'
            : lines.map((l, i) => (
              <span key={`${l.at}-${i}`} className={styles[`log_${l.level}`]}>
                {`[${(l.at / 1000).toFixed(2)}s] ${l.text}\n`}
              </span>
            ))}
        </pre>
      </div>
    </div>
  );
}
