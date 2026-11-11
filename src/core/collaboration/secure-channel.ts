import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().uuid();
const greeting = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('join'), identity: identifier, name: z.string().max(48), challenge: hex, mac: hex }).strict(),
  z.object({ kind: z.literal('accept'), identity: identifier, name: z.string().max(48), challenge: hex, hostChallenge: hex, mac: hex }).strict(),
]);
export type PairGreeting = z.infer<typeof greeting>;
export const pairSecret = () => randomBytes(32).toString('hex');

export function makeGreeting(key: string, room: string, identity: string, challenge: string, hostChallenge?: string, name = ''): PairGreeting {
  const packet = hostChallenge ? { kind: 'accept' as const, identity, name, challenge, hostChallenge } : { kind: 'join' as const, identity, name, challenge };
  return { ...packet, mac: createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(['shuriken-coop/2', room, packet])).digest('hex') };
}

export function verifyGreeting(key: string, room: string, input: unknown): PairGreeting | null {
  const parsed = greeting.safeParse(input);
  if (!parsed.success) return null;
  const packet = parsed.data;
  const expected = makeGreeting(key, room, packet.identity, packet.challenge, packet.kind === 'accept' ? packet.hostChallenge : undefined, packet.name);
  return timingSafeEqual(Buffer.from(expected.mac, 'hex'), Buffer.from(packet.mac, 'hex')) ? packet : null;
}

/** Each handshake has fresh directional keys and a strict sequence. The relay has neither key. */
export class SecureChannel {
  private sendSequence = 0;
  private receiveSequence = 0;
  private readonly sendKey: Buffer;
  private readonly receiveKey: Buffer;

  constructor(key: string, room: string, join: string, accept: string, role: 'host' | 'guest') {
    const salt = Buffer.from(join + accept, 'hex');
    const derive = (direction: string) => Buffer.from(hkdfSync('sha256', Buffer.from(key, 'hex'), salt, `shuriken-coop/2/${room}/${direction}`, 32));
    this.sendKey = derive(role);
    this.receiveKey = derive(role === 'host' ? 'guest' : 'host');
  }

  private nonce(sequence: number): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(sequence), 4);
    return nonce;
  }

  seal(data: unknown): string {
    if (this.sendSequence >= Number.MAX_SAFE_INTEGER) throw new Error('Pairing must be renewed');
    const sequence = this.sendSequence + 1;
    const plain = Buffer.from(JSON.stringify(data));
    if (plain.length > 44_000) throw new Error('Collaboration message is too large');
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, this.nonce(sequence));
    const bytes = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    this.sendSequence = sequence;
    return `${sequence}.${bytes.toString('base64url')}`;
  }

  open(packet: string): unknown {
    const match = /^(\d{1,16})\.([A-Za-z0-9_-]{23,58700})$/.exec(packet);
    if (!match || Number(match[1]) !== this.receiveSequence + 1) throw new Error('Invalid collaboration sequence');
    const sequence = Number(match[1]);
    const bytes = Buffer.from(match[2]!, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', this.receiveKey, this.nonce(sequence));
    cipher.setAuthTag(bytes.subarray(-16));
    const data = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString('utf8'));
    this.receiveSequence = sequence;
    return data;
  }
}
