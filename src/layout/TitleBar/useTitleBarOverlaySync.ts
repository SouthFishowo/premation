import { useEffect } from 'react';
import { getUiPlatform, getWindowControls, hasDesktopChrome } from '@core/config/uiPlatform';

/**
 * A computed CSS colour as `#rrggbb`, alpha dropped; null when unparseable.
 * Chromium reports `rgb()` / `rgba()` for most values and `color(srgb …)` for
 * anything that went through `color-mix`.
 */
export function cssColorToHex(value: string): string | null {
  const byte = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value.trim());
  if (rgb) return `#${byte(+rgb[1]!)}${byte(+rgb[2]!)}${byte(+rgb[3]!)}`;
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(value.trim());
  if (srgb) return `#${byte(+srgb[1]! * 255)}${byte(+srgb[2]! * 255)}${byte(+srgb[3]! * 255)}`;
  const hex = /^#([0-9a-f]{6})\b/i.exec(value.trim());
  return hex ? `#${hex[1]!.toLowerCase()}` : null;
}

/**
 * Keeps the OS caption buttons (the Windows / Linux Window Controls Overlay)
 * the colour of the title bar they sit in.
 *
 * Main creates them with a dark default because it cannot know the theme; the
 * theme lives here, so the bar's surface and secondary-text colours are pushed
 * across on mount and on every theme change. A no-op on macOS, in a
 * drawn-controls preview, and in a browser.
 */
export function useTitleBarOverlaySync(): void {
  useEffect(() => {
    const setOverlay = window.electronAPI?.window?.setTitleBarOverlay;
    if (!setOverlay || !hasDesktopChrome() || getUiPlatform() === 'mac' || getWindowControls() !== 'native') return;

    let frame = 0;
    let last = '';
    const sync = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Resolve the tokens through a real element: a custom property read
        // straight off :root can still be a `var()` / `color-mix()` expression.
        const probe = document.createElement('div');
        probe.style.cssText =
          'position:absolute;width:0;height:0;visibility:hidden;' +
          'background-color:var(--color-surface-1);color:var(--color-text-secondary)';
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe);
        const color = cssColorToHex(cs.backgroundColor);
        const symbolColor = cssColorToHex(cs.color);
        probe.remove();
        if (!color || !symbolColor || color + symbolColor === last) return;
        last = color + symbolColor;
        void setOverlay({ color, symbolColor });
      });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
}
