import { plainOption, plainText, shortTitle } from '@shared/plain-words';
import type { ProjectContext } from '../projects/project-service';
import type { AgentRunner } from '../orchestrator/agent-runner';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { ROLES } from '../agents/roles';

/** A question card as the game's owner reads it; the escalation itself keeps the technical text for the agents. */
export interface PlainCard {
  title: string;
  /** The one or two sentences under the title (empty: the title says it all). */
  text: string;
  /** One label per option, in the options' order (the option itself is still what an answer sends). */
  labels: string[];
}

/** What the narrator asks of the fast model (a test passes its own). */
export interface PlainWordsLike {
  card(p: ProjectContext, e: { title: string; detail: string; options: string[] }): Promise<PlainCard | null>;
  line(p: ProjectContext, text: string): Promise<string | null>;
  title(p: ProjectContext, request: string): Promise<string | null>;
}

/**
 * The fast model's half of plain words (the rule-based half is @shared/plain-words, which runs first and stands when
 * this can't: no model allowed here, no answer within a minute, or an answer that breaks the rules). One small call,
 * about a cent, per question card, per status line that needed one, and per goal named from the user's words. Its
 * answers go through the rules again: whatever it says, no id, path or tool name reaches the chat.
 */
export class PlainWords implements PlainWordsLike {
  constructor(
    private readonly d: {
      runner: AgentRunner;
      log: ScopedLogger;
      /** Off where no model may be called (tests, smoke runs, safe mode). */
      enabled: () => boolean;
      timeoutMs?: number;
    },
  ) {}

  async card(p: ProjectContext, e: { title: string; detail: string; options: string[] }): Promise<PlainCard | null> {
    const out = await this.ask(
      p,
      [
        'Rewrite this question card for the owner of the game. It is shown in their chat with a button per option.',
        '',
        `Title: ${e.title}`,
        `Detail (the agent's own words, for the team):\n${e.detail.slice(0, 3000)}`,
        e.options.length ? `Options, in order:\n${e.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : 'Options: none (it is answered in the chat).',
      ].join('\n'),
      'A question card in plain words',
    );
    if (!out?.title) return null;
    const title = shortTitle(out.title, 14) || plainText(e.title);
    const text = plainText(String(out.text ?? '').trim()).slice(0, 600);
    const given = Array.isArray(out.options) ? out.options.map((o) => plainText(String(o ?? '').trim())).filter(Boolean) : [];
    // A label per option, or none of the model's: a button that says something else than what it sends is worse than a plain one.
    const labels = given.length === e.options.length && given.every((l) => l.length <= 80) ? given.map((l) => l[0]!.toUpperCase() + l.slice(1)) : e.options.map(plainOption);
    return { title, text, labels };
  }

  async line(p: ProjectContext, text: string): Promise<string | null> {
    const out = await this.ask(p, `Rewrite this status line of the team's chat for the owner of the game: one or two short sentences, nothing left out that they need, nothing added.\n\n${text.slice(0, 2000)}`, 'A status line in plain words');
    const line = plainText(String(out?.text || out?.title || '').trim());
    return line ? line.slice(0, 400) : null;
  }

  async title(p: ProjectContext, request: string): Promise<string | null> {
    const out = await this.ask(p, `Name this change the owner of the game asked for, as a goal in their task list: at most six words, what it changes ("Fix the group rewards sign", "Phone bow aiming", "Daily reward streaks"), never their filler words.\n\nWhat they wrote:\n${request.slice(0, 2000)}`, 'A goal title in plain words');
    const t = shortTitle(String(out?.title ?? ''), 6);
    return t && !/^(?:ugh|also|not bad|ok|okay|so|hey|can you|please|lets|let's)\b/i.test(t) ? t : null;
  }

  private async ask(p: ProjectContext, prompt: string, label: string): Promise<{ title?: string; text?: string; options?: unknown[] } | null> {
    if (!this.d.enabled()) return null;
    try {
      // Booked in the project: its cost is part of the build's (costs/build-cost.ts).
      const r = await this.d.runner.quick({ role: ROLES['plain-words']!, prompt, cwd: p.root, signal: AbortSignal.timeout(this.d.timeoutMs ?? 60_000), project: p, label });
      const out = r?.structured as { title?: unknown; text?: unknown; options?: unknown } | null;
      if (!out || typeof out !== 'object') return null;
      return {
        title: typeof out.title === 'string' ? out.title : undefined,
        text: typeof out.text === 'string' ? out.text : undefined,
        options: Array.isArray(out.options) ? out.options : undefined,
      };
    } catch (e) {
      this.d.log.warn('Rewriting a line in plain words failed', errorMessage(e));
      return null;
    }
  }
}
