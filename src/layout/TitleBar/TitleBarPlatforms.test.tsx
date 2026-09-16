import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { TitleBar } from './TitleBar';
import { __setUiPlatformForTests } from '@core/config/uiPlatform';
import { useNativeMenuSync } from '@layout/Menu/useNativeMenuSync';

jest.mock('@layout/Export/ExportDialog', () => ({ openExportDialog: jest.fn() }));
jest.mock('@layout/Menu/useNativeMenuSync', () => ({ useNativeMenuSync: jest.fn() }));

const renderAt = (path: string) =>
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <TitleBar />
      </MemoryRouter>
    </TooltipProvider>,
  );

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  __setUiPlatformForTests(null);
  jest.clearAllMocks();
});

describe('TitleBar on macOS', () => {
  it('draws nothing on the editor route — TopNav is the toolbar — but still syncs the native menu', () => {
    __setUiPlatformForTests({ platform: 'mac', windowControls: 'native' });
    const { container } = renderAt('/editor');
    expect(container).toBeEmptyDOMElement();
    expect(useNativeMenuSync).toHaveBeenCalled();
  });

  it('off the editor, is a bare bar: no menus, no Windows buttons', () => {
    __setUiPlatformForTests({ platform: 'mac', windowControls: 'native' });
    renderAt('/dashboard');
    expect(screen.getByText('Premation')).toBeInTheDocument();
    expect(screen.queryByTitle('Minimize')).toBeNull();
    // The OS draws the traffic lights on a real Mac.
    expect(screen.queryByRole('button', { name: 'Close window' })).toBeNull();
  });

  it('draws the traffic lights when previewing on another OS', () => {
    __setUiPlatformForTests({ platform: 'mac', windowControls: 'drawn' });
    renderAt('/dashboard');
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom window' })).toBeInTheDocument();
  });
});

describe('TitleBar on Windows / Linux', () => {
  it('leaves the caption buttons to the OS when it draws them', () => {
    __setUiPlatformForTests({ platform: 'windows', windowControls: 'native' });
    renderAt('/editor');
    expect(screen.getByRole('button', { name: /Export/i })).toBeInTheDocument();
    expect(screen.queryByTitle('Minimize')).toBeNull();
  });

  it('draws them in a preview', () => {
    __setUiPlatformForTests({ platform: 'linux', windowControls: 'drawn' });
    renderAt('/editor');
    expect(screen.getByTitle('Minimize')).toBeInTheDocument();
    expect(screen.getByTitle('Close')).toBeInTheDocument();
  });

  it('keeps the Customize gear, which macOS moves to the app menu', () => {
    __setUiPlatformForTests({ platform: 'windows', windowControls: 'native' });
    renderAt('/editor');
    expect(screen.getByRole('button', { name: 'Customize' })).toBeInTheDocument();
  });
});
