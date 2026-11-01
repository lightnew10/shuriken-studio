/**
 * Where Open Cloud keys are kept (encrypted by the main process; the renderer only sets, checks and removes them).
 * Every project uses the default key unless it has a key of its own: a game published under a community needs one
 * of that community's keys, so a community project keeps it beside the person's default.
 */
export const OPEN_CLOUD_KEY = 'roblox.openCloudApiKey';

/** A project's own Open Cloud key, by project id (project.json): used instead of the default while it is set. */
export const projectOpenCloudKey = (projectId: string): string => `${OPEN_CLOUD_KEY}:project:${projectId}`;

/** Which key a project's calls to Roblox use: its own, the default, or none is saved. */
export type OpenCloudKeySource = 'project' | 'default' | 'none';

/** A Roblox id as typed (a user or a community): digits only; '' or null is none. */
export const robloxId = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{1,20}$/.test(s) && s !== '0' ? s : null;
};

/** The Roblox side of a new project, chosen before it starts (start page, Open a game) or later in Settings. */
export interface ProjectRobloxChoice {
  /** The community (group) the project's uploads and store go to. */
  groupId?: string | null;
  /** Another Roblox account the project's uploads go to (unset: the default account in Settings). */
  userId?: string | null;
}

/** The project settings a choice sets: a community wins over an account; null when it names neither. */
export function choiceSettings(c: ProjectRobloxChoice | null | undefined): { robloxGroupId: string | null; robloxUserId: string | null } | null {
  const groupId = robloxId(c?.groupId);
  const userId = groupId ? null : robloxId(c?.userId);
  return groupId || userId ? { robloxGroupId: groupId, robloxUserId: userId } : null;
}
