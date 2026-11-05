import { describe, expect, it } from 'vitest';
import {
  COLLAB_RECONNECT_MS, COLLAB_MAX_CHAT_HISTORY, collabInvitation, parseCollabInvitation,
  parseCollabPayload, truncateCollabHistory, validChatText, validCollabName, validRelayUrl,
} from '../src/shared/collaboration';

describe('Shuriken collaboration protocol', () => {
  const room = '1'.repeat(32);
  const secret = 'a'.repeat(64);

  it('requires HTTPS relay and excludes embedded credentials, paths and cloud token leakage', () => {
    expect(validRelayUrl('https://example.workers.dev/')).toBe('https://example.workers.dev');
    expect(validRelayUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    for (const url of ['http://example.com', 'https://alice:password@example.com', 'https://example.com/?apiKey=s', 'https://example.com/another']) {
      expect(() => validRelayUrl(url)).toThrow();
    }
  });

  it('round-trips session links without sending invitation keys to the Worker request URL', () => {
    const invitation = collabInvitation('https://example.workers.dev', room, secret);
    expect(invitation).toBe('https://example.workers.dev/room/' + room + '#join=' + secret);
    expect(parseCollabInvitation(invitation)).toEqual({ relay: 'https://example.workers.dev', room, inviteSecret: secret });
    expect(new URL(invitation).pathname).toBe('/room/' + room);
    expect(new URL(invitation).search).toBe('');
    expect(() => parseCollabInvitation(invitation.replace('#join=', '?join='))).toThrow();
    expect(() => parseCollabInvitation('http://evil.com/room/' + room + '#join=' + secret)).toThrow();
  });

  it('restricts arbitrary guest requests, refusing forged history, project and provider commands', () => {
    const message = { id: 'collab-msg-001', sender: 'Alice', from: 'member-1', text: 'Hello', at: new Date().toISOString() };
    expect(parseCollabPayload({ kind: 'chat', message }, false)).toEqual({ kind: 'chat', message });
    expect(parseCollabPayload({ kind: 'sync-request' }, false)).toEqual({ kind: 'sync-request' });
    expect(parseCollabPayload({ kind: 'history', messages: [message] }, false)).toBeNull();
    expect(parseCollabPayload({ kind: 'history', messages: [message] }, true)).toEqual({ kind: 'history', messages: [message] });
    expect(parseCollabPayload({ kind: 'project-status', name: 'Impulse Simulator', projectId: 'p1', taskCount: 42 }, false)).toBeNull();
    expect(parseCollabPayload({ kind: 'run-model', provider: 'codex', accountToken: 'secret' }, true)).toBeNull();
    expect(parseCollabPayload({ kind: 'chat', message: { ...message, text: 'x'.repeat(3000) } }, false)).toBeNull();
  });

  it('bounds the local history, name and chat payload while fixing ten minutes recovery', () => {
    expect(COLLAB_RECONNECT_MS).toBe(600_000);
    expect(truncateCollabHistory(Array.from({ length: 500 }, (_, i) => ({
      id: String(i), sender: 'Alice', from: 'a', text: 'Hello', at: new Date().toISOString(),
    })))).toHaveLength(COLLAB_MAX_CHAT_HISTORY);
    expect(() => validChatText('x'.repeat(2001))).toThrow();
    expect(() => validChatText('')).toThrow();
    expect(validChatText(' hello ')).toBe('hello');
    expect(() => validCollabName(''.padEnd(49, 'A'))).toThrow();
  });
});
