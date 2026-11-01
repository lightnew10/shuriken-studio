import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload of Shuriken's view onto Kiln (see main/kiln-dock.ts): Kiln's embedded UI talks to the
 * Shuriken project it is docked in through window.kilnHost. Main only answers pages from Kiln's own
 * address, and the view can't navigate anywhere else.
 */
let dock: 'docked' | 'undocked' = 'docked';
ipcRenderer.on('kiln:dock-state', (_e, state: unknown) => {
  if (state === 'docked' || state === 'undocked') dock = state;
});

contextBridge.exposeInMainWorld('kilnHost', {
  app: 'shuriken',
  /** Imports a Kiln project into the current Shuriken project as a Roblox model named `name`. */
  useModel: (kilnProjectId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('kiln:use-model', { kilnProjectId: String(kilnProjectId), name: String(name) }),
  /**
   * Kiln's "Send to Studio": brings a Kiln project's model (or clip) into the Shuriken project and puts
   * it in the open Studio place where Studio's camera looks, in one step.
   */
  sendToStudio: (req: { kind: 'model' | 'animation'; projectId: string; name: string; clip?: string }): Promise<{ ok: boolean; error?: string; placed?: string; note?: string }> =>
    ipcRenderer.invoke('kiln:send-to-studio', { kind: req?.kind === 'animation' ? 'animation' : 'model', kilnProjectId: String(req?.projectId ?? ''), name: String(req?.name ?? ''), clip: req?.clip ? String(req.clip) : undefined }),
  dockState: (): 'docked' | 'undocked' => dock,
  toggleDock: (): void => ipcRenderer.send('kiln:toggle-dock'),
});
