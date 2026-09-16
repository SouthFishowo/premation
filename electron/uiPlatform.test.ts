import {
  devUiPlatformOverride,
  hasTitleBarOverlay,
  parseUiPlatform,
  readEnvFileValue,
  resolveUiChrome,
  sanitizeOverlayColors,
  uiChromeQuery,
  UI_PLATFORM_ENV,
  windowChromeOptions,
} from './uiPlatform';

describe('parseUiPlatform', () => {
  it.each([
    ['mac', 'mac'],
    ['macOS', 'mac'],
    [' darwin ', 'mac'],
    ['osx', 'mac'],
    ['windows', 'windows'],
    ['WIN', 'windows'],
    ['win32', 'windows'],
    ['linux', 'linux'],
    ['', null],
    [undefined, null],
    ['beos', null],
  ])('%p → %p', (raw, want) => {
    expect(parseUiPlatform(raw as string | undefined)).toBe(want);
  });
});

describe('resolveUiChrome', () => {
  it('follows the OS, with its native controls, when nothing is overridden', () => {
    expect(resolveUiChrome({ osPlatform: 'darwin', isDev: true })).toEqual({ platform: 'mac', windowControls: 'native', overridden: false });
    expect(resolveUiChrome({ osPlatform: 'win32', isDev: true })).toEqual({ platform: 'windows', windowControls: 'native', overridden: false });
    expect(resolveUiChrome({ osPlatform: 'linux', isDev: true })).toEqual({ platform: 'linux', windowControls: 'native', overridden: false });
  });

  it('draws the controls when a dev override crosses between Mac and the rest', () => {
    expect(resolveUiChrome({ osPlatform: 'win32', isDev: true, override: 'mac' })).toEqual({ platform: 'mac', windowControls: 'drawn', overridden: true });
    expect(resolveUiChrome({ osPlatform: 'darwin', isDev: true, override: 'windows' })).toEqual({ platform: 'windows', windowControls: 'drawn', overridden: true });
  });

  it('keeps native controls between Windows and Linux, which share the overlay', () => {
    expect(resolveUiChrome({ osPlatform: 'win32', isDev: true, override: 'linux' })).toEqual({ platform: 'linux', windowControls: 'native', overridden: true });
  });

  it('ignores the override in a packaged build', () => {
    expect(resolveUiChrome({ osPlatform: 'win32', isDev: false, override: 'mac' })).toEqual({ platform: 'windows', windowControls: 'native', overridden: false });
  });

  it('treats an empty or unknown override as this OS', () => {
    expect(resolveUiChrome({ osPlatform: 'win32', isDev: true, override: '' }).platform).toBe('windows');
    expect(resolveUiChrome({ osPlatform: 'darwin', isDev: true, override: 'amiga' }).overridden).toBe(false);
  });
});

describe('windowChromeOptions', () => {
  it('is frameless when the renderer draws the controls', () => {
    expect(windowChromeOptions({ platform: 'mac', windowControls: 'drawn', overridden: true })).toEqual({ frame: false });
  });

  it('keeps the real traffic lights on a Mac, centred in the 44px toolbar', () => {
    const o = windowChromeOptions({ platform: 'mac', windowControls: 'native', overridden: false });
    expect(o.titleBarStyle).toBe('hidden');
    expect(o.trafficLightPosition).toEqual({ x: 16, y: 15 });
    expect(o.frame).toBeUndefined();
    expect(o.titleBarOverlay).toBeUndefined();
  });

  it('uses the OS caption buttons on Windows / Linux, as tall as the 32px title bar', () => {
    const o = windowChromeOptions({ platform: 'windows', windowControls: 'native', overridden: false });
    expect(o.titleBarStyle).toBe('hidden');
    expect(o.titleBarOverlay).toMatchObject({ height: 32 });
    expect(o.frame).toBeUndefined();
  });

  it('only an overlay window can be recoloured', () => {
    expect(hasTitleBarOverlay({ platform: 'windows', windowControls: 'native', overridden: false })).toBe(true);
    expect(hasTitleBarOverlay({ platform: 'linux', windowControls: 'native', overridden: false })).toBe(true);
    expect(hasTitleBarOverlay({ platform: 'mac', windowControls: 'native', overridden: false })).toBe(false);
    expect(hasTitleBarOverlay({ platform: 'windows', windowControls: 'drawn', overridden: true })).toBe(false);
  });

  it('hands the renderer the same answer on the URL', () => {
    expect(uiChromeQuery({ platform: 'mac', windowControls: 'drawn', overridden: true })).toEqual({ uiPlatform: 'mac', windowControls: 'drawn' });
  });
});

describe('the dev override source', () => {
  it('reads one key out of dotenv text', () => {
    expect(readEnvFileValue(['# c', 'OTHER=1', `${UI_PLATFORM_ENV}="mac"`, ''].join('\n'), UI_PLATFORM_ENV)).toBe('mac');
    expect(readEnvFileValue(`${UI_PLATFORM_ENV}=windows # a note\r\n`, UI_PLATFORM_ENV)).toBe('windows');
    expect(readEnvFileValue(`export ${UI_PLATFORM_ENV}='linux'`, UI_PLATFORM_ENV)).toBe('linux');
    expect(readEnvFileValue(`${UI_PLATFORM_ENV}=\n`, UI_PLATFORM_ENV)).toBe('');
    expect(readEnvFileValue('# PREMATION_UI_PLATFORM=mac', UI_PLATFORM_ENV)).toBeUndefined();
  });

  it("prefers the shell, then Vite's dotenv order", () => {
    const files: Record<string, string> = {
      '.env': `${UI_PLATFORM_ENV}=linux`,
      '.env.local': `${UI_PLATFORM_ENV}=mac`,
    };
    const read = (file: string): string => {
      const name = file.split(/[\\/]/).pop()!;
      if (name in files) return files[name]!;
      throw new Error('ENOENT');
    };
    expect(devUiPlatformOverride({}, '/repo', read)).toBe('mac');
    expect(devUiPlatformOverride({ [UI_PLATFORM_ENV]: 'windows' }, '/repo', read)).toBe('windows');
    files['.env.development.local'] = `${UI_PLATFORM_ENV}=windows`;
    expect(devUiPlatformOverride({}, '/repo', read)).toBe('windows');
    delete files['.env.development.local'];
    delete files['.env.local'];
    expect(devUiPlatformOverride({}, '/repo', read)).toBe('linux');
    expect(devUiPlatformOverride({}, '/repo', () => { throw new Error('ENOENT'); })).toBeUndefined();
  });
});

describe('sanitizeOverlayColors', () => {
  it('accepts two #rrggbb colours and nothing else', () => {
    expect(sanitizeOverlayColors({ color: '#141416', symbolColor: '#A1A1AA' })).toEqual({ color: '#141416', symbolColor: '#A1A1AA' });
    expect(sanitizeOverlayColors({ color: 'red', symbolColor: '#a1a1aa' })).toBeNull();
    expect(sanitizeOverlayColors({ color: '#141416' })).toBeNull();
    expect(sanitizeOverlayColors('#141416')).toBeNull();
    expect(sanitizeOverlayColors(null)).toBeNull();
  });
});
