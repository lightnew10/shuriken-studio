import { OPEN_CLOUD_KEY, projectOpenCloudKey, type OpenCloudKeySource } from '@shared/roblox-keys';
import type { SecretProvider } from './open-cloud-luau';

/**
 * The secrets the core asks for, with the open project's own Open Cloud key in place of the default one (a window
 * runs one core, so one project). A project without a key of its own uses the default, as before; uploads, the
 * store push and Luau on a published place all ask through here.
 */
export function projectSecrets(base: SecretProvider, projectId: () => string | null): SecretProvider {
  return async (key) => {
    if (key !== OPEN_CLOUD_KEY) return base(key);
    const id = projectId();
    if (id) {
      const own = await base(projectOpenCloudKey(id)).catch(() => null);
      if (own) return own;
    }
    return base(OPEN_CLOUD_KEY);
  };
}

/** Which key the project's calls use now: its own, the default, or none (nothing is saved). */
export async function keySource(base: SecretProvider, projectId: string | null): Promise<OpenCloudKeySource> {
  if (projectId && (await base(projectOpenCloudKey(projectId)).catch(() => null))) return 'project';
  return (await base(OPEN_CLOUD_KEY).catch(() => null)) ? 'default' : 'none';
}
