/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

describe('Mp4TtmlParser', () => {
  const ttmlInitSegmentUri = '/base/test/test/assets/ttml-init.mp4';
  const ttmlSegmentUri = '/base/test/test/assets/ttml-segment.mp4';
  const ttmlSegmentMultipleMDATUri =
      '/base/test/test/assets/ttml-segment-multiplemdat.mp4';
  const audioInitSegmentUri = '/base/test/test/assets/sintel-audio-init.mp4';

  /** @type {!Uint8Array} */
  let ttmlInitSegment;
  /** @type {!Uint8Array} */
  let ttmlSegment;
  /** @type {!Uint8Array} */
  let ttmlSegmentMultipleMDAT;
  /** @type {!Uint8Array} */
  let audioInitSegment;

  beforeAll(async () => {
    const responses = await Promise.all([
      shaka.test.Util.fetch(ttmlInitSegmentUri),
      shaka.test.Util.fetch(ttmlSegmentUri),
      shaka.test.Util.fetch(ttmlSegmentMultipleMDATUri),
      shaka.test.Util.fetch(audioInitSegmentUri),
    ]);
    ttmlInitSegment = shaka.util.BufferUtils.toUint8(responses[0]);
    ttmlSegment = shaka.util.BufferUtils.toUint8(responses[1]);
    ttmlSegmentMultipleMDAT = shaka.util.BufferUtils.toUint8(responses[2]);
    audioInitSegment = shaka.util.BufferUtils.toUint8(responses[3]);
  });

  it('parses init segment', () => {
    new shaka.text.Mp4TtmlParser().parseInit(ttmlInitSegment);
  });


  it('handles media segments with multiple mdats', () => {
    const parser = new shaka.text.Mp4TtmlParser();
    parser.parseInit(ttmlInitSegment);
    const time = {periodStart: 0, segmentStart: 0, segmentEnd: 0};
    const ret = parser.parseMedia(ttmlSegmentMultipleMDAT, time);
    expect(ret.length).toBe(20);
  });

  it('accounts for offset', () => {
    const time1 = {periodStart: 0, segmentStart: 0, segmentEnd: 0};
    const time2 = {periodStart: 7, segmentStart: 0, segmentEnd: 0};

    const parser = new shaka.text.Mp4TtmlParser();
    parser.parseInit(ttmlInitSegment);

    const ret1 = parser.parseMedia(ttmlSegment, time1);
    expect(ret1.length).toBeGreaterThan(0);

    const ret2 = parser.parseMedia(ttmlSegment, time2);
    expect(ret2.length).toBeGreaterThan(0);

    expect(ret2[0].startTime).toBe(ret1[0].startTime + 7);
    expect(ret2[0].endTime).toBe(ret1[0].endTime + 7);
  });

  it('rejects init segment with no ttml', () => {
    const error = shaka.test.Util.jasmineError(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.TEXT,
        shaka.util.Error.Code.INVALID_MP4_TTML));

    expect(() => new shaka.text.Mp4TtmlParser().parseInit(audioInitSegment))
        .toThrow(error);
  });

  it('parses media segment', () => {
    const cues = [
      {
        startTime: 23,
        endTime: 24.5,
        payload: 'You\'re a jerk, Thom.',
      },
      {
        startTime: 25,
        endTime: 27,
        payload: 'Look Celia, we have to follow our passions;',
      },
      {
        startTime: 27,
        endTime: 30.5,
        payload: '...you have your robotics, and I\n'+
            'just want to be awesome in space.',
      },
      {
        startTime: 30.8,
        endTime: 34,
        payload: 'Why don\'t you just admit that\nyou\'re freaked out by my' +
            ' robot hand?',
      },
      {
        startTime: 34.5,
        endTime: 36,
        payload: 'I\'m not freaked out by- it\'s...',
      },
      {
        startTime: 37,
        endTime: 38,
        payload: '...alright! Fine!',
      },
      {
        startTime: 38,
        endTime: 41,
        payload: 'I\'m freaked out! I have nightmares\nthat I\'m being' +
            ' chased...',
      },
      {
        startTime: 41,
        endTime: 42,
        payload: '...by these giant robotic claws of death...',
      },
      {
        startTime: 42.2,
        endTime: 45,
        payload: '"Fourty years later"\nWhatever, Thom. We\'re done.',
      },
      {
        startTime: 50,
        endTime: 53.5,
        payload: 'Robot\'s memory synced and locked!',
      },
    ];
    const parser = new shaka.text.Mp4TtmlParser();
    parser.parseInit(ttmlInitSegment);
    const time = {periodStart: 0, segmentStart: 0, segmentEnd: 0};
    const result = parser.parseMedia(ttmlSegment, time);
    verifyHelper(cues, result);
  });

  function verifyHelper(/** !Array */ expected, /** !Array */ actual) {
    expect(actual).toEqual(expected.map((c) => jasmine.objectContaining(c)));
  }
});
