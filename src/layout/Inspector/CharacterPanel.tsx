import { useState, useMemo, useEffect } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { getRemappedTime } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getFontWeights, WEIGHT_LABELS } from '@core/text/fontCatalog';
import { useTextEditStore, hasRange, TEXT_EDIT_KEEP_ATTR } from '@stores/textEditStore';
import { readRuns, writeRuns, applyStyleToRange, styleOverRange, type RunStyleKey, type RichRun } from '@core/text/richText';
import type { TextStyle } from '@core/text/textLayout';
import { graphemeCount } from '@core/text/graphemes';
import { AUTO_LEADING, STROKE_ORDERS, strokeOrderOf, type StrokeOrder, type StrokeLineJoin } from '@core/text/textExtras';
import { readTextPathConfig, updateTextPath, setTextPath, defaultTextPath } from '@core/text/textPath';
import type { MaskPath } from '@core/effects/mask';
import { applyTextPreset, captureTextPreset } from '@core/inspector/sectionPresets';
import { FontPicker } from './FontPicker';
import { SectionPresetMenu } from './SectionPresetMenu';
import { installTextCommands, swapTextFillStroke } from './textCommands';
import { convertToParagraphText, convertToPointText, setBoxAutoSize } from './paragraphTextCommands';
import { MIN_BOX_SIZE, TATE_CHU_YOKO_DEFAULT_DIGITS, firstParagraphDirection, hasTextPath, readParagraphBox, type BoxAutoSize, type BoxVerticalAlign } from '@core/text/textExtras';
import { measureTextNodeParagraphBox } from '@core/text/measureText';
import { Segmented } from '@components/Segmented';
import { Checkbox } from '@components/Checkbox';
import { ColorPicker } from '@components/ColorPicker';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { TooltipProvider } from '@components/Tooltip';
import { TextFillRows, TextStrokeRows } from './TextFillRows';
import { VariableAxesSection, TextPathOptions, OpenTypeControls } from './TextOptionControls';
import styles from './CharacterPanel.module.css';

/* eslint-disable design-system/no-hex-color */
const DEFAULT_TEXT_FILL = '#ffffff';
const DEFAULT_TEXT_STROKE = '#000000';
/* eslint-enable design-system/no-hex-color */

const PRESETS = [
  { label: 'Display', fontSize: 96, fontWeight: '800', fontStyle: 'normal' },
  { label: 'Title (L)', fontSize: 72, fontWeight: '700', fontStyle: 'normal' },
  { label: 'Headline', fontSize: 56, fontWeight: '700', fontStyle: 'normal' },
  { label: 'Subtitle', fontSize: 48, fontWeight: '600', fontStyle: 'normal' },
  { label: 'Body', fontSize: 36, fontWeight: '400', fontStyle: 'normal' },
  { label: 'Lower 3rd', fontSize: 28, fontWeight: '600', fontStyle: 'normal' },
  { label: 'Caption', fontSize: 24, fontWeight: '400', fontStyle: 'normal' },
  { label: 'Label', fontSize: 20, fontWeight: '500', fontStyle: 'normal' },
  { label: 'Overline', fontSize: 14, fontWeight: '500', fontStyle: 'normal' },
  { label: 'Quote', fontSize: 32, fontWeight: '300', fontStyle: 'italic' },
  { label: 'Mono', fontSize: 36, fontWeight: '500', fontStyle: 'normal', fontFamily: 'Fira Code' },
  { label: 'Button', fontSize: 16, fontWeight: '600', fontStyle: 'normal' },
];

/**
 * A stored alignment seen from the other edge. The Paragraph panel's buttons
 * are VISUAL; a right-to-left paragraph stores alignment from its start edge
 * (textExtras.resolveAlignForDirection), so in RTL each button reads and
 * writes its mirror.
 */
function mirrorAlign(a: string): string {
  switch (a) {
    case 'left': return 'right';
    case 'right': return 'left';
    case 'justify':
    case 'justify-left': return 'justify-right';
    case 'justify-right': return 'justify-left';
    default: return a;
  }
}

const LINE_JOINS: ReadonlyArray<{ value: StrokeLineJoin; label: string }> = [
  { value: 'miter', label: 'Miter' },
  { value: 'round', label: 'Round' },
  { value: 'bevel', label: 'Bevel' },
];

export function CharacterPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? undefined;
  useSceneRevision((s) => s.rev);
  // Swap Fill and Stroke (Shift+X) is a registered command.
  useEffect(() => installTextCommands(), []);

  const time = useActiveWorkspace()?.time ?? 0;
  const layerT = primary ? getRemappedTime(primary, time) : 0;

  const node = primary ? defaultSceneGraph.getNode(primary) : null;
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Text'), [node]);

  // Bound layer hooks — Character properties
  const [content, setContent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'content');
  const [fontSize, setFontSize] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontSize');
  const [fontFamily, setFontFamily] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontFamily');
  const [fontWeight, setFontWeight] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontWeight');
  const [fontStyle, setFontStyle] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontStyle');
  const [fill, setFill] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fill');
  const [stroke, setStroke] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'stroke');
  const [strokeWidth, setStrokeWidth] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'strokeWidth');
  const [letterSpacing, setLetterSpacing] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'letterSpacing');
  const [lineHeight, setLineHeight] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'lineHeight');
  const [strokeOverFill] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'strokeOverFill');
  const [strokeOrder] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'strokeOrder');
  const [strokeLineJoin, setStrokeLineJoin] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'strokeLineJoin');
  const [noFill, setNoFill] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'noFill');
  const [noStroke, setNoStroke] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'noStroke');
  const [fauxBold, setFauxBold] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fauxBold');
  const [fauxItalic, setFauxItalic] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fauxItalic');
  const [kerningMode, setKerningMode] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'kerningMode');
  const [boxWidth, setBoxWidth] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'boxWidth');
  const [boxHeight, setBoxHeight] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'boxHeight');
  const [boxVerticalAlign, setBoxVerticalAlign] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'boxVerticalAlign');
  const [verticalScale, setVerticalScale] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'verticalScale');
  const [horizontalScale, setHorizontalScale] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'horizontalScale');
  const [baselineShift, setBaselineShift] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'baselineShift');
  const [textTransform, setTextTransform] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'textTransform');
  const [fontVariant, setFontVariant] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontVariant');
  const [verticalAlign, setVerticalAlign] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'verticalAlign');

  // Bound layer hooks — Paragraph properties
  const [align, setAlign] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'align');
  const [paragraphSpacing, setParagraphSpacing] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'paragraphSpacing');
  const [leftIndent, setLeftIndent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'leftIndent');
  const [rightIndent, setRightIndent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'rightIndent');
  const [firstLineIndent, setFirstLineIndent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'firstLineIndent');
  const [spaceBefore, setSpaceBefore] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'spaceBefore');
  const [spaceAfter, setSpaceAfter] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'spaceAfter');
  const [direction, setDirection] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'direction');
  const [orientation, setOrientation] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'orientation');
  const [verticalRomanAlignment, setVerticalRomanAlignment] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'verticalRomanAlignment');
  const [tateChuYokoAuto] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'tateChuYokoAuto');
  const [tateChuYokoDigits] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'tateChuYokoDigits');

  // Local fallback states when no text layer is active
  const [fallbackFamily, setFallbackFamily] = useState('Inter');
  const [fallbackWeight, setFallbackWeight] = useState('400');
  const [fallbackStyle, setFallbackStyle] = useState('normal');
  const [fallbackSize, setFallbackSize] = useState(72);
  /** undefined = Auto leading. */
  const [fallbackLeading, setFallbackLeading] = useState<number | undefined>(undefined);
  const [fallbackTracking, setFallbackTracking] = useState(0);
  const [fallbackFill, setFallbackFill] = useState(DEFAULT_TEXT_FILL);
  const [fallbackStroke, setFallbackStroke] = useState(DEFAULT_TEXT_STROKE);
  const [fallbackStrokeWidth, setFallbackStrokeWidth] = useState(0);
  const [fallbackStrokeOrder, setFallbackStrokeOrder] = useState<StrokeOrder>('fill-over-stroke');
  const [fallbackLineJoin, setFallbackLineJoin] = useState<StrokeLineJoin>('round');
  const [fallbackNoFill, setFallbackNoFill] = useState(false);
  const [fallbackNoStroke, setFallbackNoStroke] = useState(false);
  const [fallbackFauxBold, setFallbackFauxBold] = useState(false);
  const [fallbackFauxItalic, setFallbackFauxItalic] = useState(false);
  const [fallbackKerningMode, setFallbackKerningMode] = useState<'metrics' | 'optical'>('metrics');
  const [fallbackVertScale, setFallbackVertScale] = useState(100);
  const [fallbackHorizScale, setFallbackHorizScale] = useState(100);
  const [fallbackBaselineShift, setFallbackBaselineShift] = useState(0);
  const [fallbackTextTransform, setFallbackTextTransform] = useState('none');
  const [fallbackFontVariant, setFallbackFontVariant] = useState('normal');
  const [fallbackVerticalAlign, setFallbackVerticalAlign] = useState('baseline');
  const [fallbackAlign, setFallbackAlign] = useState('left');
  const [fallbackSpacing, setFallbackSpacing] = useState(0);
  const [fallbackFirstLineIndent, setFallbackFirstLineIndent] = useState(0);
  const [fallbackLeftIndent, setFallbackLeftIndent] = useState(0);
  const [fallbackRightIndent, setFallbackRightIndent] = useState(0);
  const [fallbackSpaceBefore, setFallbackSpaceBefore] = useState(0);
  const [fallbackSpaceAfter, setFallbackSpaceAfter] = useState(0);
  const [fallbackDirection, setFallbackDirection] = useState<'ltr' | 'rtl' | 'auto'>('ltr');
  const [fallbackOrientation, setFallbackOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
  const [fallbackRoman, setFallbackRoman] = useState(false);
  const [fallbackTcyAuto, setFallbackTcyAuto] = useState(false);
  const [fallbackTcyDigits, setFallbackTcyDigits] = useState(TATE_CHU_YOKO_DEFAULT_DIGITS);

  const hasTarget = Boolean(primary && tComp && node);

  // Range styling state
  const editingNodeId = useTextEditStore((s) => s.nodeId);
  const rawSelection = useTextEditStore((s) => s.selection);
  const selection = hasTarget && editingNodeId === primary ? rawSelection : null;
  const ranged = hasRange(selection);

  const contentStrRaw = String(content ?? '');
  // Grapheme clusters — the index space runs and the edit selection use.
  const textLen = graphemeCount(contentStrRaw);

  /** Run writes are one undo step each (writeRuns alone bypasses history). */
  const commitRuns = (label: string, runs: RichRun[]): void => {
    if (!primary) return;
    runDocumentEdit(label, () => writeRuns(primary, runs));
  };

  const setCharProp = <K extends RunStyleKey>(
    key: K,
    val: TextStyle[K],
    setLayerWide: (v: TextStyle[K]) => void,
  ): void => {
    if (!ranged || !node || !primary) {
      setLayerWide(val);
      return;
    }
    commitRuns(
      'Style Characters',
      applyStyleToRange(readRuns(node), selection.start, selection.end, { [key]: val }, textLen),
    );
  };

  const clearRunStyling = (): void => {
    if (!ranged || !node || !primary) return;
    commitRuns(
      'Reset Character Styling',
      applyStyleToRange(
        readRuns(node),
        selection.start,
        selection.end,
        {
          fontSize: undefined, fontFamily: undefined, fontWeight: undefined, fontStyle: undefined,
          letterSpacing: undefined, fill: undefined, kerning: undefined, fauxBold: undefined, fauxItalic: undefined,
          strokeColor: undefined, strokeWidth: undefined, lineHeight: undefined, horizontalScale: undefined,
          verticalScale: undefined, baselineShift: undefined, tsume: undefined, allCaps: undefined,
          smallCaps: undefined, verticalAlign: undefined, tateChuYoko: undefined,
        },
        textLen,
      ),
    );
  };

  const activeFamily = hasTarget ? String(fontFamily ?? 'Inter') : fallbackFamily;
  const activeWeight = hasTarget ? String(fontWeight ?? '400') : fallbackWeight;
  const activeStyle = hasTarget ? String(fontStyle ?? 'normal') : fallbackStyle;
  const activeSize = hasTarget ? Math.round(Number(fontSize ?? 72)) : fallbackSize;
  // AE leading: Auto (120% of size) or an explicit value. Auto is stored as
  // "no lineHeight", which every reader already renders at 1.2.
  const leadingIsAuto = hasTarget ? typeof lineHeight !== 'number' : fallbackLeading === undefined;
  const activeLeading = hasTarget
    ? (typeof lineHeight === 'number' ? lineHeight : AUTO_LEADING)
    : (fallbackLeading ?? AUTO_LEADING);
  const activeTracking = hasTarget ? Math.round(Number(letterSpacing ?? 0)) : fallbackTracking;
  const activeFill = hasTarget ? String(fill ?? DEFAULT_TEXT_FILL) : fallbackFill;
  const activeStroke = hasTarget ? String(stroke ?? DEFAULT_TEXT_STROKE) : fallbackStroke;
  const activeStrokeWidth = hasTarget ? Number(strokeWidth ?? 0) : fallbackStrokeWidth;
  const activeStrokeOrder: StrokeOrder = hasTarget
    ? strokeOrderOf(
        STROKE_ORDERS.some((o) => o.value === strokeOrder) ? (strokeOrder as StrokeOrder) : undefined,
        strokeOverFill === true,
      )
    : fallbackStrokeOrder;
  const activeLineJoin: StrokeLineJoin = hasTarget
    ? (LINE_JOINS.some((j) => j.value === strokeLineJoin) ? (strokeLineJoin as StrokeLineJoin) : 'round')
    : fallbackLineJoin;
  const activeNoFill = hasTarget ? noFill === true : fallbackNoFill;
  const activeNoStroke = hasTarget ? noStroke === true : fallbackNoStroke;
  const activeKerningMode = hasTarget ? (kerningMode === 'optical' ? 'optical' : 'metrics') : fallbackKerningMode;
  const activeVertScale = hasTarget ? Number(verticalScale ?? 100) : fallbackVertScale;
  const activeHorizScale = hasTarget ? Number(horizontalScale ?? 100) : fallbackHorizScale;
  const activeBaselineShift = hasTarget ? Number(baselineShift ?? 0) : fallbackBaselineShift;
  const activeTextTransform = hasTarget ? String(textTransform ?? 'none') : fallbackTextTransform;
  const activeFontVariant = hasTarget ? String(fontVariant ?? 'normal') : fallbackFontVariant;
  const activeVerticalAlign = hasTarget ? String(verticalAlign ?? 'baseline') : fallbackVerticalAlign;

  const currentDirection: 'ltr' | 'rtl' | 'auto' = hasTarget
    ? (direction === 'rtl' || direction === 'auto' ? direction : 'ltr')
    : fallbackDirection;
  /** The direction the alignment buttons mirror by: 'auto' reads the first paragraph. */
  const effectiveDirection = firstParagraphDirection(currentDirection, hasTarget ? contentStrRaw : '');
  const currentOrientation: 'horizontal' | 'vertical' = hasTarget
    ? (orientation === 'vertical' ? 'vertical' : 'horizontal')
    : fallbackOrientation;
  const currentRoman = hasTarget ? verticalRomanAlignment === true : fallbackRoman;
  const currentTcyAuto = hasTarget ? tateChuYokoAuto === true : fallbackTcyAuto;
  const currentTcyDigits = hasTarget
    ? (typeof tateChuYokoDigits === 'number' ? Math.max(1, Math.min(4, Math.round(tateChuYokoDigits))) : TATE_CHU_YOKO_DEFAULT_DIGITS)
    : fallbackTcyDigits;
  const storedAlign = hasTarget ? String(align ?? 'left') : fallbackAlign;
  /** The alignment as the buttons show it (mirrored in a right-to-left paragraph). */
  const currentAlign = effectiveDirection === 'rtl' ? mirrorAlign(storedAlign) : storedAlign;
  const currentSpacing = hasTarget ? Number(paragraphSpacing ?? 0) : fallbackSpacing;
  const currentLeftIndent = hasTarget ? Number(leftIndent ?? 0) : fallbackLeftIndent;
  const currentRightIndent = hasTarget ? Number(rightIndent ?? 0) : fallbackRightIndent;
  const currentFirstLineIndent = hasTarget ? Number(firstLineIndent ?? 0) : fallbackFirstLineIndent;
  const currentSpaceBefore = hasTarget ? Number(spaceBefore ?? 0) : fallbackSpaceBefore;
  const currentSpaceAfter = hasTarget ? Number(spaceAfter ?? 0) : fallbackSpaceAfter;

  const availableWeights = getFontWeights(activeFamily);

  // Manual kerning (AE): a value applies BETWEEN the two characters at the
  // caret — stored on the character before it. With a range selected it
  // applies after every selected character.
  const kernRange = ((): { lo: number; hi: number } | null => {
    if (!selection || !node) return null;
    if (selection.end > selection.start) return { lo: selection.start, hi: selection.end };
    return selection.start > 0 ? { lo: selection.start - 1, hi: selection.start } : null;
  })();
  const kernInfo = kernRange && node ? styleOverRange(readRuns(node), kernRange.lo, kernRange.hi, textLen) : null;
  const manualKerning = kernInfo?.style.kerning ?? 0;
  const kerningMixed = kernInfo?.mixed.has('kerning') ?? false;

  // Source text keyframe support
  const sourceAnimated = Boolean(primary && defaultAnimation.isDataAnimated(primary, 'text.source'));
  const sampledSource = sourceAnimated && primary
    ? defaultAnimation.sampleData(primary, 'text.source', layerT)
    : undefined;
  const contentStr = typeof sampledSource === 'string' ? sampledSource : contentStrRaw;

  const onContentEdit = (next: string): void => {
    if (!hasTarget) return;
    if (sourceAnimated && primary) {
      runAnimEdit('Edit Source Text keyframe', () => {
        defaultAnimation.setDataKeyframe(primary, 'text.source', 'text', layerT, next);
      }, `srcText:${primary}`);
    } else {
      setContent(next);
    }
  };

  const toggleSourceStopwatch = (): void => {
    if (!primary) return;
    if (sourceAnimated) {
      runAnimEdit('Remove Source Text keyframes', () => {
        defaultAnimation.setDataTrack(primary, 'text.source', null);
      });
    } else {
      runAnimEdit('Animate Source Text', () => {
        defaultAnimation.setDataKeyframe(primary, 'text.source', 'text', layerT, contentStr);
      });
    }
  };

  // Mask path riding
  const fxProps = node?.components.find((c) => c.type === 'fx')?.props as
    | { mask?: { paths?: MaskPath[] } }
    | undefined;
  const maskPaths: MaskPath[] = fxProps?.mask?.paths ?? [];
  const textPathCfg = node ? readTextPathConfig(node) : null;
  const activePathId = textPathCfg
    ? textPathCfg.pathId || (maskPaths[0]?.id ?? '')
    : '';

  const handleFamilyChange = (fam: string) => {
    setCharProp('fontFamily', fam, (v) => {
      if (hasTarget) setFontFamily(v as string);
      else setFallbackFamily(v as string);
    });
  };

  const handleWeightChange = (w: string) => {
    setCharProp('fontWeight', w, (v) => {
      if (hasTarget) setFontWeight(v as string);
      else setFallbackWeight(v as string);
    });
  };

  const handleStyleChange = (st: string) => {
    setCharProp('fontStyle', st, (v) => {
      if (hasTarget) setFontStyle(v as string);
      else setFallbackStyle(v as string);
    });
  };

  const handleSizeChange = (s: number) => {
    setCharProp('fontSize', s, (v) => {
      if (hasTarget) setFontSize(v as number);
      else setFallbackSize(v as number);
    });
  };

  /** `undefined` = Auto. With a range selected, the leading is the range's own
   *  (AE uses the largest leading on each line). */
  const handleLeadingChange = (l: number | undefined) => {
    if (ranged && node && primary) {
      commitRuns('Leading', applyStyleToRange(readRuns(node), selection.start, selection.end, { lineHeight: l }, textLen));
      return;
    }
    if (hasTarget) setLineHeight(l);
    else setFallbackLeading(l);
  };

  const handleTrackingChange = (tr: number) => {
    setCharProp('letterSpacing', tr, (v) => {
      if (hasTarget) setLetterSpacing(v as number);
      else setFallbackTracking(v as number);
    });
  };

  const handleFillChange = (c: string) => {
    setCharProp('fill', c, (v) => {
      if (hasTarget) setFill(v as string);
      else setFallbackFill(v as string);
    });
  };

  const handleStrokeChange = (c: string) => {
    setCharProp('strokeColor', c, (v) => {
      if (hasTarget) setStroke(v as string);
      else setFallbackStroke(v as string);
    });
  };

  const handleStrokeWidthChange = (w: number) => {
    setCharProp('strokeWidth', w, (v) => {
      if (hasTarget) setStrokeWidth(v as number);
      else setFallbackStrokeWidth(v as number);
    });
  };

  /** A per-range numeric style, or the layer-wide prop without a range. */
  const handleRangeNumber = (
    key: 'verticalScale' | 'horizontalScale' | 'baselineShift' | 'tsume',
    val: number,
    setLayerWide: (v: number) => void,
  ) => setCharProp(key, val, (v) => setLayerWide(v as number));

  const handleSwapFillStroke = () => {
    if (hasTarget && primary) {
      swapTextFillStroke([primary]);
      return;
    }
    setFallbackFill(activeStroke || DEFAULT_TEXT_STROKE);
    setFallbackStroke(activeFill);
    setFallbackNoFill(activeNoStroke);
    setFallbackNoStroke(activeNoFill);
    if (activeStrokeWidth === 0) setFallbackStrokeWidth(2);
  };

  const handleStrokeOrderChange = (order: StrokeOrder) => {
    if (!hasTarget || !primary || !tComp) {
      setFallbackStrokeOrder(order);
      return;
    }
    // The legacy boolean is kept in step so older readers (the extrusion trace
    // key, Create Shapes From Text) agree about which paint is on top.
    runDocumentEdit('Fill and Stroke Order', () => {
      defaultSceneGraph.writeProp(primary, tComp.id, 'strokeOrder', order);
      defaultSceneGraph.writeProp(
        primary,
        tComp.id,
        'strokeOverFill',
        order === 'stroke-over-fill' || order === 'all-strokes-over-all-fills',
      );
    });
  };

  const handleKerningChange = (v: number) => {
    if (!kernRange || !node || !primary) return;
    const value = Math.round(v);
    commitRuns(
      'Kerning',
      applyStyleToRange(readRuns(node), kernRange.lo, kernRange.hi, { kerning: value === 0 ? undefined : value }, textLen),
    );
  };

  const handleAlignChange = (visual: string) => {
    const a = effectiveDirection === 'rtl' ? mirrorAlign(visual) : visual;
    if (hasTarget) setAlign(a);
    else setFallbackAlign(a);
  };

  const handleDirectionChange = (d: 'ltr' | 'rtl' | 'auto') => {
    if (hasTarget) setDirection(d);
    else setFallbackDirection(d);
  };

  const handleOrientationChange = (o: 'horizontal' | 'vertical') => {
    if (hasTarget) setOrientation(o);
    else setFallbackOrientation(o);
  };

  const handleRomanChange = (on: boolean) => {
    if (hasTarget) setVerticalRomanAlignment(on);
    else setFallbackRoman(on);
  };

  /** Auto tate-chu-yoko (layer-wide): digit runs up to N set horizontally. */
  const writeTcyProp = (label: string, prop: 'tateChuYokoAuto' | 'tateChuYokoDigits', value: boolean | number): void => {
    if (!hasTarget || !primary || !tComp) return;
    runDocumentEdit(label, () => defaultSceneGraph.writeProp(primary, tComp.id, prop, value));
  };
  const handleTcyAutoChange = (on: boolean) => {
    if (hasTarget) writeTcyProp('Auto Tate-Chu-Yoko', 'tateChuYokoAuto', on);
    else setFallbackTcyAuto(on);
  };
  const handleTcyDigitsChange = (digits: string) => {
    const d = Math.max(1, Math.min(4, Number(digits) || TATE_CHU_YOKO_DEFAULT_DIGITS));
    if (hasTarget) writeTcyProp('Tate-Chu-Yoko Digits', 'tateChuYokoDigits', d);
    else setFallbackTcyDigits(d);
  };

  const handleSpacingChange = (sp: number) => {
    if (hasTarget) setParagraphSpacing(sp);
    else setFallbackSpacing(sp);
  };

  const handleLeftIndentChange = (v: number) => {
    if (hasTarget) setLeftIndent(v);
    else setFallbackLeftIndent(v);
  };

  const handleRightIndentChange = (v: number) => {
    if (hasTarget) setRightIndent(v);
    else setFallbackRightIndent(v);
  };

  const handleFirstLineIndentChange = (v: number) => {
    if (hasTarget) setFirstLineIndent(v);
    else setFallbackFirstLineIndent(v);
  };

  const handleSpaceBeforeChange = (v: number) => {
    if (hasTarget) setSpaceBefore(v);
    else setFallbackSpaceBefore(v);
  };

  const handleSpaceAfterChange = (v: number) => {
    if (hasTarget) setSpaceAfter(v);
    else setFallbackSpaceAfter(v);
  };

  const applyPreset = (preset: typeof PRESETS[number]) => {
    if (ranged && node && primary) {
      commitRuns(
        'Apply Text Preset',
        applyStyleToRange(
          readRuns(node),
          selection.start,
          selection.end,
          {
            fontSize: preset.fontSize,
            fontWeight: preset.fontWeight,
            fontStyle: preset.fontStyle,
            ...(preset.fontFamily ? { fontFamily: preset.fontFamily } : {}),
          },
          textLen,
        ),
      );
      return;
    }
    handleSizeChange(preset.fontSize);
    handleWeightChange(preset.fontWeight);
    handleStyleChange(preset.fontStyle);
    if (preset.fontFamily) handleFamilyChange(preset.fontFamily);
  };

  // Faux Bold / Faux Italic are SYNTHETIC styles, independent of the font's
  // weight and italic: the weight menu and the font's italic stay as they are.
  const rangeStyle = ranged && node ? styleOverRange(readRuns(node), selection.start, selection.end, textLen).style : null;
  const isFauxBold = rangeStyle?.fauxBold ?? (hasTarget ? fauxBold === true : fallbackFauxBold);
  const isFauxItalic = rangeStyle?.fauxItalic ?? (hasTarget ? fauxItalic === true : fallbackFauxItalic);
  // With a range selected these read (and write) the RANGE's own styles.
  const isAllCaps = ranged ? rangeStyle?.allCaps === true : activeTextTransform === 'uppercase';
  const isSmallCaps = ranged ? rangeStyle?.smallCaps === true : activeFontVariant === 'small-caps';
  const isSuperscript = ranged ? rangeStyle?.verticalAlign === 'super' : activeVerticalAlign === 'super';
  const isSubscript = ranged ? rangeStyle?.verticalAlign === 'sub' : activeVerticalAlign === 'sub';
  // Tate-chu-yoko is a per-range style only (AE applies it to selected text).
  const isTateChuYoko = ranged && rangeStyle?.tateChuYoko === true;
  const shownStroke = rangeStyle?.strokeColor ?? activeStroke;
  const shownStrokeWidth = rangeStyle?.strokeWidth ?? activeStrokeWidth;
  const shownLeading = rangeStyle?.lineHeight;
  const shownVertScale = rangeStyle?.verticalScale ?? activeVertScale;
  const shownHorizScale = rangeStyle?.horizontalScale ?? activeHorizScale;
  const shownBaselineShift = rangeStyle?.baselineShift ?? activeBaselineShift;
  const shownTsume = rangeStyle?.tsume ?? 0;
  /** Caps / super-sub toggles: a run style with a range, the layer prop without. */
  const toggleRangeFlag = (
    key: 'allCaps' | 'smallCaps',
    on: boolean,
    layerWide: () => void,
  ): void => (ranged ? setCharProp(key, on ? true : undefined, () => {}) : layerWide());
  const setRangeVerticalAlign = (next: 'super' | 'sub' | undefined, layerWide: () => void): void =>
    ranged ? setCharProp('verticalAlign', next, () => {}) : layerWide();

  return (
    <TooltipProvider>
      {/* Focus moving into the panel keeps on-canvas text editing (and its
          character selection) alive — see TextEditOverlay. */}
      <div className={styles.root} {...{ [TEXT_EDIT_KEEP_ATTR]: '' }}>
      {/* Target Status Banner */}
      <div className={styles.panelHead}>
        <div className={styles.panelHeadLeft}>
          <span className={styles.panelHeadTitle}>Text</span>
          <span className={`${styles.targetBadge}${hasTarget ? ` ${styles.targetBadgeActive}` : ''}`}>
            {hasTarget ? node?.name || 'Selected Text' : 'Default Preset'}
          </span>
        </div>
        {hasTarget && (
          <SectionPresetMenu
            sectionId="text"
            label="Text style presets"
            capture={() => (primary ? captureTextPreset(primary) : {})}
            apply={(values) => applyTextPreset(selected.length > 0 ? selected : [], values)}
          />
        )}
      </div>

      {/* Ranged Selection Banner */}
      {ranged && (
        <div className={styles.rangeNotice}>
          <span>{`Styling ${selection.end - selection.start} character${selection.end - selection.start === 1 ? '' : 's'}`}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={clearRunStyling}
            title="Reset per-character styling for selected range"
          >
            Reset
          </Button>
        </div>
      )}

      {/* Text Content & Source Text Keyframing */}
      {hasTarget && (
        <div className={styles.sectionCard}>
          <div className={styles.contentHead}>
            <span className={styles.sectionHeader}>Content</span>
            <Button
              size="xs"
              variant={sourceAnimated ? 'primary' : 'ghost'}
              icon={<Icon name="keyframe" size="sm" />}
              title={sourceAnimated ? 'Remove Source Text keyframes' : 'Keyframe Source Text across timeline'}
              onClick={toggleSourceStopwatch}
            >
              {sourceAnimated ? 'Animated' : 'Keyframe'}
            </Button>
          </div>
          <textarea
            className={styles.contentTextarea}
            value={contentStr}
            onChange={(e) => onContentEdit(e.target.value)}
            placeholder="Type text content here..."
            rows={2}
          />
        </div>
      )}

      {/* Typography & Character Formatting */}
      <div className={styles.sectionCard}>
        <div className={styles.sectionHeader}>Typography</div>

        {/* Font Family & Weight */}
        <div className={styles.fontRow}>
          <FontPicker
            value={activeFamily}
            onChange={handleFamilyChange}
            // A picked installed FACE carries its real weight and italic.
            onStyleChange={(f) => { handleWeightChange(f.weight); handleStyleChange(f.fontStyle); }}
          />
          <select
            value={activeWeight}
            onChange={(e) => handleWeightChange(e.target.value)}
            className={styles.fontSelect}
            aria-label="Font Weight"
          >
            {availableWeights.map((w) => (
              <option key={w} value={String(w)}>{WEIGHT_LABELS[w] ?? String(w)}</option>
            ))}
          </select>
        </div>

        {/* Font Size & Leading */}
        <div className={styles.metricGrid}>
          {/* Font Size */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Font Size (TT)">Size</span>
            <input
              type="number"
              aria-label="Font Size"
              className={styles.metricInput}
              value={activeSize}
              onChange={(e) => handleSizeChange(Math.max(1, Number(e.target.value)))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* Leading (Line Height) — Auto or explicit */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Leading / Line Height (A/A). Clear the field or press Auto for 120% of the font size.">Leading</span>
            <input
              type="number"
              aria-label="Leading (Line Height)"
              step="0.1"
              className={styles.metricInput}
              value={shownLeading !== undefined ? shownLeading : leadingIsAuto ? '' : activeLeading}
              placeholder="Auto"
              onChange={(e) => {
                if (e.target.value === '') handleLeadingChange(undefined);
                else handleLeadingChange(Math.max(0.5, Number(e.target.value)));
              }}
            />
            <button
              type="button"
              className={styles.metricToggle}
              data-active={leadingIsAuto}
              aria-pressed={leadingIsAuto}
              aria-label="Auto Leading"
              title="Auto leading (120% of the font size)"
              onClick={() => handleLeadingChange(leadingIsAuto ? AUTO_LEADING : undefined)}
            >
              Auto
            </button>
          </div>
        </div>

        {/* Tactile Character Style Button Group */}
        <div className={styles.controlGroup} role="toolbar" aria-label="Character Formatting Styles">
          <IconButton
            size="sm"
            variant="ghost"
            active={isFauxBold}
            aria-label="Faux Bold"
            tooltip="Faux Bold"
            className={styles.groupItem}
            onClick={() =>
              setCharProp('fauxBold', !isFauxBold, (v) => {
                if (hasTarget) setFauxBold(v === true);
                else setFallbackFauxBold(v === true);
              })
            }
          >
            <b>B</b>
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isFauxItalic}
            aria-label="Faux Italic"
            tooltip="Faux Italic"
            className={styles.groupItem}
            onClick={() =>
              setCharProp('fauxItalic', !isFauxItalic, (v) => {
                if (hasTarget) setFauxItalic(v === true);
                else setFallbackFauxItalic(v === true);
              })
            }
          >
            <i>I</i>
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isAllCaps}
            aria-label="All Caps"
            tooltip="All Caps"
            className={styles.groupItem}
            onClick={() => toggleRangeFlag('allCaps', !isAllCaps, () => {
              const next = isAllCaps ? 'none' : 'uppercase';
              if (hasTarget) setTextTransform(next);
              else setFallbackTextTransform(next);
            })}
          >
            TT
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isSmallCaps}
            aria-label="Small Caps"
            tooltip="Small Caps"
            className={styles.groupItem}
            onClick={() => toggleRangeFlag('smallCaps', !isSmallCaps, () => {
              const next = isSmallCaps ? 'normal' : 'small-caps';
              if (hasTarget) setFontVariant(next);
              else setFallbackFontVariant(next);
            })}
          >
            Tt
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isSuperscript}
            aria-label="Superscript"
            tooltip="Superscript"
            className={styles.groupItem}
            onClick={() => setRangeVerticalAlign(isSuperscript ? undefined : 'super', () => {
              const next = isSuperscript ? 'baseline' : 'super';
              if (hasTarget) setVerticalAlign(next);
              else setFallbackVerticalAlign(next);
            })}
          >
            T¹
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isSubscript}
            aria-label="Subscript"
            tooltip="Subscript"
            className={styles.groupItem}
            onClick={() => setRangeVerticalAlign(isSubscript ? undefined : 'sub', () => {
              const next = isSubscript ? 'baseline' : 'sub';
              if (hasTarget) setVerticalAlign(next);
              else setFallbackVerticalAlign(next);
            })}
          >
            T₁
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isTateChuYoko}
            disabled={!ranged}
            aria-label="Tate-Chu-Yoko"
            tooltip={ranged ? 'Tate-Chu-Yoko' : 'Tate-Chu-Yoko (select characters in vertical type)'}
            className={styles.groupItem}
            onClick={() => setCharProp('tateChuYoko', isTateChuYoko ? undefined : true, () => {})}
          >
            TCY
          </IconButton>
        </div>

        {/* OpenType: ligatures, contextual alternates, stylistic sets */}
        {hasTarget && primary && <OpenTypeControls nodeId={primary} />}
      </div>

      {/* Paragraph Alignment & Spacing Deck */}
      <div className={styles.sectionCard}>
        <div className={styles.sectionHeader}>Paragraph &amp; Alignment</div>

        {/* 7 Alignment buttons in professional segmented deck */}
        <div className={styles.controlGroup} role="radiogroup" aria-label="Paragraph Alignment">
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'left'}
            aria-label="Left Align"
            tooltip="Left Align"
            className={styles.groupItem}
            onClick={() => handleAlignChange('left')}
          >
            <Icon name="text-left" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'center'}
            aria-label="Center Align"
            tooltip="Center Align"
            className={styles.groupItem}
            onClick={() => handleAlignChange('center')}
          >
            <Icon name="text-center" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'right'}
            aria-label="Right Align"
            tooltip="Right Align"
            className={styles.groupItem}
            onClick={() => handleAlignChange('right')}
          >
            <Icon name="text-right" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify' || currentAlign === 'justify-left'}
            aria-label="Justify Last Left"
            tooltip="Justify Last Left"
            className={styles.groupItem}
            onClick={() => handleAlignChange('justify-left')}
          >
            <Icon name="align-left" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify-center'}
            aria-label="Justify Last Center"
            tooltip="Justify Last Center"
            className={styles.groupItem}
            onClick={() => handleAlignChange('justify-center')}
          >
            <Icon name="align-center" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify-right'}
            aria-label="Justify Last Right"
            tooltip="Justify Last Right"
            className={styles.groupItem}
            onClick={() => handleAlignChange('justify-right')}
          >
            <Icon name="align-right" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify-all'}
            aria-label="Justify All Lines"
            tooltip="Justify All Lines"
            className={styles.groupItem}
            onClick={() => handleAlignChange('justify-all')}
          >
            <Icon name="distribute-horizontal" size="sm" />
          </IconButton>
        </div>

        {/* AE: Right-to-left text direction, and horizontal / vertical type */}
        <div className={styles.controlRow}>
          <Segmented
            size="sm"
            fullWidth
            aria-label="Text Direction"
            value={currentDirection}
            onChange={handleDirectionChange}
            options={[
              { value: 'ltr', label: 'Left to Right' },
              { value: 'rtl', label: 'Right to Left' },
              // Each paragraph follows its first strong character (UAX #9 P2/P3).
              { value: 'auto', label: 'Auto' },
            ]}
          />
        </div>
        <div className={styles.controlRow}>
          <Segmented
            size="sm"
            fullWidth
            aria-label="Text Orientation"
            value={currentOrientation}
            onChange={handleOrientationChange}
            options={[
              { value: 'horizontal', label: 'Horizontal' },
              { value: 'vertical', label: 'Vertical' },
            ]}
          />
        </div>
        {currentOrientation === 'vertical' && (
          <div className={styles.controlRow}>
            <Checkbox
              label="Standard Vertical Roman Alignment"
              checked={currentRoman}
              onChange={(e) => handleRomanChange(e.target.checked)}
            />
          </div>
        )}
        {currentOrientation === 'vertical' && (
          <div className={styles.controlRow}>
            <Checkbox
              label="Auto Tate-Chu-Yoko"
              checked={currentTcyAuto}
              onChange={(e) => handleTcyAutoChange(e.target.checked)}
            />
            {currentTcyAuto && (
              <Segmented
                size="sm"
                aria-label="Tate-Chu-Yoko Digits"
                value={String(currentTcyDigits)}
                onChange={handleTcyDigitsChange}
                options={[
                  { value: '1', label: '1' },
                  { value: '2', label: '2' },
                  { value: '3', label: '3' },
                  { value: '4', label: '4' },
                ]}
              />
            )}
          </div>
        )}

        {/* Paragraph Spacing & Indents Grid */}
        <div className={styles.metricGrid}>
          {/* Paragraph Spacing (legacy: between every line) */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Extra space between every line (Paragraph Spacing)">¶ Space</span>
            <input
              type="number"
              aria-label="Paragraph Spacing"
              className={styles.metricInput}
              value={currentSpacing}
              onChange={(e) => handleSpacingChange(Number(e.target.value))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* First Line Indent */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="First Line Indent (paragraph text; negative = hanging)">1st Line</span>
            <input
              type="number"
              aria-label="First Line Indent"
              className={styles.metricInput}
              value={currentFirstLineIndent}
              onChange={(e) => handleFirstLineIndentChange(Number(e.target.value))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* Left Indent */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Indent left margin (paragraph text)">⇤ Left</span>
            <input
              type="number"
              aria-label="Left Indent"
              className={styles.metricInput}
              value={currentLeftIndent}
              onChange={(e) => handleLeftIndentChange(Number(e.target.value))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* Right Indent */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Indent right margin (paragraph text)">Right ⇥</span>
            <input
              type="number"
              aria-label="Right Indent"
              className={styles.metricInput}
              value={currentRightIndent}
              onChange={(e) => handleRightIndentChange(Number(e.target.value))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* Space Before */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Space before paragraph">↑ Before</span>
            <input
              type="number"
              aria-label="Space Before"
              className={styles.metricInput}
              value={currentSpaceBefore}
              onChange={(e) => handleSpaceBeforeChange(Number(e.target.value))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* Space After */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Space after paragraph">↓ After</span>
            <input
              type="number"
              aria-label="Space After"
              className={styles.metricInput}
              value={currentSpaceAfter}
              onChange={(e) => handleSpaceAfterChange(Number(e.target.value))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>
        </div>
      </div>

      {/* Appearance (Fill & Stroke) */}
      <div className={styles.sectionCard}>
        <div className={styles.sectionHeader}>Appearance</div>
        <div className={styles.appearanceRow}>
          <div className={styles.swatchPair}>
            <div className={styles.fillSwatchWrap} title="Character Fill Color">
              <ColorPicker
                value={activeFill}
                onChange={handleFillChange}
                compact
                aria-label="Character Fill Color"
                className={styles.fillSwatchPicker}
              />
            </div>
            <div className={styles.strokeSwatchWrap} title="Character Stroke Color">
              <ColorPicker
                value={shownStroke}
                onChange={handleStrokeChange}
                compact
                aria-label="Character Stroke Color"
                className={styles.strokeSwatchPicker}
              />
            </div>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label="Swap Fill and Stroke (Shift+X)"
              tooltip="Swap Fill and Stroke (Shift+X)"
              className={styles.swapToggle}
              onClick={handleSwapFillStroke}
            >
              ⇄
            </IconButton>
          </div>
          <div className={styles.appearanceDetails}>
            <span className={styles.appearanceMeta}>{activeFamily}</span>
            <span className={styles.appearanceSub}>
              {WEIGHT_LABELS[Number(activeWeight)] ?? 'Regular'} · {activeStyle === 'italic' ? 'Italic' : 'Normal'}
              {isFauxBold ? ' · Faux Bold' : ''}{isFauxItalic ? ' · Faux Italic' : ''}
            </span>
          </div>
        </div>

        {/* Solid / Linear / Radial — a gradient spans the whole text block */}
        {hasTarget && primary && <TextFillRows nodeId={primary} textColor={activeFill} />}

        {/* AE's "none" swatches */}
        <div className={styles.controlGroup} role="group" aria-label="Fill and Stroke None">
          <IconButton
            size="sm"
            variant="ghost"
            active={activeNoFill}
            aria-label="No Fill"
            tooltip="No Fill"
            className={styles.groupItem}
            onClick={() => {
              if (hasTarget) setNoFill(!activeNoFill);
              else setFallbackNoFill(!activeNoFill);
            }}
          >
            ⊘ Fill
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={activeNoStroke}
            aria-label="No Stroke"
            tooltip="No Stroke"
            className={styles.groupItem}
            onClick={() => {
              if (hasTarget) setNoStroke(!activeNoStroke);
              else setFallbackNoStroke(!activeNoStroke);
            }}
          >
            ⊘ Stroke
          </IconButton>
        </div>

        {/* Stroke Width, Line Join, Fill & Stroke order */}
        <div className={styles.metricGrid}>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Stroke Width">Stroke</span>
            <input
              type="number"
              aria-label="Stroke Width"
              min="0"
              className={styles.metricInput}
              value={shownStrokeWidth}
              onChange={(e) => handleStrokeWidthChange(Math.max(0, Number(e.target.value)))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Line Join">Join</span>
            <select
              aria-label="Stroke Line Join"
              className={styles.metricSelect}
              value={activeLineJoin}
              onChange={(e) => {
                const v = e.target.value as StrokeLineJoin;
                if (hasTarget) setStrokeLineJoin(v);
                else setFallbackLineJoin(v);
              }}
            >
              {LINE_JOINS.map((j) => (
                <option key={j.value} value={j.value}>{j.label}</option>
              ))}
            </select>
          </div>
          <div className={`${styles.metricCell} ${styles.metricCellWide}`}>
            <span className={styles.metricLabel} title="Fill and stroke paint order">Order</span>
            <select
              aria-label="Fill and Stroke Order"
              className={styles.metricSelect}
              value={activeStrokeOrder}
              onChange={(e) => handleStrokeOrderChange(e.target.value as StrokeOrder)}
            >
              {STROKE_ORDERS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Stroke Solid / Linear / Radial — a gradient spans the whole block */}
        {hasTarget && primary && <TextStrokeRows nodeId={primary} strokeColor={shownStroke} />}
      </div>

      {/* Advanced Metrics Grid (Tracking, Kerning, Scales, Baseline) */}
      <div className={styles.sectionCard}>
        <div className={styles.sectionHeader}>Metrics &amp; Scale</div>
        <div className={styles.metricGrid}>
          {/* Tracking (Letter Spacing) */}
          <div className={`${styles.metricCell} ${styles.metricCellWide}`}>
            <span className={styles.metricLabel} title="Tracking (Letter Spacing) (VA)">Tracking</span>
            <input
              type="number"
              aria-label="Tracking (Letter Spacing)"
              className={styles.metricInput}
              value={activeTracking}
              onChange={(e) => handleTrackingChange(Number(e.target.value))}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* Kerning — mode for the layer, manual value at the text caret */}
          <div className={`${styles.metricCell} ${styles.metricCellWide}`}>
            <span
              className={styles.metricLabel}
              title="Kerning (V/A). Metrics uses the font's kerning pairs; Optical spaces each pair from the glyph shapes, ignoring the font's pairs. While editing text, the value applies between the two characters at the caret, in 1/1000 em, on top of either."
            >
              Kerning
            </span>
            <select
              aria-label="Kerning Mode"
              className={styles.metricSelect}
              value={activeKerningMode}
              onChange={(e) => {
                const v = e.target.value === 'optical' ? 'optical' : 'metrics';
                if (hasTarget) setKerningMode(v);
                else setFallbackKerningMode(v);
              }}
            >
              <option value="metrics">Metrics</option>
              <option value="optical">Optical</option>
            </select>
            <div className={styles.metricValue}>
              <ValueField
                aria-label="Manual Kerning"
                value={manualKerning}
                mixed={kerningMixed}
                step={5}
                precision={0}
                disabled={!kernRange}
                onChange={handleKerningChange}
              />
            </div>
          </div>

          {/* Vertical Scale */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Vertical Scale (IT)">↕ Scale</span>
            <input
              type="number"
              aria-label="Vertical Scale"
              className={styles.metricInput}
              value={shownVertScale}
              onChange={(e) => handleRangeNumber('verticalScale', Number(e.target.value), (val) => {
                if (hasTarget) setVerticalScale(val);
                else setFallbackVertScale(val);
              })}
            />
            <span className={styles.metricUnit}>%</span>
          </div>

          {/* Horizontal Scale */}
          <div className={styles.metricCell}>
            <span className={styles.metricLabel} title="Horizontal Scale (T-)">↔ Scale</span>
            <input
              type="number"
              aria-label="Horizontal Scale"
              className={styles.metricInput}
              value={shownHorizScale}
              onChange={(e) => handleRangeNumber('horizontalScale', Number(e.target.value), (val) => {
                if (hasTarget) setHorizontalScale(val);
                else setFallbackHorizScale(val);
              })}
            />
            <span className={styles.metricUnit}>%</span>
          </div>

          {/* Baseline Shift */}
          <div className={`${styles.metricCell} ${styles.metricCellWide}`}>
            <span className={styles.metricLabel} title="Baseline Shift (A_)">Baseline</span>
            <input
              type="number"
              aria-label="Baseline Shift"
              className={styles.metricInput}
              value={shownBaselineShift}
              onChange={(e) => handleRangeNumber('baselineShift', Number(e.target.value), (val) => {
                if (hasTarget) setBaselineShift(val);
                else setFallbackBaselineShift(val);
              })}
            />
            <span className={styles.metricUnit}>px</span>
          </div>

          {/* Tsume — per range only (a selection's side bearings), as in AE */}
          <div className={`${styles.metricCell} ${styles.metricCellWide}`}>
            <span className={styles.metricLabel} title="Tsume: tighten the space around the selected characters (select characters in the text to apply)">Tsume</span>
            <input
              type="number"
              aria-label="Tsume"
              min="0"
              max="100"
              disabled={!ranged}
              className={styles.metricInput}
              value={shownTsume}
              onChange={(e) => handleRangeNumber('tsume', Math.max(0, Math.min(100, Number(e.target.value))), () => {})}
            />
            <span className={styles.metricUnit}>%</span>
          </div>
        </div>
      </div>

      {/* Variable-font axes (AE 26.0) — only for fonts that have them */}
      {hasTarget && primary && <VariableAxesSection nodeId={primary} />}

      {/* Text Box — AE point vs paragraph text, box size, auto-size, vertical alignment */}
      {hasTarget && primary && node && (() => {
        const paraBox = readParagraphBox(node);
        // Text on a path is point text (AE): no box to convert into or edit.
        const onPath = hasTextPath(node);
        const measuredBox = paraBox ? measureTextNodeParagraphBox(node) : null;
        const autoSize: BoxAutoSize = paraBox?.autoSize ?? 'height';
        const fixed = paraBox?.fixedHeight === true;
        const vAlign: BoxVerticalAlign =
          boxVerticalAlign === 'center' || boxVerticalAlign === 'bottom' ? boxVerticalAlign : 'top';
        const V_ALIGNS: ReadonlyArray<{ value: BoxVerticalAlign; label: string; icon: 'align-top' | 'align-middle' | 'align-bottom' }> = [
          { value: 'top', label: 'Align Top in Box', icon: 'align-top' },
          { value: 'center', label: 'Align Center in Box', icon: 'align-middle' },
          { value: 'bottom', label: 'Align Bottom in Box', icon: 'align-bottom' },
        ];
        return (
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>Text Box</div>
            <div className={styles.controlRow}>
              <Segmented
                size="sm"
                fullWidth
                aria-label="Point or Paragraph Text"
                value={paraBox ? 'paragraph' : 'point'}
                disabled={onPath}
                onChange={(v) => {
                  if (v === 'paragraph') convertToParagraphText([primary]);
                  else convertToPointText([primary]);
                }}
                options={[
                  { value: 'point', label: 'Point' },
                  { value: 'paragraph', label: 'Paragraph' },
                ]}
              />
            </div>
            {onPath ? (
              <div className={styles.controlRow}>
                <span className={styles.metricLabel} role="note">
                  Text on a path is point text — the paragraph box is ignored until the path is removed.
                </span>
              </div>
            ) : null}
            {paraBox && (
              <>
                <div className={styles.metricGrid}>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel} title="Box width — the text re-wraps">W</span>
                    <input
                      type="number"
                      aria-label="Box Width"
                      className={styles.metricInput}
                      value={typeof boxWidth === 'number' ? boxWidth : paraBox.boxWidth}
                      onChange={(e) => setBoxWidth(Math.max(MIN_BOX_SIZE, Number(e.target.value)))}
                    />
                    <span className={styles.metricUnit}>px</span>
                  </div>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel} title="Box height (Auto Height follows the text)">H</span>
                    <input
                      type="number"
                      aria-label="Box Height"
                      className={styles.metricInput}
                      disabled={!fixed}
                      value={fixed
                        ? (typeof boxHeight === 'number' ? boxHeight : paraBox.boxHeight)
                        : Math.round(measuredBox?.contentHeight ?? 0)}
                      onChange={(e) => setBoxHeight(Math.max(MIN_BOX_SIZE, Number(e.target.value)))}
                    />
                    <span className={styles.metricUnit}>px</span>
                  </div>
                </div>
                <div className={styles.controlRow}>
                  <Segmented
                    size="sm"
                    fullWidth
                    aria-label="Box Auto-Size"
                    value={autoSize}
                    onChange={(v) => setBoxAutoSize(primary, v)}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'height', label: 'Auto Height' },
                      { value: 'fit', label: 'Fit Text' },
                    ]}
                  />
                </div>
                <div className={styles.controlGroup} role="radiogroup" aria-label="Vertical Alignment in Box">
                  {V_ALIGNS.map((o) => (
                    <IconButton
                      key={o.value}
                      size="sm"
                      variant="ghost"
                      active={fixed && vAlign === o.value}
                      disabled={!fixed}
                      aria-label={o.label}
                      tooltip={fixed ? o.label : `${o.label} (needs a fixed box height)`}
                      className={styles.groupItem}
                      onClick={() => setBoxVerticalAlign(o.value)}
                    >
                      <Icon name={o.icon} size="sm" />
                    </IconButton>
                  ))}
                  {measuredBox?.overflow ? (
                    <span className={styles.metricLabel} title="Some text does not fit the box" role="status">Overflow</span>
                  ) : null}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Path Options (Mask text path riding) */}
      {hasTarget && maskPaths.length > 0 && (
        <div className={styles.sectionCard}>
          <div className={styles.controlRow}>
            <span className={styles.sectionHeader}>Mask Path</span>
            <select
              value={activePathId}
              aria-label="Mask Path"
              onChange={(e) => {
                if (!primary) return;
                const id = e.target.value;
                if (!id) setTextPath(primary, null);
                else updateTextPath(primary, { ...(textPathCfg ?? defaultTextPath()), pathId: id });
              }}
              className={`${styles.fontSelect} ${styles.pathSelect}`}
            >
              <option value="">None</option>
              {maskPaths.map((p, i) => (
                <option key={p.id} value={p.id}>{`Mask ${i + 1}`}</option>
              ))}
            </select>
          </div>
          {/* Path Options — keyframeable, also listed under Text in the timeline */}
          {textPathCfg && primary && <TextPathOptions nodeId={primary} />}
        </div>
      )}

      {/* Quick Typography Presets */}
      <div className={styles.sectionCard}>
        <div className={styles.sectionHeader}>Presets</div>
        <div className={styles.presetGrid}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={styles.presetChip}
              title={`${p.label} — ${p.fontSize}px / ${p.fontWeight}`}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  </TooltipProvider>
);
}
