/**
 * A brief for Kiln as data: what the game needs of a model or of a family of parts that must fit
 * together. Shuriken keeps it structured (the goal text, the models asked for, the sockets by name and
 * constraint, what it is fitted against, the game's shared style, the budget) and sends it the way the
 * running Kiln takes it:
 *
 * - up to Kiln 0.8.1 the copilot takes one text, so everything is rendered to prose;
 * - from Kiln 0.8.2 the checkable requirements go as data (`spec`: triangles, size, ground contact, the
 *   socket names; `style`: the id of the game's style sheet), Kiln checks them when the turn ends
 *   (`delivery.checks`), and the prose keeps only what data can't say: the goal, which models the project
 *   holds, what each socket joins and where it has to be, what the family is fitted against.
 *
 * The brief asks for results. Sockets are names and constraints: Kiln chooses where they go, and
 * Shuriken reads the positions back (modeling/kiln-family.ts).
 */

/** The first Kiln with `spec` and `style` on a brief, `mode` on a chat POST, models with sockets and a fit check in the delivery. */
export const KILN_FIELDS_VERSION = '0.8.2';

/** A point where parts join: its name, what it joins, and the constraint the game needs. Kiln chooses the numbers. */
export interface SocketSpec {
  name: string;
  /** What attaches there ("the top centre of every leg set"). */
  joins: string;
  /** Where it has to be, as a constraint ("bottom centre of every torso; the same position on all three"). */
  where?: string;
}

/** One model of a family: a separately named object in the family's Kiln project that becomes its own model in the game. */
export interface MemberSpec {
  name: string;
  /** What this one is, in a few words ("compact scout frame"). */
  what?: string;
  /** About how big, studs: [width, height, depth]. */
  size?: [number, number, number];
}

/** An earlier family (or model) this one is fitted against: its Kiln project, so Kiln's copilot can bring a part in. */
export interface FitSpec {
  name: string;
  projectId: string;
  members: string[];
  sockets: string[];
}

export interface KilnBriefSpec {
  /** The goals as the agent wrote them. */
  text: string;
  /** The specific existing subject Kiln researches first. */
  references?: string;
  /** A family: several models built in ONE Kiln project so they fit and match. */
  family?: string;
  members?: MemberSpec[];
  fits?: FitSpec[];
  sockets?: SocketSpec[];
  /** The game's shared look, one paragraph, the same in every brief of the game. */
  style?: string | null;
  /** Triangles per model, at most. */
  tris?: number;
  /** A single model's size, studs: [width, height, depth]. */
  size?: [number, number, number];
  /** It stands on the ground: its lowest point is the floor. */
  grounded?: boolean;
  /** Parts the game's code finds and moves by name (a door, a lid, a barrel): each stays its own object, marked kiln_part. */
  parts?: string[];
  /** A piece of a map that Shuriken's team assembles: its exact footprint on the ground, studs [width, depth]. */
  footprint?: [number, number];
}

/**
 * What Shuriken adds to the brief of a map piece its team will place: the one number the assembly depends on,
 * and that it is a piece (a brief that mentions surroundings gets scenery built). Nothing else: where the origin
 * sits and ground level are Kiln's own defaults (bottom centre, 0; asked of Kiln 0.8.6; the facing is not yet
 * stated in its prompt for static Roblox pieces, so those four words stay until it is), and
 * the design is Kiln's. `spec.size` is only checked within 20%, so the footprint is said in words.
 */
export function footprintLine(f: [number, number], each: boolean): string {
  return `${each ? 'Map pieces, each on its own' : 'A map piece on its own'} (no ground or base), footprint exactly ${n(f[0])} x ${n(f[1])} studs${each ? ' each' : ''}, front facing -Y.`;
}

/** `spec` on a brief (Kiln 0.8.2): what the result must satisfy, checked by Kiln when the turn ends. Sizes are scene axes: [x, y, z up]. */
export interface KilnSpec {
  tris?: number;
  size?: [number, number, number];
  ground?: true;
  sockets?: string[];
  /** Parts the game finds by name (Kiln 0.8.5): the delivery's `parts` check passes when each exists as a marked part. */
  parts?: string[];
}

/** From this Kiln a brief's `spec.parts` is checked, and the manifest lists each model's marked parts. */
export const KILN_PARTS_VERSION = '0.8.5';

/** How a brief is sent: as one text (false / fields false), or with Kiln 0.8.2's fields. */
export interface BriefFields {
  fields: boolean;
  /** The id of the game's style sheet in Kiln. */
  styleId?: string | null;
  /** Kiln has that sheet already (so the brief needn't describe the look again). */
  styleKnown?: boolean;
  /** Kiln checks named parts itself (KILN_PARTS_VERSION). */
  parts?: boolean;
}

const n = (v: number) => (Math.round(v * 10) / 10).toString();
const sizeText = (s: [number, number, number]) => `about ${n(s[0])} wide × ${n(s[1])} tall × ${n(s[2])} deep (studs)`;
const end = (s: string) => s.trim().replace(/[.\s]+$/, '');

/** How a socket's marker is named in a Kiln 0.8.1 scene so Shuriken can tell whose it is: "<model>.<socket>". */
export const socketMarkerName = (model: string, socket: string) => `${model}.${socket}`;

/**
 * The brief's text: the agent's goals first and unchanged, then one plain paragraph for each thing the
 * game needs that the text didn't say. With `fields` (Kiln 0.8.2) the budget, the size, ground contact
 * and (once Kiln has the sheet) the style are left to the brief's data, and what is left is a bare list:
 * Kiln's own prompt says what a socket, a named part and a set of models are (asked of Kiln 0.8.6, which
 * needs only what the data can't carry: what each socket joins and where, and the models' names). The
 * explanations stay for a Kiln that takes one text.
 */
export function renderBrief(b: KilnBriefSpec, to: BriefFields = { fields: false }): string {
  const out = [b.text.trim()];
  const refs = b.references?.trim();
  if (refs) out.push(`The subject is ${end(refs)}.`);
  const bare = to.fields;
  if (b.style?.trim() && !(to.fields && to.styleKnown)) out.push(bare ? `Game look: ${end(b.style)}.` : `The look every model of this game shares: ${end(b.style)}.`);
  const members = b.members ?? [];
  if (members.length > 1) {
    const list = members.map((m) => `${m.name}${m.what || m.size ? ` (${[m.what ? end(m.what) : '', m.size ? sizeText(m.size) : ''].filter(Boolean).join('; ')})` : ''}`).join(', ');
    if (bare) out.push(`Separate models, exact top-level names: ${list}.`);
    else out.push(
      `One project, ${members.length} separate models: ${list}. Each is its own top-level object with exactly that name (everything that belongs to it under it), side by side and not overlapping: each becomes its own model in the game, so build them in one scene against the same sockets and with the same proportions and materials.`,
    );
  } else if (b.size && !to.fields) out.push(`Size: ${sizeText(b.size)}.`);
  const sockets = b.sockets ?? [];
  if (sockets.length) {
    const first = members[0]?.name;
    const each = members.length > 1 ? 'every one of these models' : 'the model';
    const how = to.fields
      ? 'Make each a socket on its part and declare what it mates with, so the fit is checked.'
      : `Give each back as a named point: an attach point when the model is rigged, otherwise a marker with role "socket"${members.length > 1 ? `, named <model>.<socket> (${socketMarkerName(first!, sockets[0]!.name)})` : ''}, its +Y pointing out of the joint.`;
    if (bare) out.push(`Sockets${members.length > 1 ? ' (on every model)' : ''}: ${sockets.map((s) => `${s.name} (joins ${end(s.joins)}${s.where ? `; ${end(s.where)}` : ''})`).join(', ')}.`);
    else out.push(`Sockets on ${each} (you choose where they go; I read the positions back): ${sockets.map((s) => `${s.name}: joins ${end(s.joins)}${s.where ? `; ${end(s.where)}` : ''}`).join('. ')}. ${how}`);
  }
  // A Kiln that checks named parts (spec.parts) knows what one is.
  if (b.parts?.length && !(to.fields && to.parts))
    out.push(
      `The game's code finds and moves these by name: ${b.parts.join(', ')}. Keep each as its own object (what belongs to it parented under it) and give it the custom property kiln_part set to that name, e.g. obj["kiln_part"] = "${b.parts[0]}"${(b.members?.length ?? 0) > 1 ? ', in every model that has one' : ''}. Everything else may be merged.`,
    );
  if (b.footprint) out.push(footprintLine(b.footprint, members.length > 1));
  for (const f of b.fits ?? []) {
    out.push(
      `These must fit the parts already built in Kiln project "${f.projectId}" (${f.name}: ${f.members.join(', ')}${f.sockets.length ? `; sockets ${f.sockets.join(', ')}` : ''}): bring one in to fit against, and tell me if a socket there has to move.`,
    );
  }
  if (!to.fields) {
    const budget = [b.tris ? `at most ${b.tris.toLocaleString('en-US')} triangles ${members.length > 1 ? 'per model' : 'in all'}` : '', b.grounded ? `${members.length > 1 ? 'each stands' : 'it stands'} on the ground (lowest point on the floor)` : ''].filter(Boolean);
    if (budget.length) out.push(`${budget.join('; ').replace(/^./, (c) => c.toUpperCase())}.`);
  }
  return out.join('\n\n');
}

/** The requirements Kiln 0.8.2 checks itself, or null when the brief has none. A size is turned from [width, height, depth] to Kiln's scene axes [x, y, z up]. */
export function briefSpec(b: KilnBriefSpec, partsCheck = false): KilnSpec | null {
  const single = (b.members?.length ?? 0) <= 1;
  const spec: KilnSpec = {
    ...(b.tris ? { tris: b.tris } : {}),
    ...(b.size && single ? { size: [b.size[0], b.size[2], b.size[1]] as [number, number, number] } : {}),
    ...(b.grounded ? { ground: true as const } : {}),
    ...(b.sockets?.length ? { sockets: b.sockets.map((s) => s.name) } : {}),
    ...(partsCheck && b.parts?.length ? { parts: [...b.parts] } : {}),
  };
  return Object.keys(spec).length ? spec : null;
}

/**
 * What goes to Kiln's chat for a brief. Up to 0.8.1: the text. From 0.8.2: the text, `spec` and `style`
 * as data, and `mode: "queue"` (a brief is a turn of its own; when the project's copilot is busy with
 * the user's own turn it starts after it, where an older Kiln answers 409).
 */
export function briefBody(b: KilnBriefSpec, to: boolean | BriefFields): { text: string; mode?: 'queue'; spec?: KilnSpec; style?: string } {
  const how: BriefFields = typeof to === 'boolean' ? { fields: to } : to;
  if (!how.fields) return { text: renderBrief(b) };
  const spec = briefSpec(b, how.parts === true);
  return { text: renderBrief(b, how), mode: 'queue', ...(spec ? { spec } : {}), ...(how.styleId ? { style: how.styleId } : {}) };
}
