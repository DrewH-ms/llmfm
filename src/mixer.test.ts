import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelVolume, createMixer } from './mixer.ts';
import type { MidiOut } from './midi-out.ts';
import { MASTER_VOLUME_MAX, MAX_MIDI_VALUE } from './constants.ts';

test('master 100 leaves a part exactly where it was', () => {
  // Any rounding drift here would be a silent, permanent change to the default mix.
  for (const level of [0, 0.25, 1 / 3, 0.5, 0.99, 1]) {
    assert.equal(
      channelVolume({ level, masterVolume: MASTER_VOLUME_MAX }),
      Math.round(level * MAX_MIDI_VALUE),
    );
  }
});

test('a gated-off part stays silent at every master volume', () => {
  for (let volume = 0; volume <= MASTER_VOLUME_MAX; volume += 5) {
    assert.equal(channelVolume({ level: 0, masterVolume: volume }), 0);
  }
});

test('master 0 silences even a fully audible part', () => {
  assert.equal(channelVolume({ level: 1, masterVolume: 0 }), 0);
});

test('the result is always a MIDI value, whatever it is given', () => {
  const inputs = [-100, -1, 0, 0.5, 37, 99.4, 100, 1000, Number.NaN, Number.POSITIVE_INFINITY];
  for (const masterVolume of inputs) {
    for (const level of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      const value = channelVolume({ level, masterVolume });
      assert.ok(Number.isInteger(value), `${level}/${masterVolume} gave ${value}`);
      assert.ok(value >= 0 && value <= MAX_MIDI_VALUE, `${level}/${masterVolume} gave ${value}`);
    }
  }
});

test('a part still fading out keeps the transport running', async () => {
  // Bug: both checks read the gate rather than the level, so the transport paused and
  // note-offed everything the instant a part was gated off. The fade then ramped CC7 over
  // channels that had already gone quiet, and every stop was heard as an abrupt cut.
  const sent: number[] = [];
  const midi: MidiOut = {
    start: async () => ({ ok: true, device: 'test' }) as never,
    send: (message: number) => void sent.push(message),
    status: () => ({ ok: true, device: 'test' }) as never,
    stop: () => {},
  };

  const mixer = createMixer(midi);
  mixer.bindScore({
    parts: [{ partId: 'p1', name: 'Flute', program: 73, channel: 0, percussion: false, notes: [] }],
  } as never);

  assert.ok(mixer.anyAudible());
  mixer.setPartAudible({ partId: 'p1', audible: false, fadeSeconds: 0.2 });

  // The gate is shut immediately, but the part is still sounding and must keep its notes.
  assert.equal(mixer.anyGateOpen(), false);
  assert.ok(mixer.anyAudible(), 'transport would pause mid-fade');
  assert.ok(mixer.isPartAudible('p1'), 'fade would have no notes left to act on');

  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(mixer.anyAudible(), false, 'never settled, so the transport never pauses');
  assert.equal(mixer.isPartAudible('p1'), false);
  mixer.stop();
});

test('master volume is monotonic and scales a mid-fade level too', () => {
  let previous = -1;
  for (let volume = 0; volume <= MASTER_VOLUME_MAX; volume += 5) {
    const value = channelVolume({ level: 0.5, masterVolume: volume });
    assert.ok(value >= previous, `${volume} went backwards`);
    previous = value;
  }
  assert.ok(previous < channelVolume({ level: 1, masterVolume: MASTER_VOLUME_MAX }));
});

test('half master is a perceptual half, not a numeric one', () => {
  // A straight linear scale would give 64. The synth reads CC7 as attenuation, so the
  // curve has to sit above the linear line for the control to feel even across its range.
  const half = channelVolume({ level: 1, masterVolume: MASTER_VOLUME_MAX / 2 });
  assert.ok(half > MAX_MIDI_VALUE / 2, `expected above 64, got ${half}`);
  assert.ok(half < MAX_MIDI_VALUE * 0.75, `expected below 95, got ${half}`);
});
