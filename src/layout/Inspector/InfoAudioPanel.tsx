import { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '@stores/projectStore';
import { audioEngine } from '@core/audio/AudioEngine';
import { toDb, meterFraction } from '@core/audio/audioLevels';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { InfoReadout } from './InfoReadout';
import styles from './InfoAudioPanel.module.css';

/**
 * Info — three flat readout groups: the pointer, the composition, and the
 * master meter. The on-demand `info` panel.
 *
 * The pointer and composition groups are `InfoReadout`, shared with the Audio
 * panel, which carries them compactly at its top since the two right-rail tabs
 * were merged (2026-09-15).
 *
 * Rows, not cards. The panel used to draw each group in its own bordered,
 * rounded box, so a 280px column held three boxes inside a box; a readout is a
 * list of labelled values, and a rule between groups is all the structure it
 * needs.
 */
export function InfoAudioPanel(): JSX.Element {
  const playing = useWorkspaceStore((s) => (s.activeTabId ? (s.tabs[s.activeTabId]?.playing ?? false) : false));

  const [bars, setBars] = useState<{ l: number; r: number }>({ l: 0, r: 0 });
  const [volumeDb, setVolumeDb] = useState(0);
  const [muted, setMuted] = useState(false);
  const raf = useRef(0);

  useEffect(() => {
    if (!playing) {
      setBars({ l: 0, r: 0 });
      return;
    }
    const loop = (): void => {
      const lv = audioEngine.getLevels();
      if (lv) {
        setBars({ l: meterFraction(toDb(lv.l.peak)), r: meterFraction(toDb(lv.r.peak)) });
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const volumeLabel = `${volumeDb > 0 ? `+${volumeDb}` : volumeDb} dB`;

  return (
    <div className={styles.root}>
      {/* ── Pointer + Composition ── */}
      <InfoReadout />

      {/* ── Audio ── */}
      <section className={styles.group} aria-label="Audio">
        <div className={styles.groupHead}>
          <span className={styles.groupLabel}>Audio</span>
          <button
            type="button"
            className={cn(styles.iconBtn, muted && styles.iconBtnMuted)}
            onClick={() => setMuted(!muted)}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute audio' : 'Mute audio'}
            title={muted ? 'Unmute audio' : 'Mute audio'}
          >
            <Icon name={muted ? 'audio-off' : 'audio'} size="sm" />
          </button>
        </div>

        <div className={styles.meterTrack}>
          <div className={styles.channelRow}>
            <span className={styles.channelLabel}>L</span>
            <div className={styles.meterBar}>
              <div className={styles.meterCover} style={{ transform: `scaleX(${muted ? 1 : (1 - bars.l).toFixed(3)})` }} />
            </div>
          </div>
          <div className={styles.channelRow}>
            <span className={styles.channelLabel}>R</span>
            <div className={styles.meterBar}>
              <div className={styles.meterCover} style={{ transform: `scaleX(${muted ? 1 : (1 - bars.r).toFixed(3)})` }} />
            </div>
          </div>
          <div className={styles.scaleRow} aria-hidden="true">
            <span>-48</span>
            <span>-24</span>
            <span>-12</span>
            <span>-6</span>
            <span>0</span>
            <span>+6</span>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.key}>Master</span>
          <input
            type="range"
            min="-48"
            max="12"
            value={volumeDb}
            onChange={(e) => setVolumeDb(Number(e.target.value))}
            className={styles.volumeSlider}
            aria-label="Master volume"
            title={`Master volume: ${volumeLabel}`}
          />
          <span className={cn(styles.value, styles.mono, styles.volumeValue)}>{volumeLabel}</span>
        </div>
      </section>
    </div>
  );
}
