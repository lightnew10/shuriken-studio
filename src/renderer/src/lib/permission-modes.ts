import type { PermissionMode } from '@shared/domain';

/**
 * The words and the small logic behind Settings → Agents → Permissions (docs/ARCHITECTURE.md, "Permission modes").
 * No React here: tests/renderer covers it.
 */

export const PERMISSION_MODES: ReadonlyArray<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'autonomous', label: 'Autonomous: never asks, except to spend money or publish (default)', hint: 'The planner and the director decide for you. What they decided is listed on the Agents page.' },
  { value: 'ask', label: 'Ask before risky steps', hint: 'Risky commands, large deletions, spec changes and open questions wait for you in the chat.' },
];

/** The one sentence under the control: what asks whatever the mode is. */
export const ALWAYS_ASKS = 'Spending money (Robux or paid services) and publishing the game always ask you first, in either mode.';

export const PROJECT_MODE_LABEL: Record<PermissionMode, string> = { autonomous: 'Autonomous', ask: 'Ask' };

/** A project's own choice, as the three buttons show it: 'app' means no override of its own. */
export type ProjectModeChoice = 'app' | PermissionMode;

export const PROJECT_MODE_CHOICES: ReadonlyArray<{ value: ProjectModeChoice; label: string }> = [
  { value: 'app', label: 'Same as the app' },
  { value: 'autonomous', label: 'Autonomous' },
  { value: 'ask', label: 'Ask' },
];

const isMode = (v: unknown): v is PermissionMode => v === 'autonomous' || v === 'ask';

/** The app-wide mode as the page reads it (anything but 'ask' is the default, as in AppPrefsService). */
export const appMode = (v: unknown): PermissionMode => (v === 'ask' ? 'ask' : 'autonomous');

/** Which button a project's stored setting selects (unset, null or unreadable: the same as the app). */
export const projectChoice = (stored: unknown): ProjectModeChoice => (isMode(stored) ? stored : 'app');

/** What to store for a button: null clears the override. */
export const projectSetting = (choice: ProjectModeChoice): PermissionMode | null => (choice === 'app' ? null : choice);

/** The mode in effect in a project (the project's own choice wins over the app's), as the engine decides it. */
export const effectiveMode = (project: unknown, app: unknown): PermissionMode => (isMode(project) ? project : appMode(app));

/** The line under the project's buttons. */
export function projectModeNote(project: unknown, app: unknown): string {
  const now = PROJECT_MODE_LABEL[effectiveMode(project, app)];
  return isMode(project) ? `This project uses ${now}, whatever the app setting says.` : `Follows the app setting, which is ${now} right now.`;
}
