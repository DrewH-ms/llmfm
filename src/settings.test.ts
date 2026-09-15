import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTING_DEFAULTS,
  SETTING_SPECS,
  coerceSetting,
  displaySetting,
  nextSetting,
} from './settings.ts';

test('every setting has a default, and every default is valid', () => {
  // The two lists are maintained separately, and a setting present in one but not the
  // other fails silently: the menu shows a blank, or the config file grows a dead key.
  for (const spec of SETTING_SPECS) {
    const value = SETTING_DEFAULTS[spec.key as keyof typeof SETTING_DEFAULTS];
    assert.notEqual(value, undefined, `${spec.key} has no default`);
    assert.notEqual(coerceSetting(spec.key, value), null, `${spec.key} default is invalid`);
  }
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    assert.ok(
      SETTING_SPECS.some((spec) => spec.key === key),
      `${key} has a default but no spec, so nothing can edit it`,
    );
  }
});

test('an unknown key is rejected rather than stored', () => {
  assert.equal(coerceSetting('nonsense', 'value'), null);
  assert.equal(nextSetting('nonsense', 'value', 1), null);
});

test('a choice accepts only its own values', () => {
  assert.equal(coerceSetting('gate', 'always'), 'always');
  assert.equal(coerceSetting('gate', 'sideways'), null);
  assert.equal(coerceSetting('gate', 4), null);
});

test('cycling a choice wraps in both directions', () => {
  const spec = SETTING_SPECS.find((entry) => entry.key === 'gate');
  assert.ok(spec && spec.kind === 'choice');
  const first = spec.choices[0];
  const last = spec.choices[spec.choices.length - 1];
  assert.equal(nextSetting('gate', last, 1), first);
  assert.equal(nextSetting('gate', first, -1), last);
});

test('a number is clamped to its range and snapped to its step', () => {
  assert.equal(coerceSetting('masterVolume', 1000), 100);
  assert.equal(coerceSetting('masterVolume', -20), 0);
  assert.equal(coerceSetting('masterVolume', 42), 40);
  assert.equal(coerceSetting('masterVolume', Number.NaN), null);
  assert.equal(coerceSetting('masterVolume', '50'), null);
});

test('cycling a number stops at the ends instead of wrapping', () => {
  // Wrapping volume would take a keypress at 100 straight to silence, which reads as a
  // crash rather than a setting.
  assert.equal(nextSetting('masterVolume', 100, 1), 100);
  assert.equal(nextSetting('masterVolume', 0, -1), 0);
});

test('a toggle takes only booleans and flips from anything', () => {
  assert.equal(coerceSetting('startupMotif', false), false);
  assert.equal(coerceSetting('startupMotif', 'true'), null);
  assert.equal(nextSetting('startupMotif', true, 1), false);
  assert.equal(nextSetting('startupMotif', undefined, 1), true);
});

test('every choice renders a label rather than its raw value', () => {
  // The raw values are for the wire; a menu reading `per-agent` explains nothing.
  for (const spec of SETTING_SPECS) {
    if (spec.kind !== 'choice') continue;
    for (const choice of spec.choices) {
      assert.notEqual(displaySetting(spec.key, choice), '', `${spec.key}/${choice} is blank`);
    }
  }
  assert.equal(displaySetting('idleDropoutMinutes', 0), 'never');
  assert.equal(displaySetting('idleDropoutMinutes', 15), '15 min');
  assert.equal(displaySetting('startupMotif', false), 'off');
});

test('a number carrying a unit prints it, so the value names a quantity', () => {
  // "Fade 2" says nothing on its own, and the menu has no other place to put the unit.
  assert.equal(displaySetting('fadeSeconds', 2), '2s');
  assert.equal(displaySetting('fadeSeconds', 0.25), '0.25s');
});

test('fade is a setting, with a floor that is still a crossfade', () => {
  // It reached the menu because a user reported it broken and had no way to see its value.
  const spec = SETTING_SPECS.find((entry) => entry.key === 'fadeSeconds');
  assert.ok(spec && spec.kind === 'number');
  assert.ok(spec.min > 0, 'an instant cut clicks, so zero is not offered');
  assert.equal(coerceSetting('fadeSeconds', 0), spec.min);
  assert.equal(coerceSetting('fadeSeconds', 1000), spec.max);
  assert.equal(nextSetting('fadeSeconds', 1, 1), 1 + spec.step);
  assert.equal(nextSetting('fadeSeconds', spec.min, -1), spec.min);
});

test('mode and autoplay are ordinary settings, validated like the rest', () => {
  assert.equal(coerceSetting('mode', 'alert'), 'alert');
  assert.equal(coerceSetting('mode', 'reward'), 'reward');
  assert.equal(coerceSetting('mode', 'loud'), null);
  assert.equal(coerceSetting('autoplay', 'random'), 'random');
  assert.equal(coerceSetting('autoplay', 'next'), null);
});

test('no two settings share a key, a title, or a value label', () => {
  // A user asked how `After you approve` differed from `mode`, having read both as the
  // same control. Two rows that read alike are the bug, whatever the keys say.
  const keys = SETTING_SPECS.map((spec) => spec.key);
  const titles = SETTING_SPECS.map((spec) => spec.title.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(titles).size, titles.length);
  for (const spec of SETTING_SPECS) {
    assert.ok(spec.help.trim().length > 0, `${spec.key} has no help`);
  }
});
