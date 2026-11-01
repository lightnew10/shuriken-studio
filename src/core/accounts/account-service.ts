import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newId, nowIso } from '@shared/ids';
import { clockText } from '@shared/usage';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';
import type { UsageTracker } from '../orchestrator/usage-tracker';

/**
 * One signed-in subscription of an AI provider (e.g. two Claude Max plans). Each account has its own
 * private credentials directory; the provider adapter decides how to use it (Claude: CLAUDE_CONFIG_DIR).
 */
export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  dir: string;
  email: string | null;
  plan: string | null;
  signedIn: boolean;
  checkedAt: string | null;
  createdAt: string;
}

export interface AccountPolicy {
  /** Move to another signed-in account when the active one hits a usage limit. */
  autoSwitch: boolean;
  /** When every account is limited, resume automatically once a limit resets (otherwise stay paused). */
  autoResume: boolean;
  /** Count the Claude login already on this PC (Claude Code's own) as one more account. */
  usePcLogin: boolean;
}

/** The Claude login already on this PC (no private credentials folder): a built-in account. */
export const PC_ACCOUNT_ID = 'pc';
const PC_LABEL = "This PC's Claude login";

export interface AccountPick {
  ok: boolean;
  account: ProviderAccount | null;
  /** Key under which usage and limits are tracked for runs on this account. */
  usageKey: string;
  reason?: string;
  switchedFrom?: ProviderAccount;
  /** When nothing is available: the earliest time a limit resets (ms since epoch). */
  resumeAt?: number | null;
}

const KEY = 'accounts';
const ACTIVE = 'accounts.active';
const POLICY = 'accounts.policy';
const PC_META = 'accounts.pc';

export class AccountService {
  constructor(
    private readonly global: Store,
    private readonly dataDir: string,
    private readonly bus: EventBus,
  ) {}

  list(providerId?: string): ProviderAccount[] {
    const all = pj<ProviderAccount[]>(this.read(KEY), []);
    return providerId ? all.filter((a) => a.providerId === providerId) : all;
  }

  get(id: string): ProviderAccount | null {
    if (id === PC_ACCOUNT_ID) return this.pc('claude');
    return this.list().find((a) => a.id === id) ?? null;
  }

  /** The PC's own Claude login as an account (dir '' = no override: the provider's default credentials). */
  pc(providerId: string): ProviderAccount {
    const meta = pj<Partial<ProviderAccount>>(this.read(PC_META), {});
    return { id: PC_ACCOUNT_ID, providerId, label: PC_LABEL, dir: '', email: meta.email ?? null, plan: meta.plan ?? null, signedIn: meta.signedIn ?? true, checkedAt: meta.checkedAt ?? null, createdAt: '' };
  }

  /**
   * Accounts runs may use: the signed-in added accounts, plus the PC's own login when enabled and it is
   * not the same subscription as one of them (same email).
   */
  candidates(providerId: string): ProviderAccount[] {
    const added = this.list(providerId).filter((a) => a.signedIn);
    const pc = this.pc(providerId);
    const duplicate = !!pc.email && added.some((a) => a.email && a.email.toLowerCase() === pc.email!.toLowerCase());
    return this.policy().usePcLogin && pc.signedIn && !duplicate ? [...added, pc] : added;
  }

  add(providerId: string, label: string): ProviderAccount {
    const id = newId('acct');
    const dir = join(this.dataDir, 'accounts', id);
    mkdirSync(dir, { recursive: true });
    const acct: ProviderAccount = { id, providerId, label: label.trim() || 'Account', dir, email: null, plan: null, signedIn: false, checkedAt: null, createdAt: nowIso() };
    this.save([...this.list(), acct]);
    if (!this.activeId(providerId)) this.setActive(providerId, id);
    return acct;
  }

  update(id: string, patch: Partial<Pick<ProviderAccount, 'label' | 'email' | 'plan' | 'signedIn' | 'checkedAt'>>): ProviderAccount | null {
    if (id === PC_ACCOUNT_ID) {
      const { label: _label, ...rest } = patch;
      this.write(PC_META, j({ ...pj<Record<string, unknown>>(this.read(PC_META), {}), ...rest }));
      this.bus.emit('accounts.changed', { providerId: 'claude', activeId: this.activeId('claude') });
      return this.pc('claude');
    }
    const all = this.list();
    const i = all.findIndex((a) => a.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i]!, ...patch };
    this.save(all);
    return all[i]!;
  }

  remove(id: string): void {
    const acct = this.get(id);
    this.save(this.list().filter((a) => a.id !== id));
    if (acct && this.activeId(acct.providerId) === id) {
      const next = this.list(acct.providerId).find((a) => a.signedIn) ?? this.list(acct.providerId)[0];
      this.setActive(acct.providerId, next?.id ?? null);
    }
  }

  /**
   * This window's own choice of account (the top bar's account menu), apart from the app-wide default that Settings
   * sets: read and written through the core, which keeps it in its open project's settings. Null: no window scope
   * (tests, a bare service), and the default is all there is.
   */
  private scope: { get: (providerId: string) => string | null; set: (providerId: string, id: string | null) => void } | null = null;
  /** While this window's account is at its limit: the account it moved to (this window only, never written anywhere). */
  private readonly failover = new Map<string, string>();

  setScope(scope: { get: (providerId: string) => string | null; set: (providerId: string, id: string | null) => void }): void {
    this.scope = scope;
  }

  /** This window's own choice (null: it follows the app-wide default). */
  windowId(providerId: string): string | null {
    return this.scope?.get(providerId) ?? null;
  }

  /** The window's menu: this account for new work in this window only (null: back to the app-wide default). */
  chooseForWindow(providerId: string, id: string | null): void {
    this.scope?.set(providerId, id);
    this.failover.delete(providerId);
    this.bus.emit('accounts.changed', { providerId, activeId: this.active(providerId)?.id ?? null });
  }

  /** The app-wide default (Settings): every window that hasn't chosen its own uses it. */
  setActive(providerId: string, id: string | null): void {
    // A choice made by hand ends an automatic switch.
    this.failover.delete(providerId);
    const map = pj<Record<string, string | null>>(this.read(ACTIVE), {});
    map[providerId] = id;
    this.write(ACTIVE, j(map));
    this.bus.emit('accounts.changed', { providerId, activeId: id });
  }

  activeId(providerId: string): string | null {
    return pj<Record<string, string | null>>(this.read(ACTIVE), {})[providerId] ?? null;
  }

  /**
   * The account runs should use now: the chosen one if usable, else the first usable one. null means no
   * added accounts at all (runs use the default login, tracked under the plain provider key).
   */
  active(providerId: string): ProviderAccount | null {
    const accounts = this.candidates(providerId);
    if (!accounts.some((a) => a.id !== PC_ACCOUNT_ID)) return null;
    const moved = this.failover.get(providerId);
    return (moved ? accounts.find((a) => a.id === moved) : undefined) ?? this.preferred(providerId, accounts)!;
  }

  /** The account this window wants: its own choice, else the app-wide default, else the first added one. */
  private preferred(providerId: string, accounts = this.candidates(providerId)): ProviderAccount | null {
    const added = accounts.filter((a) => a.id !== PC_ACCOUNT_ID);
    if (added.length === 0) return null;
    const own = this.windowId(providerId);
    return (own ? accounts.find((a) => a.id === own) : undefined) ?? accounts.find((a) => a.id === this.activeId(providerId)) ?? added[0]!;
  }

  policy(): AccountPolicy {
    return { autoSwitch: true, autoResume: true, usePcLogin: true, ...pj<Partial<AccountPolicy>>(this.read(POLICY), {}) };
  }

  setPolicy(patch: Partial<AccountPolicy>): AccountPolicy {
    const next = { ...this.policy(), ...patch };
    this.write(POLICY, j(next));
    this.bus.emit('accounts.changed', { providerId: null, activeId: null });
    return next;
  }

  usageKey(providerId: string, account: ProviderAccount | null): string {
    // The PC login is the provider's default credentials: same usage bucket as runs without accounts.
    return account && account.id !== PC_ACCOUNT_ID ? `${providerId}:${account.id}` : providerId;
  }

  /** Whether a run could start now on some account (a look: nothing is switched). */
  anyCanStart(providerId: string, usage: UsageTracker): boolean {
    const signedIn = this.candidates(providerId);
    if (!signedIn.some((a) => a.id !== PC_ACCOUNT_ID)) return usage.canStartRun(providerId).ok;
    const active = this.active(providerId)!;
    if (usage.canStartRun(this.usageKey(providerId, active)).ok) return true;
    return this.policy().autoSwitch && signedIn.some((a) => usage.canStartRun(this.usageKey(providerId, a)).ok);
  }

  /**
   * Decide which account the next run uses. When the active account is at its limit, switch to another
   * signed-in account that is not (policy.autoSwitch); when all are limited, report when the earliest
   * limit resets so the scheduler can resume by itself (policy.autoResume).
   */
  pick(providerId: string, usage: UsageTracker): AccountPick {
    const signedIn = this.candidates(providerId);
    if (!signedIn.some((a) => a.id !== PC_ACCOUNT_ID)) {
      const gate = usage.canStartRun(providerId);
      // With auto-resume off nothing resumes at that time: it is when the limit resets.
      const reason = gate.reason && !this.policy().autoResume ? gate.reason.replace('work resumes at', 'it resets at').replace('work resumes when it resets', 'it has not reset yet') : gate.reason;
      return { ok: gate.ok, account: null, usageKey: providerId, reason, resumeAt: usage.snapshot(providerId).blockedUntil };
    }
    // The account this window wants; back to it as soon as it can start again after a switch.
    const wanted = this.preferred(providerId, signedIn)!;
    const wantedKey = this.usageKey(providerId, wanted);
    if (usage.canStartRun(wantedKey).ok) {
      if (this.failover.delete(providerId)) this.bus.emit('accounts.changed', { providerId, activeId: wanted.id });
      return { ok: true, account: wanted, usageKey: wantedKey };
    }
    const active = this.active(providerId)!;
    const activeKey = this.usageKey(providerId, active);
    const policy = this.policy();
    if (active.id !== wanted.id && policy.autoSwitch && usage.canStartRun(activeKey).ok) return { ok: true, account: active, usageKey: activeKey };
    if (policy.autoSwitch) {
      const other = signedIn.find((a) => a.id !== active.id && a.id !== wanted.id && usage.canStartRun(this.usageKey(providerId, a)).ok);
      if (other) {
        // This window moves on alone: the app-wide default and the other windows' choices stay as they are.
        this.failover.set(providerId, other.id);
        this.bus.emit('accounts.changed', { providerId, activeId: other.id });
        return { ok: true, account: other, usageKey: this.usageKey(providerId, other), switchedFrom: active };
      }
    }
    const resets = signedIn.map((a) => usage.snapshot(this.usageKey(providerId, a)).blockedUntil).filter((t): t is number => typeof t === 'number');
    const resumeAt = resets.length ? Math.min(...resets) : null;
    const when = resumeAt ? clockText(resumeAt, Date.now()) : 'soon';
    const what = signedIn.length > 1 ? 'Every account is at its usage limit' : `${active.label} is at its usage limit`;
    return {
      ok: false,
      account: active,
      usageKey: activeKey,
      resumeAt,
      // "Resuming at" only when it will: with auto-resume off the team stays paused until the user resumes it. Two
      // builds stood paused for hours behind "Paused: … resuming at 5:00 AM", which their owner (away) took at its word.
      reason: policy.autoResume ? `${what}; resuming at ${when}` : `${what}; it resets at ${when}`,
    };
  }

  private save(all: ProviderAccount[]): void {
    this.write(KEY, j(all));
    this.bus.emit('accounts.changed', { providerId: null, activeId: null });
  }

  private read(key: string): string | null {
    return this.global.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.global.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, value, nowIso()]);
  }
}
