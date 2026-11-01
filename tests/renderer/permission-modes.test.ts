import { describe, expect, it } from 'vitest';
import { ALWAYS_ASKS, PERMISSION_MODES, PROJECT_MODE_CHOICES, appMode, effectiveMode, projectChoice, projectModeNote, projectSetting } from '../../src/renderer/src/lib/permission-modes';

// The Settings → Agents → Permissions control: its words and how a button maps to what the engine stores
// (AppPrefs.permissionMode and ProjectSettings.permissionMode).

describe('app-wide permission control', () => {
  it('offers the two modes, autonomous first and marked as the default', () => {
    expect(PERMISSION_MODES.map((o) => o.value)).toEqual(['autonomous', 'ask']);
    expect(PERMISSION_MODES[0]!.label).toBe('Autonomous: never asks, except to spend money or publish (default)');
    expect(PERMISSION_MODES[1]!.label).toBe('Ask before risky steps');
  });

  it('says in one sentence what always asks', () => {
    expect(ALWAYS_ASKS.match(/\./g)).toHaveLength(1);
    expect(ALWAYS_ASKS).toMatch(/spending money/i);
    expect(ALWAYS_ASKS).toMatch(/publishing the game/i);
  });

  it('reads the stored value the way the engine does: anything but ask is autonomous', () => {
    expect(appMode('ask')).toBe('ask');
    expect(appMode('autonomous')).toBe('autonomous');
    expect(appMode(undefined)).toBe('autonomous');
    expect(appMode('garbage')).toBe('autonomous');
  });
});

describe('per-project override', () => {
  it('has the three choices in the order the user asked for', () => {
    expect(PROJECT_MODE_CHOICES.map((c) => c.label)).toEqual(['Same as the app', 'Autonomous', 'Ask']);
  });

  it('maps a stored setting to a button and a button back to what is stored', () => {
    expect(projectChoice(undefined)).toBe('app');
    expect(projectChoice(null)).toBe('app');
    expect(projectChoice('nonsense')).toBe('app');
    expect(projectChoice('autonomous')).toBe('autonomous');
    expect(projectChoice('ask')).toBe('ask');
    expect(projectSetting('app')).toBeNull();
    expect(projectSetting('autonomous')).toBe('autonomous');
    expect(projectSetting('ask')).toBe('ask');
    // Every button round-trips.
    for (const c of PROJECT_MODE_CHOICES) expect(projectChoice(projectSetting(c.value))).toBe(c.value);
  });

  it('shows the mode in effect: the project wins, else the app', () => {
    expect(effectiveMode(null, 'ask')).toBe('ask');
    expect(effectiveMode(undefined, undefined)).toBe('autonomous');
    expect(effectiveMode('autonomous', 'ask')).toBe('autonomous');
    expect(effectiveMode('ask', 'autonomous')).toBe('ask');
    expect(projectModeNote(null, 'ask')).toBe('Follows the app setting, which is Ask right now.');
    expect(projectModeNote(null, 'autonomous')).toBe('Follows the app setting, which is Autonomous right now.');
    expect(projectModeNote('ask', 'autonomous')).toBe('This project uses Ask, whatever the app setting says.');
  });
});
