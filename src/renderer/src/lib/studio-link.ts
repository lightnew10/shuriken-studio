/** Shuriken Link (the Studio plugin) as `studio.link.status` reports it. */
export interface StudioLinkInfo {
  /** The link exists in this run (not in tests or smoke runs). */
  available: boolean;
  enabled: boolean;
  installed: boolean;
  pluginFile: string | null;
  port: number | null;
  /** The DataModels of this project's place that are linked right now. */
  linked: Array<'Edit' | 'Server' | 'Client'>;
  calls: number;
  failed: number;
}

/** What the Studio plugin is doing right now, in one line. */
export function studioLinkLine(s: StudioLinkInfo | null | undefined): string {
  if (!s) return '';
  if (!s.available) return 'Not used in this run.';
  if (!s.enabled) return 'Off: the plugin file is removed and code reaches Studio through Studio’s own AI connection, with Shuriken’s workarounds for what Roblox restricts there.';
  if (!s.installed) return `The plugin file could not be written${s.pluginFile ? ` (${s.pluginFile})` : ''}. Code reaches Studio the slower way meanwhile.`;
  if (!s.port) return 'The plugin is installed, but Shuriken found no free port to listen on. Code reaches Studio the slower way meanwhile.';
  if (!s.linked.length) return 'Installed. Not linked to this project’s place yet: a Studio window loads the plugin when it opens, so close and reopen the place’s Studio window once.';
  return `Linked to this project’s place (${s.linked.join(', ')}) · ${s.calls.toLocaleString('en-US')} calls through it${s.failed ? `, ${s.failed.toLocaleString('en-US')} with an error from the code` : ''}.`;
}
