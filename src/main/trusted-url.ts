import { pathToFileURL } from 'node:url';
export function trustedRendererUrl(url: string, appFile: string, developmentUrl?: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (developmentUrl) { const dev = new URL(developmentUrl); return parsed.origin === dev.origin && parsed.pathname === dev.pathname; }
    const app = pathToFileURL(appFile);
    return parsed.protocol === 'file:' && parsed.hostname === app.hostname && parsed.pathname === app.pathname;
  } catch { return false; }
}

/** Matching URLs do not authorize an iframe to call privileged IPC. */
export function trustedMainFrame(frame: { url: string } | null | undefined, main: { url: string }, appFile: string, developmentUrl?: string): boolean {
  return !!frame && frame === main && trustedRendererUrl(frame.url, appFile, developmentUrl);
}
