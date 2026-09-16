import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { TopNav } from './TopNav';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { __setUiPlatformForTests } from '@core/config/uiPlatform';

jest.mock('@layout/Export/ExportDialog', () => ({ openExportDialog: jest.fn() }));
// Wide enough that nothing collapses, so what is absent is absent by design.
jest.mock('./useElementWidth', () => ({ useElementWidth: () => 2400 }));

const renderTopNav = () =>
  render(
    <TooltipProvider>
      <MemoryRouter>
        <TopNav />
      </MemoryRouter>
    </TooltipProvider>,
  );

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) as never }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  __setUiPlatformForTests(null);
});

describe('TopNav as the macOS unified toolbar', () => {
  it('carries the traffic-light corner, the project and the actions', () => {
    __setUiPlatformForTests({ platform: 'mac', windowControls: 'drawn' });
    renderTopNav();
    expect(screen.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-platform', 'mac');
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export/i })).toHaveAttribute('data-tour', 'export');
  });

  it('hands Undo / Redo to the Edit menu and Settings to the app menu', () => {
    __setUiPlatformForTests({ platform: 'mac', windowControls: 'native' });
    renderTopNav();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull();
    // A real Mac draws its own traffic lights.
    expect(screen.queryByRole('button', { name: 'Close window' })).toBeNull();
  });
});

describe('TopNav under the Windows / Linux title bar', () => {
  it('is the tool row only — the actions and window buttons live in the title bar', () => {
    __setUiPlatformForTests({ platform: 'windows', windowControls: 'native' });
    renderTopNav();
    expect(screen.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-platform', 'windows');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close window' })).toBeNull();
  });
});
