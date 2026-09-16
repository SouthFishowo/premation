/**
 * Where a plugin can be installed FROM.
 *
 * In the hosted build installing lives on the dashboard's Plugins page, beside
 * publishing, and the editor dock does not install. The local edition has no
 * dashboard, so there the dock is the install surface. Every surface renders
 * one `PluginsList` — that is what keeps them from drifting — so the difference
 * is a single prop, and a single prop is exactly the kind of thing that gets
 * passed to the wrong one later.
 *
 * The assertion that earns its place is the DROP target. Hiding a button is
 * visible the moment anyone looks; leaving the drop zone live behind it is not,
 * and it would mean the dock still installs by a route nobody can see.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { PluginsPanel } from './PluginsPanel';
import { PluginsList } from './PluginsList';

const takeFile = jest.fn(async () => {});

/** Whether this "build" has the dashboard. Flipped per describe. */
const edition = { hasDashboard: true };

jest.mock('@core/config/edition', () => ({
  pluginRegistryEnabled: () => false,
  cloudProjectsEnabled: () => edition.hasDashboard,
}));
jest.mock('@core/plugins/registry', () => ({
  browseRegistry: jest.fn(async () => ({ available: false, items: [], total: 0 })),
  checkForUpdates: jest.fn(async () => []),
  registryMediaUrl: (p: string | null) => p,
}));
jest.mock('./useDiskInstall', () => ({
  useDiskInstall: () => ({
    takeFile,
    takeFolder: jest.fn(),
    sheet: null,
  }),
}));

beforeEach(() => {
  takeFile.mockClear();
  edition.hasDashboard = true;
});

/** A files drag, as the browser reports one. */
function dropFile(target: HTMLElement): void {
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'p.zip');
  const dataTransfer = { types: ['Files'], files: [file] };
  fireEvent.drop(target, { dataTransfer });
}

describe('the editor dock, in a build with a dashboard', () => {
  it('offers no way to add a plugin', () => {
    render(<PluginsPanel />);
    expect(screen.queryByRole('button', { name: /add a plugin/i })).not.toBeInTheDocument();
  });

  it('★ does not install on drop either', () => {
    // The invisible half. A dock that still took a dropped package would have
    // lost the affordance and kept the capability.
    const { container } = render(<PluginsPanel />);
    dropFile(container.firstElementChild as HTMLElement);
    expect(takeFile).not.toHaveBeenCalled();
  });

  it('says where to go instead of dead-ending', async () => {
    // This panel is empty exactly when someone new first opens it.
    //
    // `findBy`, not `getBy`: the list renders skeleton rows until the registry
    // browse settles, so a synchronous read here asserts against a loading
    // state and fails claiming the text is missing.
    render(<PluginsPanel />);
    expect(await screen.findByText(/dashboard.s Plugins page/i)).toBeInTheDocument();
  });
});

describe('the editor dock, in the local edition (no dashboard)', () => {
  beforeEach(() => { edition.hasDashboard = false; });

  it('offers the add control — it is the only install surface there is', () => {
    render(<PluginsPanel />);
    expect(screen.getByRole('button', { name: /add a plugin/i })).toBeInTheDocument();
  });

  it('★ installs a dropped package', () => {
    const { container } = render(<PluginsPanel />);
    dropFile(container.firstElementChild as HTMLElement);
    expect(takeFile).toHaveBeenCalled();
  });

  it('never points at a dashboard that does not exist', async () => {
    render(<PluginsPanel />);
    expect(await screen.findByText(/install plugins from a folder or a \.zip package/i)).toBeInTheDocument();
    expect(screen.queryByText(/dashboard.s Plugins page/i)).not.toBeInTheDocument();
  });
});

describe('the dashboard copy', () => {
  it('still offers the add control', () => {
    render(<PluginsList />);
    expect(screen.getByRole('button', { name: /add a plugin/i })).toBeInTheDocument();
  });

  it('still installs on drop', () => {
    const { container } = render(<PluginsList />);
    dropFile(container.firstElementChild as HTMLElement);
    expect(takeFile).toHaveBeenCalled();
  });
});
