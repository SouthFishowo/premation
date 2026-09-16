/**
 * The Paint and Brushes panels' public face.
 *
 * Imported by the panel renderer map at boot, so the Ctrl+8 / Ctrl+9 commands
 * and the paint tools' keys (Ctrl+B, X, D, 3–7) exist before either panel has
 * ever been opened.
 */

import { registerPaintCommands } from './paintCommands';
import { installPaintKeys } from './paintTool';

registerPaintCommands();
installPaintKeys();

export { PaintPanel } from './PaintPanel';
export { BrushesPanel } from './BrushesPanel';
export { PAINT_PANEL_ID, BRUSHES_PANEL_ID } from './paintCommands';
