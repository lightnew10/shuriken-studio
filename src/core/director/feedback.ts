import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '@shared/domain';
import type { EventBus } from '../events';
import type { ProjectContext } from '../projects/project-service';
import { ChatService } from './chat-service';

/**
 * "/feedback <note>" in any chat box (the director's or a dock copilot's): a note for Shuriken Studio's
 * developers. It goes straight to the developers' log (feedback.md in the app's data folder) and, as the
 * user's message, into the session journal the developers watch — no agent runs and nobody answers it
 * in the chat but one status line.
 */
export const FEEDBACK_COMMAND = /^\s*\/feedback\b[:\s]*([\s\S]*)$/i;

/** Appends a note for the developers. */
export function saveFeedback(dataDir: string, project: string, note: string): void {
  appendFileSync(join(dataDir, 'feedback.md'), `## ${new Date().toLocaleString()} · ${project}\n\n${note}\n\n`);
}

/** Handles a /feedback message in `channel`: saved and acknowledged, never passed to an agent. */
export function sendFeedback(p: ProjectContext, bus: EventBus, dataDir: string, channel: string, note: string): ChatMessage {
  const chat = new ChatService(p, bus, channel);
  const text = note.trim();
  const msg = chat.add({ role: 'user', kind: 'text', text: `/feedback ${text}`.trim(), data: { feedback: true } });
  if (!text) {
    chat.add({ role: 'system', kind: 'status', text: 'Write your note after /feedback, for example: /feedback the viewer camera feels slow.' });
    return msg;
  }
  saveFeedback(dataDir, p.summary.name, text);
  chat.add({ role: 'system', kind: 'status', text: 'Sent to the creator. No agent was involved.' });
  return msg;
}
