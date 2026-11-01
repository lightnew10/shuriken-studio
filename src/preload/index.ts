import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { ShurikenBridge, CoreStatus, KilnStatus, StripMenu, StripState } from './api';

/** The only surface the renderer gets: typed RPC into core, event subscription, and a few OS helpers. */
const bridge: ShurikenBridge = {
  invoke: (method, params) => ipcRenderer.invoke('rpc', method, params ?? {}),
  on: (listener) => {
    const fn = (_e: IpcRendererEvent, channel: string, payload: unknown) => listener(channel, payload);
    ipcRenderer.on('core:event', fn);
    return () => ipcRenderer.removeListener('core:event', fn);
  },
  onStatus: (listener) => {
    const fn = (_e: IpcRendererEvent, s: CoreStatus) => listener(s);
    ipcRenderer.on('core:status', fn);
    return () => ipcRenderer.removeListener('core:status', fn);
  },
  status: () => ipcRenderer.invoke('core:status'),
  openDirectory: (title) => ipcRenderer.invoke('dialog:openDirectory', title),
  openPlaceFile: () => ipcRenderer.invoke('dialog:openPlaceFile'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  saveFileAs: (source, suggestedName) => ipcRenderer.invoke('file:saveAs', source, suggestedName),
  trashProject: (p) => ipcRenderer.invoke('projects:trash', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  readImage: (p) => ipcRenderer.invoke('file:readImage', p),
  secrets: {
    set: (k, v) => ipcRenderer.invoke('secrets:set', k, v),
    has: (k) => ipcRenderer.invoke('secrets:has', k),
    delete: (k) => ipcRenderer.invoke('secrets:delete', k),
    copy: (from, to) => ipcRenderer.invoke('secrets:copy', from, to),
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  platform: process.platform,
  journal: (kind, data) => ipcRenderer.send('journal', kind, data ?? null),
  journalDir: () => ipcRenderer.invoke('journal:dir'),
  windows: {
    open: (projectId) => ipcRenderer.invoke('windows:open', projectId ?? null),
    blank: () => ipcRenderer.invoke('windows:blank'),
    adopt: (game) => ipcRenderer.invoke('windows:adopt', game),
    projects: () => ipcRenderer.invoke('windows:projects'),
  },
  kiln: {
    page: (state) => ipcRenderer.send('kiln:page', state),
    locate: (configured) => ipcRenderer.invoke('kiln:locate', configured ?? ''),
    toggleDock: () => ipcRenderer.send('kiln:toggle-dock'),
    onStatus: (listener) => {
      const fn = (_e: IpcRendererEvent, s: KilnStatus) => listener(s);
      ipcRenderer.on('kiln:status', fn);
      return () => ipcRenderer.removeListener('kiln:status', fn);
    },
  },
  tabs: {
    list: () => ipcRenderer.invoke('tabs:list'),
    select: (id) => ipcRenderer.invoke('tabs:select', id),
    close: (id) => ipcRenderer.invoke('tabs:close', id),
    create: () => ipcRenderer.invoke('tabs:new'),
    move: (id, index) => ipcRenderer.invoke('tabs:move', id, index),
    drop: (id, x, y) => ipcRenderer.invoke('tabs:drop', id, x, y),
    detach: (id) => ipcRenderer.invoke('tabs:detach', id),
    dock: (id) => ipcRenderer.invoke('tabs:dock', id),
    menu: (m) => ipcRenderer.send('strip:menu', m),
    onChanged: (listener) => {
      const fn = (_e: IpcRendererEvent, s: StripState) => listener(s);
      ipcRenderer.on('tabs:changed', fn);
      return () => ipcRenderer.removeListener('tabs:changed', fn);
    },
    onMenu: (listener) => {
      const fn = (_e: IpcRendererEvent, m: StripMenu) => listener(m);
      ipcRenderer.on('strip:menu', fn);
      return () => ipcRenderer.removeListener('strip:menu', fn);
    },
  },
};

contextBridge.exposeInMainWorld('shuriken', bridge);
