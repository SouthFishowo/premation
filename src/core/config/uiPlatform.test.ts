import {
  __setUiPlatformForTests,
  configureUiPlatform,
  getUiPlatform,
  getWindowControls,
  hasDesktopChrome,
  parseUiPlatform,
} from './uiPlatform';
import { parseUiPlatform as parseInMain } from '../../../electron/uiPlatform';

const setBridge = (value: unknown): void => {
  (window as unknown as { electronAPI?: unknown }).electronAPI = value;
};

afterEach(() => {
  __setUiPlatformForTests(null);
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete document.documentElement.dataset.platform;
});

describe('configureUiPlatform', () => {
  it("takes the Electron shell's answer from the URL over the env", () => {
    setBridge({});
    configureUiPlatform({ search: '?uiPlatform=mac&windowControls=native', devOverride: 'windows', isDev: true });
    expect(getUiPlatform()).toBe('mac');
    expect(getWindowControls()).toBe('native');
    expect(hasDesktopChrome()).toBe(true);
    expect(document.documentElement.dataset.platform).toBe('mac');
  });

  it('assumes drawn controls when a shell passes no query (a frameless window)', () => {
    setBridge({});
    configureUiPlatform({ search: '', isDev: true });
    expect(getWindowControls()).toBe('drawn');
  });

  it('previews the desktop chrome in a browser dev build from PREMATION_UI_PLATFORM', () => {
    configureUiPlatform({ search: '', devOverride: 'mac', isDev: true });
    expect(hasDesktopChrome()).toBe(true);
    expect(getUiPlatform()).toBe('mac');
    expect(getWindowControls()).toBe('drawn');
  });

  it('previews from the query alone in a browser dev build, so two tabs can show both designs', () => {
    configureUiPlatform({ search: '?uiPlatform=windows', devOverride: 'mac', isDev: true });
    expect(hasDesktopChrome()).toBe(true);
    expect(getUiPlatform()).toBe('windows');
  });

  it('ignores the env and the query outside development', () => {
    configureUiPlatform({ search: '', devOverride: 'mac', isDev: false });
    expect(hasDesktopChrome()).toBe(false);
    configureUiPlatform({ search: '?uiPlatform=mac', isDev: false });
    expect(hasDesktopChrome()).toBe(false);
  });

  it('an empty override leaves a browser build on the web chrome', () => {
    configureUiPlatform({ search: '', devOverride: '', isDev: true });
    expect(hasDesktopChrome()).toBe(false);
  });
});

describe('parseUiPlatform parity with the main process', () => {
  it.each(['mac', 'MacOS', ' darwin', 'osx', 'windows', 'win', 'WIN32', 'linux', '', 'amiga', undefined, null])(
    'agrees on %p',
    (raw) => {
      expect(parseUiPlatform(raw)).toBe(parseInMain(raw));
    },
  );
});
