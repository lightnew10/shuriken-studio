import { hudCombat, hudSimulator } from './hud';
import { collection, inventory } from './inventory';
import { codes, leaderboard, profile, questLog, settings } from './menus';
import { confirmDialog, dialogue, title, toasts } from './moments';
import { battlePass, dailyRewards, roundEnd } from './rewards';
import { shop } from './shop';
import type { Template } from './types';

export type { Template, TemplateInput, TemplateOutput } from './types';

/** Every screen template by id. */
export const TEMPLATES: Record<string, Template> = Object.fromEntries([shop, inventory, collection, hudCombat, hudSimulator, dailyRewards, battlePass, roundEnd, questLog, settings, leaderboard, codes, profile, title, dialogue, toasts, confirmDialog].map((t) => [t.id, t]));
