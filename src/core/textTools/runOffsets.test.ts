import { diffEdit, shiftRunsForEdits } from './runOffsets';

const run = (start: number, end: number) => ({ start, end, style: { fill: '#f00' } });

describe('shiftRunsForEdits', () => {
  it('boundaries before an edit stay; after it they move by the delta', () => {
    // "cat sat" → replace "cat" (0..3) with "tiger" (5)
    expect(shiftRunsForEdits([run(4, 7)], [{ start: 0, end: 3, insertLength: 5 }], 9)).toEqual([run(6, 9)]);
    expect(shiftRunsForEdits([run(0, 2)], [{ start: 4, end: 7, insertLength: 1 }], 5)).toEqual([run(0, 2)]);
  });

  it('a run covering the replaced word covers its replacement', () => {
    expect(shiftRunsForEdits([run(0, 3)], [{ start: 0, end: 3, insertLength: 5 }], 9)).toEqual([run(0, 5)]);
  });

  it('boundaries INSIDE the replaced span snap to the replacement', () => {
    // run [1, 5) over "hello world": replace 3..8 with 2 chars
    expect(shiftRunsForEdits([run(1, 5)], [{ start: 3, end: 8, insertLength: 2 }], 8)).toEqual([run(1, 5)]);
    expect(shiftRunsForEdits([run(4, 10)], [{ start: 3, end: 8, insertLength: 2 }], 8)).toEqual([run(3, 7)]);
  });

  it('many edits accumulate — the Replace All case diffing cannot express', () => {
    // "a b a b a" replace each "a" (0,4,8) with "xyz": runs on each "b" (2, 6)
    const edits = [0, 4, 8].map((s) => ({ start: s, end: s + 1, insertLength: 3 }));
    expect(shiftRunsForEdits([run(2, 3), run(6, 7)], edits, 15)).toEqual([run(4, 5), run(10, 11)]);
  });

  it('a run whose text was deleted entirely disappears', () => {
    expect(shiftRunsForEdits([run(2, 4)], [{ start: 1, end: 5, insertLength: 0 }], 3)).toEqual([]);
  });
});

describe('diffEdit', () => {
  it('finds the single changed span', () => {
    expect(diffEdit([...'Hello world'], [...'Hello brave world'])).toEqual({ start: 6, end: 6, insertLength: 6 });
    expect(diffEdit([...'abc'], [...'abc'])).toEqual({ start: 3, end: 3, insertLength: 0 });
  });
});
