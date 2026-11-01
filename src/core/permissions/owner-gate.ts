import type { PermissionMode } from '@shared/domain';
import type { PermissionClass } from './policy';

/**
 * What always waits for the app's owner, in every permission mode: spending money (Robux or paid services)
 * and publishing the game. Everything else Shuriken's agents used to ask about is, in autonomous mode,
 * decided by the AI system and logged (see docs/ARCHITECTURE.md, "Permission modes").
 *
 * `needsOwner` is the one predicate. The tool gate (ToolRegistry.invoke), the shell gate (decideShell) and
 * escalations (an agent's own question) all ask it, so what counts as spending or publishing is defined
 * here and nowhere else. It reads what an action is, never what the user's settings say: no mode, escalation
 * rule or standing approval turns a `needsOwner` action into an automatic one.
 */

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'autonomous';

/** The mode in effect: the project's own choice, else the app-wide preference, else the default. */
export function effectivePermissionMode(project: PermissionMode | null | undefined, app: PermissionMode | null | undefined): PermissionMode {
  for (const v of [project, app]) if (v === 'autonomous' || v === 'ask') return v;
  return DEFAULT_PERMISSION_MODE;
}

/** What the action does that only the owner may allow. */
export interface OwnerNeed {
  why: 'spending' | 'publishing';
  /** The escalation rule that governs it (a project rule of `deny` still denies; nothing turns it into `allow`). */
  rule: 'spending' | 'publishing';
  /** Short name of the action for a card or a log line. */
  what: string;
  reason: string;
}

export type OwnerAction =
  /** A capability-layer tool call (the agent MCP tools). */
  | { kind: 'tool'; tool: string; permission: PermissionClass; args?: unknown }
  /** A shell command line an agent wants to run. */
  | { kind: 'shell'; command: string }
  /** What an agent says to the owner (an `escalate` question): its title and detail. */
  | { kind: 'text'; text: string };

const need = (why: OwnerNeed['why'], what: string): OwnerNeed => ({
  why,
  rule: why,
  what,
  reason: `${what} ${why === 'spending' ? 'spends money' : 'publishes the game'}: that always needs the owner, in every permission mode`,
});

// ─── What counts as publishing or spending ───────────────────────────────────

/** Luau that saves to Roblox or publishes from Studio (MessagingService:PublishAsync is another thing and is not matched). */
const LUAU_PUBLISH = /\bStudioPublishService\b|[:.]\s*(?:PublishAs|SavePlaceAsync|CreatePlaceAsync|CreatePlaceInPlayerInventoryAsync|SaveToRoblox|PublishToRoblox)\b/;
/** Luau that completes a purchase (the Prompt* dialogs ask the person at the keyboard themselves, in Roblox's own window). */
const LUAU_SPEND = /[:.]\s*(?:PerformPurchase|PerformBulkPurchase|PerformPurchaseV2|PerformSubscriptionPurchase)\b/;
/** Roblox web endpoints that publish a place or experience, or buy something. */
const URL_PUBLISH_SPEND =
  /\b(?:apis|develop|economy|publish|gamepublish|data|www|premiumfeatures|billing|catalog)\.roblox\.com\/[^\s"'`]*?(?:\/purchases?(?:\/|\?|\b)|\/activate\b|\/deactivate\b|\/publish\b|Upload\.ashx|versionType=Published|\/universes\/v1\/\d+\/places\/\d+\/versions|\/subscriptions?\b)/i;
/** Command-line tools that publish a place or an experience to Roblox, or a package to a registry. */
const SHELL_PUBLISH = /\b(?:npm|pnpm|yarn)\s+publish\b|\bwally\s+publish\b|\brojo\s+upload\b|\bmantle\s+(?:deploy|up)\b|\brbxcloud\b[^\n|;&]*\b(?:publish|deploy|upload)\b|\bremodel\b[^\n|;&]*\bpublish\b/i;
/** Command-line tools that pay for something. */
const SHELL_SPEND = /\b(?:stripe|paypal)\s+(?:charge|pay|checkout)\b|\brobux\b[^\n]*\b(?:buy|purchase|spend)\b|\b(?:buy|purchase|spend)\b[^\n]*\brobux\b/i;
/** Writes to a live game's data from Open Cloud Luau: the published universe, not a place file. */
const LIVE_DATA_WRITE = /[:.]\s*(?:SetAsync|UpdateAsync|IncrementAsync|RemoveAsync|RemoveVersionAsync|SetBinaryAsync|SetStringAsync)\s*\(|MessagingService[^\n]*PublishAsync|\bOrderedDataStore\b[^\n]*[:.]\s*(?:SetAsync|UpdateAsync|IncrementAsync|RemoveAsync)/;

/**
 * An agent's own words that ask the owner to spend or publish (their question is the owner's by nature). A dollar
 * figure alone is not spending: agents quote what work costs in usage ("about 3 hours and about $40 of Kiln time"
 * sent a modeling question to a sleeping user), and Kiln builds run "on the same subscription". A price counts next
 * to a word for paying.
 */
const PAY_WORD = String.raw`(?:buy|buying|purchase|purchasing|pay|paying|charged?|fee|invoice|checkout|price[ds]?)`;
const TEXT_SPEND = new RegExp(
  String.raw`\brobux\b|\breal money\b|\bcredit card\b|\bbilling\b|\bpaid (?:asset|service|plan|upload|tier|api|model|tool|license)\b|\bspend(?:ing)?\s+(?:any\s+|some\s+)?(?:money|funds|cash|currency)\b|\b(?:buy|purchase|pay for)\s+(?:an?\s+|the\s+|this\s+)?(?:asset|license|plan|subscription|upgrade|credits)\b|\btop[- ]?up\b|\b${PAY_WORD}\b[^\n]{0,60}\$\s?\d|\$\s?\d[^\n]{0,60}\b${PAY_WORD}\b`,
  'i',
);
const TEXT_PUBLISH = /\bpublish(?:ing)?\s+(?:the\s+|this\s+|your\s+|my\s+)?(?:game|experience|place|universe|version)\b|\bgo(?:ing)?\s+live\b|\b(?:make|set)\s+(?:the\s+|this\s+)?(?:game|experience|place)\s+(?:public|live)\b|\brelease\s+(?:the\s+)?game\b/i;

/** Tools that run code of the agent's own: what they are about to run is read for publish and purchase calls. */
const CODE_TOOLS = new Set(['roblox_run_luau', 'roblox_call', 'cloud_luau_run', 'roblox_playtest', 'external_call']);
/** Studio MCP tool names (roblox_call's `tool`) that publish or buy. */
const STUDIO_TOOL_PUBLISH_SPEND = /publish|purchase|checkout|subscribe|robux/i;

const stringify = (v: unknown): string => {
  try {
    return (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, 400_000);
  } catch {
    return '';
  }
};

/** What publishing/spending a piece of code or command text would do, or null. */
function scanCode(text: string, opts: { liveData?: boolean } = {}): OwnerNeed | null {
  if (LUAU_PUBLISH.test(text)) return need('publishing', 'This Luau (SavePlaceAsync / PublishAs / StudioPublishService)');
  if (URL_PUBLISH_SPEND.test(text)) return need('publishing', 'A call to a Roblox publish or purchase endpoint');
  if (LUAU_SPEND.test(text)) return need('spending', 'This Luau (PerformPurchase)');
  if (opts.liveData && LIVE_DATA_WRITE.test(text)) return need('publishing', "This Luau (it writes the live game's data, DataStores or MessagingService)");
  return null;
}

/**
 * Does this action spend money or publish the game, so the owner must allow it? Null when it doesn't.
 * Pure: the same answer in every permission mode.
 */
export function needsOwner(action: OwnerAction): OwnerNeed | null {
  switch (action.kind) {
    case 'tool': {
      if (action.permission === 'spending') return need('spending', action.tool);
      if (action.permission === 'publish') return need('publishing', action.tool);
      if (!CODE_TOOLS.has(action.tool)) return null;
      const args = (action.args ?? {}) as { tool?: unknown };
      if (action.tool === 'roblox_call' && typeof args.tool === 'string' && STUDIO_TOOL_PUBLISH_SPEND.test(args.tool)) return need(/purchase|checkout|subscribe|robux/i.test(args.tool) ? 'spending' : 'publishing', `The Studio tool ${args.tool}`);
      return scanCode(stringify(action.args), { liveData: action.tool === 'cloud_luau_run' });
    }
    case 'shell': {
      if (SHELL_PUBLISH.test(action.command)) return need('publishing', 'This command (a publish or upload to Roblox or a package registry)');
      if (SHELL_SPEND.test(action.command)) return need('spending', 'This command (a payment)');
      return scanCode(action.command);
    }
    case 'text': {
      if (TEXT_SPEND.test(action.text)) return need('spending', 'This question (it involves paying)');
      if (TEXT_PUBLISH.test(action.text)) return need('publishing', 'This question (it involves publishing the game)');
      return null;
    }
  }
}
