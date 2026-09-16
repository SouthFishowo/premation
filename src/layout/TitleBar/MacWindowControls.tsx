import { getWindowControls } from '@core/config/uiPlatform';
import styles from './TitleBar.module.css';

/**
 * The traffic-light corner of a macOS window.
 *
 * On a real Mac the OS draws the buttons — main places them with
 * `trafficLightPosition` — and this is only the space they sit in, so nothing
 * of ours ends up under them. Everywhere else (a `PREMATION_UI_PLATFORM=mac`
 * preview on Windows or Linux, or the browser dev server) there are no real
 * ones, so look-alikes are drawn and wired to the same window verbs the Windows
 * caption buttons use. Their colours are the platform's, fixed in both themes
 * for the same reason as the Windows close-button red.
 */
export function MacWindowControls(): JSX.Element {
  const drawn = getWindowControls() === 'drawn';
  const win = window.electronAPI?.window;
  return (
    <div className={styles.macControls} data-drawn={drawn || undefined}>
      {drawn && (
        <>
          <button
            type="button"
            className={`${styles.light} ${styles.lightClose}`}
            aria-label="Close window"
            onClick={() => void win?.close?.()}
          >
            <svg viewBox="0 0 8 8" aria-hidden><path d="M2.2 2.2l3.6 3.6M5.8 2.2L2.2 5.8" /></svg>
          </button>
          <button
            type="button"
            className={`${styles.light} ${styles.lightMinimize}`}
            aria-label="Minimize window"
            onClick={() => void win?.minimize?.()}
          >
            <svg viewBox="0 0 8 8" aria-hidden><path d="M1.6 4h4.8" /></svg>
          </button>
          <button
            type="button"
            className={`${styles.light} ${styles.lightZoom}`}
            aria-label="Zoom window"
            onClick={() => void win?.maximize?.()}
          >
            <svg viewBox="0 0 8 8" aria-hidden><path d="M4 1.6v4.8M1.6 4h4.8" /></svg>
          </button>
        </>
      )}
    </div>
  );
}

export default MacWindowControls;
