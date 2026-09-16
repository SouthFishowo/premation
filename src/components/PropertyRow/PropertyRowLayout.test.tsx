/**
 * The inspector layout is OPT-IN, and opting in changes only the inspector.
 *
 * `PropertyRow` is shared with the timeline and Effect Controls, whose grids
 * users scan by column. The compact Properties row (2026-09-15) drops the
 * reset button and moves the stopwatch into a hover tray — correct for the
 * inspector, a regression anywhere else. So what is pinned here is the switch:
 * the default grid keeps every control, the prop or the context turns the
 * inspector layout on, and a prop beats the context in both directions.
 *
 * Accessible names are asserted because they are the contract the rest of the
 * suite (and assistive tech) relies on; the markup is not.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PropertyRow, PropertyRowLayoutContext, sentenceCaseLabel } from './PropertyRow';

afterEach(cleanup);

const nav = {
  hasPrev: false,
  hasNext: true,
  atKeyframe: false,
  onPrev: () => {},
  onNext: () => {},
  onToggleKeyframe: () => {},
};

function Row(props: { layout?: 'default' | 'inspector'; animated?: boolean; onReset?: () => void }): JSX.Element {
  return (
    <PropertyRow
      label="Skew Axis"
      srLabel="Skew Axis"
      animated={props.animated}
      onStopwatch={() => {}}
      navigator={nav}
      onReset={props.onReset ?? (() => {})}
      layout={props.layout}
    >
      <span data-numeric>0</span>
    </PropertyRow>
  );
}

describe('PropertyRow layout switch', () => {
  it('the default grid keeps the reset button and the registry label', () => {
    const { container } = render(<Row />);
    expect(screen.getByRole('button', { name: 'Reset Skew Axis' })).toBeInTheDocument();
    expect(screen.getByText('Skew Axis')).toBeInTheDocument();
    expect(container.querySelector('[data-layout="inspector"]')).toBeNull();
  });

  it('layout="inspector" drops the reset button and sentence-cases the shown label only', () => {
    const { container } = render(<Row layout="inspector" />);
    expect(screen.queryByRole('button', { name: 'Reset Skew Axis' })).toBeNull();
    expect(screen.getByText('Skew axis')).toBeInTheDocument();
    // The accessible name keeps the registry spelling.
    expect(screen.getByRole('button', { name: 'Enable Skew Axis animation' })).toBeInTheDocument();
    expect(container.querySelector('[data-property-row][data-layout="inspector"]')).not.toBeNull();
  });

  it('the context turns it on for every row below', () => {
    render(
      <PropertyRowLayoutContext.Provider value="inspector">
        <Row />
      </PropertyRowLayoutContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: 'Reset Skew Axis' })).toBeNull();
  });

  it('an explicit prop beats the context', () => {
    render(
      <PropertyRowLayoutContext.Provider value="inspector">
        <Row layout="default" />
      </PropertyRowLayoutContext.Provider>,
    );
    expect(screen.getByRole('button', { name: 'Reset Skew Axis' })).toBeInTheDocument();
  });

  it('the inspector navigator appears only once the property is animated, and still works', () => {
    const onNext = jest.fn();
    const { rerender } = render(<Row layout="inspector" />);
    expect(screen.queryByRole('button', { name: 'Next Skew Axis keyframe' })).toBeNull();
    rerender(
      <PropertyRow label="Skew Axis" animated onStopwatch={() => {}} navigator={{ ...nav, onNext }} layout="inspector">
        <span data-numeric>0</span>
      </PropertyRow>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next Skew Axis keyframe' }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('keeps the mixed mark and hint reachable in the inspector layout', () => {
    render(
      <PropertyRow label="Opacity" mixed hint="2 of 3" layout="inspector">
        <span data-numeric>—</span>
      </PropertyRow>,
    );
    expect(screen.getByLabelText('Mixed values')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
  });
});

describe('sentenceCaseLabel', () => {
  it.each([
    ['Skew Axis', 'Skew axis'],
    ['Anchor Point', 'Anchor point'],
    ['Position X', 'Position X'],
    ['3D Layer', '3D layer'],
    ['IK Damping', 'IK damping'],
    ['Opacity', 'Opacity'],
  ])('%s → %s', (input, output) => {
    expect(sentenceCaseLabel(input)).toBe(output);
  });
});
