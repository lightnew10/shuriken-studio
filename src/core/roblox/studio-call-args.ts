/**
 * Arguments of a Studio MCP tool called through roblox_call, completed where the call leaves no doubt about what
 * was meant. In one build eight calls came back "datamodel_type is required" or "wait_time_ms is required for
 * wait action": the input tools work in one DataModel only, and agents write a wait as {"action":"wait",
 * "seconds":1.5}. Each cost a turn. Everything here is read from the tool's own schema (the capability
 * registry's copy), nothing is guessed about a tool it doesn't describe, and the result says what was filled in.
 */

export interface FilledArgs {
  args: Record<string, unknown>;
  /** What was filled in or renamed, for the result ("datamodel_type \"Client\"", "\"steps\" → \"actions\""). */
  notes: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/** Names agents give a wait's length, by unit. */
const WAIT_MS = ['ms', 'milliseconds', 'duration_ms', 'wait_ms', 'time_ms', 'delay_ms'];
const WAIT_SEC = ['seconds', 'secs', 'duration', 'time', 'wait', 'delay', 'wait_time'];
/** The longest wait Studio's input tools take (their schema: "range 0 to 10000"). */
const WAIT_MAX_MS = 10_000;

const KEY_ACTIONS: Record<string, string> = { press: 'keyPress', keypress: 'keyPress', tap: 'keyPress', down: 'keyDown', keydown: 'keyDown', up: 'keyUp', keyup: 'keyUp' };

/** The DataModels a schema's datamodel_type takes (null when the tool has no such argument). */
function modelsOf(props: Json): string[] | null {
  const dm = obj(props.datamodel_type);
  if (!dm) return null;
  return Array.isArray(dm.enum) ? dm.enum.filter((x): x is string => typeof x === 'string') : ['Edit', 'Server', 'Client'];
}

/** Whether a tool's datamodel_type has to come from Studio's current mode (it takes several and the call names none). */
export function needsStudioMode(args: Json, schema: unknown): boolean {
  const models = modelsOf(obj(obj(schema)?.properties) ?? {});
  return !!models && models.length > 1 && args.datamodel_type === undefined;
}

/**
 * @param available the DataModels Studio has right now (Edit, or Client and Server during a playtest); null when unknown.
 */
export function fillStudioArgs(args: Json, schema: unknown, available: readonly string[] | null): FilledArgs {
  const props = obj(obj(schema)?.properties);
  if (!props) return { args, notes: [] };
  const out: Json = { ...args };
  const notes: string[] = [];
  const item = obj(obj(obj(props.actions)?.items)?.properties);

  if (props.actions && out.actions === undefined) {
    if (Array.isArray(out.steps)) {
      out.actions = out.steps;
      delete out.steps;
      notes.push('"steps" → "actions"');
    } else if (item?.key_code && (typeof out.key === 'string' || typeof out.key_code === 'string')) {
      // One key named at the top level: a single key action.
      const action = KEY_ACTIONS[String(out.action ?? out.type ?? 'press').toLowerCase()] ?? 'keyPress';
      out.actions = [{ action, key_code: out.key_code ?? out.key }];
      for (const k of ['key', 'key_code', 'action', 'type']) delete out[k];
      notes.push(`one key → "actions": [{"action":"${action}","key_code":…}]`);
    }
  }

  if (item && Array.isArray(out.actions)) {
    let renamedAction = false;
    let renamedKey = false;
    let waits = 0;
    let clamped = false;
    out.actions = out.actions.map((raw) => {
      const a = obj(raw);
      if (!a) return raw;
      const step: Json = { ...a };
      if (item.action && step.action === undefined && typeof step.type === 'string') {
        step.action = step.type;
        delete step.type;
        renamedAction = true;
      }
      if (item.key_code && step.key_code === undefined && typeof step.key === 'string') {
        step.key_code = step.key;
        delete step.key;
        renamedKey = true;
      }
      if (item.wait_time_ms && step.action === 'wait' && step.wait_time_ms === undefined) {
        const ms = WAIT_MS.find((k) => typeof step[k] === 'number');
        const sec = WAIT_SEC.find((k) => typeof step[k] === 'number');
        const value = ms ? (step[ms] as number) : sec ? (step[sec] as number) * 1000 : null;
        if (value !== null) {
          delete step[(ms ?? sec)!];
          step.wait_time_ms = Math.max(0, Math.min(WAIT_MAX_MS, Math.round(value)));
          if (value > WAIT_MAX_MS) clamped = true;
          waits++;
        }
      }
      return step;
    });
    if (renamedAction) notes.push('"type" → "action" in the steps');
    if (renamedKey) notes.push('"key" → "key_code" in the steps');
    if (waits) notes.push(`a wait's length → "wait_time_ms" in milliseconds${clamped ? ` (at most ${WAIT_MAX_MS}: chain waits for longer)` : ''}`);
  }

  const models = modelsOf(props);
  if (models && out.datamodel_type === undefined) {
    let pick: string | null = null;
    if (models.length === 1) pick = models[0]!;
    else if (available) pick = ['Edit', 'Server', 'Client'].find((m) => available.includes(m) && models.includes(m)) ?? null;
    if (pick) {
      out.datamodel_type = pick;
      notes.push(models.length === 1 ? `datamodel_type "${pick}" (the only one this tool works in)` : `datamodel_type "${pick}" (Studio's current mode)`);
    }
  }
  return { args: out, notes };
}
