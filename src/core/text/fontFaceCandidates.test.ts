/**
 * The `local()` names an alias face tries, in order: postscriptName → fullName
 * → family. Chromium matches local() by PostScript or full name — measured with
 * Playwright on Chromium 151: `local("Yu Gothic")` fails to load, while
 * `local("YuGothic-Regular")` and `local("Yu Gothic Regular")` load and turn 「.
 */

import { localFaceCandidates } from './fontFaceVariants';

describe('localFaceCandidates', () => {
  it('uses the local font index names first, family last', () => {
    expect(localFaceCandidates({ fontFamily: 'Yu Gothic' }, { postscriptName: 'YuGothic-Regular', fullName: 'Yu Gothic Regular' }))
      .toEqual(['YuGothic-Regular', 'Yu Gothic Regular', 'Yu Gothic']);
  });

  it('drops duplicates (MS Gothic: full name == family)', () => {
    expect(localFaceCandidates({ fontFamily: 'MS Gothic' }, { postscriptName: 'MS-Gothic', fullName: 'MS Gothic' }))
      .toEqual(['MS-Gothic', 'MS Gothic']);
  });

  it('guesses PostScript and full names from the family without an index', () => {
    expect(localFaceCandidates({ fontFamily: 'Yu Gothic', fontWeight: '400' }, undefined))
      .toEqual(['YuGothic-Regular', 'Yu Gothic Regular', 'Yu Gothic']);
    expect(localFaceCandidates({ fontFamily: 'Yu Gothic', fontWeight: '700', fontStyle: 'italic' }, undefined))
      .toEqual(['YuGothic-BoldItalic', 'Yu Gothic Bold Italic', 'Yu Gothic']);
    // An unnamed weight: only the family (plus the italic full-name guess).
    expect(localFaceCandidates({ fontFamily: 'Meiryo', fontWeight: '600', fontStyle: 'italic' }, undefined))
      .toEqual(['Meiryo Italic', 'Meiryo']);
  });

  it('never lets a quote through into the local() source', () => {
    expect(localFaceCandidates({ fontFamily: 'Odd"Name' }, { postscriptName: 'Odd"PS', fullName: 'Odd"Full' }))
      .toEqual(['OddPS', 'OddFull', 'OddName']);
  });
});
