/**
 * CompositionSummary — what the Properties panel shows with nothing selected.
 *
 * It used to be an empty-state tile promising "transform, style, layer
 * settings and animation" for a selection that did not exist: a whole panel
 * spent saying nothing. With no layer selected, the thing being edited is the
 * COMPOSITION, so the panel names it, states the numbers you would otherwise
 * open a dialog to read, and offers that dialog as its one button.
 *
 * The auto-minted pristine comp is not a composition to the user — the tab
 * strip reads "(none)" for it — so it gets the short hint instead of a card
 * describing a comp nobody made. Same test `EditorTabs` uses, so the two can
 * never disagree about whether there is a composition.
 */

import { Button } from '@components/Button';
import { EmptyState } from '@components/EmptyState';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { framesToTimecode } from '@core/time/timecode';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import styles from './CompositionSummary.module.css';

const HINT = 'Select a layer to edit its properties';

/** 30 → "30", 29.97 → "29.97": NTSC rates are real and must not round. */
function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : String(Number(fps.toFixed(3)));
}

export function CompositionSummary(): JSX.Element {
  const name = useCompositionStore((s) => s.name);
  const width = useCompositionStore((s) => s.width);
  const height = useCompositionStore((s) => s.height);
  const fps = useCompositionStore((s) => s.fps);
  const duration = useCompositionStore((s) => s.durationSeconds);
  const background = useCompositionStore((s) => s.background);
  const transparent = useCompositionStore((s) => s.transparent);
  const pristine = useProjectStore((s) => {
    const id = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
    if (!id || s.comps[id]?.pristine !== true) return false;
    const node = defaultSceneGraph.getNode(id);
    return !node || node.children.length === 0;
  });

  if (pristine) {
    return <EmptyState icon="mouse-pointer" title="No selection" message={`${HINT}.`} />;
  }

  return (
    <div className={styles.root} data-composition-summary>
      <div className={styles.head}>
        <span className={styles.eyebrow}>Composition</span>
        <span className={styles.name} title={name}>{name}</span>
      </div>
      <dl className={styles.facts}>
        <dt>Size</dt>
        <dd>{width} × {height}</dd>
        <dt>Frame rate</dt>
        <dd>{formatFps(fps)} fps</dd>
        <dt>Duration</dt>
        <dd>{framesToTimecode(duration, fps)}</dd>
        <dt>Background</dt>
        <dd className={styles.background}>
          {transparent ? (
            'Transparent'
          ) : (
            <>
              <span className={styles.swatch} style={{ background }} aria-hidden="true" />
              <span>{background}</span>
            </>
          )}
        </dd>
      </dl>
      <Button size="sm" variant="secondary" fullWidth onClick={() => openCompositionSettings()}>
        Composition settings…
      </Button>
      <p className={styles.hint}>{HINT}</p>
    </div>
  );
}

export default CompositionSummary;
