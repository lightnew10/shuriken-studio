/**
 * Runs that must never reach the user's real Roblox Studio: unit and integration tests (vitest.config.ts sets
 * SHURIKEN_NO_STUDIO=1). With it set, nothing connects to Studio's MCP server, starts Studio, or acts on a Studio
 * window (close, raise, save through its menu). Without this a test that touched a Studio tool reached whatever Studio
 * the user had open, including a place a live build was working in.
 */
export const studioForbidden = (): boolean => process.env.SHURIKEN_NO_STUDIO === '1';

export const STUDIO_FORBIDDEN = 'Studio is switched off for this run (SHURIKEN_NO_STUDIO=1)';
