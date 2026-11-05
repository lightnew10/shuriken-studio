import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { CheckCircle2, CircleAlert, FolderOpen, KeyRound, LogIn, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { limitingUsage } from '@shared/usage';
import type { PermissionMode } from '@shared/domain';
import { OPEN_CLOUD_KEY, robloxId, type OpenCloudKeySource } from '@shared/roblox-keys';
import { modeHint, type RobloxMode } from '../components/roblox-choice';
import { TopBar } from '../components/topbar';
import { Button, ErrorNote, Field, Modal, Pill, Toggle, cx, inputClass, timeAgo } from '../components/ui';
import { rpc, useAction, useCoreEvent, useRpc } from '../lib/rpc';
import { studioLinkLine, type StudioLinkInfo } from '../lib/studio-link';
import { useCurrentProject } from '../lib/project';
import { calmDashboardNow, setCalmDashboard, themeColor, useCalmDashboard } from '../lib/appearance';
import { ThemeSwitch } from '../components/theme-switch';
import { StepSlider } from '../components/step-slider';
import { ALWAYS_ASKS, PERMISSION_MODES, PROJECT_MODE_CHOICES, appMode, projectChoice, projectModeNote, projectSetting } from '../lib/permission-modes';

interface Account {
  id: string;
  label: string;
  email: string | null;
  plan: string | null;
  signedIn: boolean;
  checkedAt: string | null;
  /** The PC's own Claude login (built in; can't be removed). */
  builtin?: boolean;
  /** Counted as an account (the PC login is not when it is the same subscription as an added one). */
  eligible?: boolean;
  usage: { windows: Record<string, { status: string; utilization: number | null; resetsAt: number | null }>; blocked: boolean; blockedUntil: number | null; runsToday: number };
}
interface ProvidersInfo {
  default: string;
  roles: Record<string, string>;
  providers: Array<{ id: string; name: string }>;
  roleOptions?: Array<{ id: string; name: string }>;
}

interface CodexStatus {
  installed: boolean;
  version: string | null;
  detail: string;
  signedIn: boolean;
  authDetail: string | null;
}

interface AccountsInfo {
  accounts: Account[];
  activeId: string | null;
  /** The app-wide default: windows that haven't chosen their own account in the top bar use it. */
  defaultId?: string | null;
  policy: { autoSwitch: boolean; autoResume: boolean; usePcLogin: boolean };
}

const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'accounts', label: 'Claude accounts' },
  { id: 'providers', label: 'AI providers' },
  { id: 'agents', label: 'Agents' },
  { id: 'storefront', label: 'Storefront' },
  { id: 'roblox', label: 'Roblox & Studio' },
  { id: 'models', label: '3D models & Kiln' },
  { id: 'app', label: 'App' },
] as const;

/** Links from before the sections were split (Blender and Kiln were under Agents). */
const sectionOf = (id: string | undefined): string => (id === 'blender' || id === 'kiln' ? 'models' : SECTIONS.some((s) => s.id === id) ? id! : 'appearance');

export function SettingsPage({ section }: { section?: string }) {
  const [active, setActive] = useState<string>(() => sectionOf(section));
  useEffect(() => {
    if (section) setActive(sectionOf(section));
  }, [section]);
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Settings" back />
      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 border-r border-line p-3">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={cx('mb-0.5 w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors', active === s.id ? 'bg-accent/12 text-accent2' : 'text-dim hover:bg-white/4 hover:text-text')}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-8">
            {active === 'appearance' && <AppearanceSection />}
            {active === 'accounts' && <AccountsSection />}
            {active === 'providers' && <ProvidersSection />}
            {active === 'agents' && <AgentsSection />}
            {active === 'storefront' && <StorefrontSection />}
            {active === 'roblox' && <RobloxSection />}
            {active === 'models' && <ModelsSection />}
            {active === 'app' && <AppSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-[17px] font-semibold text-text">{title}</h2>
      <p className={cx('max-w-2xl text-[13px] leading-relaxed text-dim', hint ? 'mt-1 mb-4' : 'mb-3')}>{hint}</p>
      {children}
    </section>
  );
}

/** One setting chosen from a few values, as a row of pills, with what the choice means under it. */
/** The settings that are a scale (StepSlider stops). */
const AGENT_CAP_STOPS: ReadonlyArray<readonly [number, string]> = Array.from({ length: 32 }, (_, i) => [i + 1, String(i + 1)] as const);
const STUDIO_AGENT_STOPS: ReadonlyArray<readonly [number, string]> = Array.from({ length: 16 }, (_, i) => [i + 1, String(i + 1)] as const);
const KILN_BUILD_STOPS: ReadonlyArray<readonly [number, string]> = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32].map((v) => [v, String(v)] as const);
const EFFORT_STOPS: ReadonlyArray<readonly ['medium' | 'high' | 'xhigh' | 'max', string]> = [
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
];

function AppearanceSection() {
  const calm = useCalmDashboard();
  return (
    <>
      <Section title="Theme" hint="The app's colour, in every window. The start page has the same switch at its top right.">
        <ThemeSwitch labels />
      </Section>
      <Section title="Motion">
        <div className="card px-4">
          <Toggle
            checked={calm}
            onChange={(v) => setCalmDashboard(v)}
            label="Calm dashboard"
            hint="The dashboard's previews hold still: the effect, the animation and the newest model show one still frame instead of playing and turning. They still play on their own pages and when a container is opened. The dashboard's top bar has the same switch."
          />
        </div>
      </Section>
    </>
  );
}

function AccountsSection() {
  const info = useRpc<AccountsInfo>('accounts.list', undefined, ['accounts.changed', 'usage.observed', 'usage.changed']);
  const [label, setLabel] = useState('');
  const [signing, setSigning] = useState<Account | null>(null);
  const add = useAction(async () => {
    const a = await rpc<Account>('accounts.add', { label: label.trim() || `Claude account ${(info.data?.accounts.length ?? 0) + 1}` });
    setLabel('');
    info.reload();
    setSigning(a);
  });
  const refresh = useAction((id: string) => rpc('accounts.refresh', { id }).then(() => info.reload()));
  const policy = info.data?.policy;
  return (
    <>
      <Section
        title="Claude accounts"
        hint="The Claude login already on this PC counts as one account. Add each other subscription you want agents to use and sign in once. Shuriken Studio draws from the one in use, switches to another when it reaches a limit, and resumes by itself when limits reset."
      >
        <div className="space-y-2.5">
          {(info.data?.accounts ?? []).map((a) => {
            // Settings sets the app-wide default; a window's own choice (its top-bar menu) is that window's alone.
            const isActive = (info.data?.defaultId ?? info.data?.activeId) === a.id;
            // Only windows that haven't reset: a limit that is over no longer counts as used.
            const lim = limitingUsage(a.usage.windows, Date.now());
            const twin = a.builtin && a.eligible === false && a.signedIn ? info.data?.accounts.find((o) => !o.builtin && o.email && o.email.toLowerCase() === a.email?.toLowerCase()) : undefined;
            return (
              <div key={a.id} className={cx('card flex items-center gap-4 px-4 py-3.5', isActive && 'ring-1 ring-accent/50', a.eligible === false && 'opacity-70')}>
                <div className={cx('flex h-9 w-9 items-center justify-center rounded-xl', a.signedIn ? 'bg-accent/15 text-accent2' : 'bg-white/5 text-faint')}>
                  <UserRound size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-text">
                    {a.label}
                    {isActive && <Pill tone="accent">Default</Pill>}
                    {a.usage.blocked && <Pill tone="bad">At limit{a.usage.blockedUntil ? ` · back ${new Date(a.usage.blockedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</Pill>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-faint">
                    {a.signedIn ? `${a.email ?? (a.builtin ? "Claude Code's own sign-in" : 'Signed in')}${a.plan ? ` · ${a.plan}` : ''}` : 'Not signed in'}
                    {a.signedIn && lim && lim.percent > 0 ? ` · ${lim.percent}% of its ${lim.name} used` : ''}
                    {a.checkedAt ? ` · checked ${timeAgo(a.checkedAt)}` : ''}
                  </div>
                  {twin && <div className="mt-0.5 text-[12px] text-faint">Same subscription as {twin.label}, so it isn't counted twice.</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {a.signedIn && !isActive && a.eligible !== false && (
                    <Button size="sm" title="Every window uses this account unless it picked its own in the top bar" onClick={() => void rpc('accounts.setDefault', { id: a.id }).then(() => info.reload())}>
                      Make default
                    </Button>
                  )}
                  <Button size="sm" kind={a.signedIn ? 'ghost' : 'primary'} icon={<LogIn size={13} />} onClick={() => setSigning(a)}>
                    {a.signedIn ? 'Sign in again' : 'Sign in'}
                  </Button>
                  <Button size="sm" kind="ghost" icon={<RefreshCw size={13} />} title="Check sign-in" onClick={() => void refresh.run(a.id)} disabled={refresh.busy} />
                  {!a.builtin && <Button size="sm" kind="ghost" icon={<Trash2 size={13} />} title="Remove" onClick={() => void rpc('accounts.remove', { id: a.id }).then(() => info.reload())} />}
                </div>
              </div>
            );
          })}
          {info.data && info.data.accounts.every((a) => a.builtin) && (
            <div className="px-1 pt-1 text-[12.5px] text-faint">Add your other Claude subscriptions below to switch between them, or to keep working when one reaches its limit.</div>
          )}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <input id="acct-label" className={cx(inputClass, 'max-w-xs')} placeholder='Name, e.g. "Max 5x"' value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button kind="primary" icon={<Plus size={14} />} onClick={() => void add.run()} disabled={add.busy}>
            Add account
          </Button>
        </div>
        <ErrorNote error={add.error ?? refresh.error} />
      </Section>
      <Section title="When a limit is reached">
        <div className="card divide-y divide-line px-4">
          <Toggle
            checked={policy?.autoSwitch ?? true}
            onChange={(v) => void rpc('accounts.setPolicy', { autoSwitch: v }).then(() => info.reload())}
            label="Switch to another account"
            hint="If the active account hits its 5-hour or weekly limit, continue on another signed-in account that has room."
          />
          <Toggle
            checked={policy?.usePcLogin ?? true}
            onChange={(v) => void rpc('accounts.setPolicy', { usePcLogin: v }).then(() => info.reload())}
            label="Count this PC's Claude login as an account"
            hint="Claude Code's own sign-in on this PC joins the rotation (skipped automatically when it is the same subscription as one you added)."
          />
          <Toggle
            checked={policy?.autoResume ?? true}
            onChange={(v) => void rpc('accounts.setPolicy', { autoResume: v }).then(() => info.reload())}
            label="Resume automatically when a limit resets"
            hint="Work waits and picks up again on its own at the reset time. Turn off to stay paused until you resume."
          />
        </div>
      </Section>
      {signing && <SignInModal account={signing} onClose={() => { setSigning(null); void rpc('accounts.refresh', { id: signing.id }).then(() => info.reload()); }} />}
    </>
  );
}


/**
 * Provider selection is intentionally manual in V1. Shuriken's orchestration already routes
 * roles through ProviderRegistry; changing a choice affects only future runs.
 */
function ProvidersSection() {
  const info = useRpc<ProvidersInfo>('providers.assignments');
  const codex = useRpc<CodexStatus>('providers.codex.status');
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const select = async (defaultId: string, roles: Record<string, string>) => {
    setSaving(true);
    setError(null);
    try {
      await rpc('providers.setAssignments', { default: defaultId, roles });
      info.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const ready = codex.data?.installed && codex.data?.signedIn;
  const roles = info.data?.roleOptions ?? [];
  const selected = info.data?.default ?? 'claude';
  return (
    <>
      <Section title="Codex (ChatGPT)" hint="Optional Codex CLI login. Your ChatGPT subscription is used through the official Codex CLI, not through an OpenAI API key. Claude is unchanged.">
        <div className="card space-y-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[13px] font-medium text-text">
                {codex.data?.installed ? 'Codex CLI ' + (codex.data.version ?? '') : 'Codex CLI not detected'}
              </div>
              <div className="mt-1 text-[12px] text-dim">
                {codex.data?.signedIn ? 'Signed in to Codex.' : (codex.data?.authDetail ?? codex.data?.detail ?? 'Checking the local Codex installation…')}
              </div>
            </div>
            {ready && <Pill tone="ok">Ready</Pill>}
            <Button size="sm" kind="ghost" icon={<RefreshCw size={13} />} onClick={() => codex.reload()}>Refresh</Button>
            {codex.data?.installed && (
              <Button size="sm" icon={<LogIn size={13} />} onClick={() => setSigning(true)}>
                {codex.data.signedIn ? 'Sign in again' : 'Sign in with ChatGPT'}
              </Button>
            )}
          </div>
          {!codex.data?.installed && (
            <p className="text-[12px] text-faint">
              Install the official CLI with npm install -g @openai/codex, then restart Shuriken and sign in.
            </p>
          )}
        </div>
      </Section>
      <Section title="Agent provider" hint="Choose which subscription future agents use. Running tasks are not changed. Role overrides are optional.">
        <div className="card space-y-4 px-4 py-4">
          <Field label="Default agent provider">
            <select
              className={inputClass}
              value={selected}
              disabled={saving || !info.data}
              onChange={(e) => void select(e.target.value, info.data?.roles ?? {})}
            >
              {(info.data?.providers ?? []).map((p) => (
                <option key={p.id} value={p.id} disabled={p.id === 'codex' && !ready}>{p.name}</option>
              ))}
            </select>
          </Field>
          <details className="text-[13px] text-dim">
            <summary className="cursor-pointer select-none text-text">Agent-specific provider overrides</summary>
            <div className="mt-3 space-y-2">
              {roles.map((role) => (
                <div key={role.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">{role.name}</span>
                  <select
                    className={cx(inputClass, 'max-w-[220px]')}
                    value={info.data?.roles[role.id] ?? selected}
                    disabled={saving}
                    onChange={(e) => {
                      const next = { ...(info.data?.roles ?? {}) };
                      if (e.target.value === selected) delete next[role.id];
                      else next[role.id] = e.target.value;
                      void select(selected, next);
                    }}
                  >
                    {(info.data?.providers ?? []).map((p) => (
                      <option key={p.id} value={p.id} disabled={p.id === 'codex' && !ready}>{p.name}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </details>
          <p className="text-[12px] text-warn">
            Experimental: Codex CLI is read-only in Ask permission mode and workspace-write
            in Autonomous mode. Codex's own shell/file actions do not use Shuriken's per-tool
            approval dialog; Shuriken MCP tools still follow server-side permission checks.
            Test on a copy of your Roblox project first. Automatic Claude/Codex switching is
            not yet implemented.
          </p>
          <ErrorNote error={error} />
        </div>
      </Section>
      {signing && (
        <SignInModal
          provider="codex"
          account={{
            id: 'codex:pc', label: 'Codex (ChatGPT)', email: null, plan: null,
            signedIn: !!codex.data?.signedIn, checkedAt: null,
            usage: { windows: {}, blocked: false, blockedUntil: null, runsToday: 0 },
          }}
          onClose={() => { setSigning(false); codex.reload(); }}
        />
      )}
    </>
  );
}

/** Claude Code's own login, running in a real terminal, for one account profile. */
function SignInModal({ account, onClose, provider = 'claude' }: { account: Account; onClose: () => void; provider?: 'claude' | 'codex' }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const sessionId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Account | null>(null);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: "'Geist Mono Variable', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: themeColor('code', '#0b0a09'), foreground: themeColor('text', '#f4ede6'), cursor: themeColor('accent'), selectionBackground: `${themeColor('accent')}55` },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    fit.fit();
    term.current = t;
    const onData = t.onData((d) => sessionId.current && void rpc('terminal.write', { id: sessionId.current, data: d }));
    void rpc<{ id: string }>(provider === 'codex' ? 'providers.codex.signIn' : 'accounts.signIn', provider === 'codex' ? { cols: t.cols, rows: t.rows } : { id: account.id, cols: t.cols, rows: t.rows })
      .then((s) => {
        sessionId.current = s.id;
        t.focus();
      })
      .catch((e) => setError((e as Error).message));
    return () => {
      onData.dispose();
      if (sessionId.current) void rpc('terminal.kill', { id: sessionId.current }).catch(() => undefined);
      t.dispose();
    };
  }, [account.id, provider]);

  useCoreEvent(['terminal.data', 'terminal.exit'], (channel, payload) => {
    const p = payload as { id: string; data?: string };
    if (p.id !== sessionId.current) return;
    if (channel === 'terminal.data' && p.data) term.current?.write(p.data);
    if (channel === 'terminal.exit') setExited(true);
  });

  const check = async () => {
    setChecking(true);
    try {
      if (provider === 'codex') {
        const status = await rpc<CodexStatus>('providers.codex.status');
        setResult({ ...account, signedIn: status.signedIn });
      } else setResult(await rpc<Account>('accounts.refresh', { id: account.id }));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Sign in: ${account.label}`} width={860}>
      <p className="mb-3 text-[13px] leading-relaxed text-dim">
        {provider === 'codex'
          ? 'This is the official Codex CLI login. Choose your ChatGPT subscription in the browser that opens, then press Check sign-in. Credentials remain with Codex on this PC.'
          : <>This is Claude Code's own sign-in. Choose <b className="text-text">Claude account with subscription</b>, finish in the browser that opens, then press <b className="text-text">Check sign-in</b>. Credentials stay in this account's private folder on your PC.</>}
      </p>
      <div className="h-[380px] overflow-hidden rounded-xl bg-code ring-1 ring-line" ref={host} />
      <ErrorNote error={error} />
      <div className="mt-4 flex items-center gap-3">
        <Button kind="primary" icon={<CheckCircle2 size={14} />} onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : 'Check sign-in'}
        </Button>
        {result && (result.signedIn ? <span className="flex items-center gap-1.5 text-[13px] text-ok"><CheckCircle2 size={14} /> Signed in as {result.email ?? 'your account'}{result.plan ? ` (${result.plan})` : ''}</span> : <span className="flex items-center gap-1.5 text-[13px] text-warn"><CircleAlert size={14} /> Not signed in yet</span>)}
        {exited && <span className="text-[12px] text-faint">The sign-in terminal closed.</span>}
        <div className="flex-1" />
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function RobloxSection() {
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState('');
  const prefs = useRpc<AppPrefs>('app.prefs');
  useEffect(() => {
    void window.shuriken.secrets.has(OPEN_CLOUD_KEY).then(setHasKey);
  }, []);
  const saveKey = async () => {
    await window.shuriken.secrets.set(OPEN_CLOUD_KEY, key.trim());
    setKey('');
    setHasKey(true);
  };
  return (
    <>
      <Section
        title="Uploads to Roblox: defaults"
        hint="Roblox only plays uploaded sounds, meshes, images and animations, so what the agents make is uploaded (free; Roblox moderation checks each one). These are the defaults every project uses: your account, a default community and your Open Cloud key (create.roblox.com → Open Cloud → API Keys, with Assets read and write). A project can have its own community or account and its own key: under This project below, or chosen on the start page before it starts. Keys are stored encrypted on this PC."
      >
        <div className="flex items-center gap-2">
          <input id="rbx-key" type="password" className={cx(inputClass, 'max-w-md')} placeholder={hasKey ? 'A default key is saved — paste a new one to replace it' : 'Paste your default Open Cloud API key'} value={key} onChange={(e) => setKey(e.target.value)} />
          <Button kind="primary" icon={<KeyRound size={14} />} disabled={!key.trim()} onClick={() => void saveKey()}>
            Save key
          </Button>
          {hasKey && (
            <Button kind="ghost" onClick={() => void window.shuriken.secrets.delete(OPEN_CLOUD_KEY).then(() => setHasKey(false))}>
              Remove
            </Button>
          )}
        </div>
        {hasKey && <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ok"><CheckCircle2 size={14} /> Default key saved</div>}
        <div className="card mt-4 divide-y divide-line px-4">
          <Toggle
            checked={prefs.data?.uploadAssets !== false}
            onChange={(v) => void rpc('app.prefs.update', { uploadAssets: v }).then(() => prefs.reload())}
            label="Upload what the agents make"
            hint="Off: sounds, meshes and images stay in the project until you turn it on; the game can't play or show them yet."
          />
          <div className="py-3">
            <Field label="Roblox user id to upload to" hint="Found from the account signed in to Studio when left empty.">
              <input
                className={cx(inputClass, 'max-w-xs tabular-nums')}
                placeholder="Detected from Studio"
                defaultValue={prefs.data?.robloxCreatorId ?? ''}
                key={prefs.data?.robloxCreatorId ?? 'none'}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === (prefs.data?.robloxCreatorId ?? '') || (v && !/^\d+$/.test(v))) return;
                  void rpc('app.prefs.update', { robloxCreatorId: v }).then(() => prefs.reload());
                }}
              />
            </Field>
          </div>
          <UploadOwnerFields app={prefs.data?.robloxGroupId ?? ''} onSaved={() => prefs.reload()} />
        </div>
      </Section>
      <ProjectRobloxSection defaultUser={prefs.data?.robloxCreatorId ?? ''} defaultKey={hasKey} />
      <Section title="Roblox Studio">
        <div className="card divide-y divide-line px-4">
          <Toggle
            checked={prefs.data?.autoSave !== false}
            onChange={(v) => void rpc('app.prefs.update', { autoSave: v }).then(() => prefs.reload())}
            label="Save the place after verified work"
            hint="Recommended. Shuriken saves through Studio's File menu: no keys are pressed, it works during a playtest and with Studio behind other windows, and the window you were in gets the focus back. Off: world changes live only in Studio's memory until you save."
          />
          <StudioLinkToggle checked={prefs.data?.studioLink !== false} onChange={(v) => void rpc('app.prefs.update', { studioLink: v }).then(() => prefs.reload())} />
          <Toggle
            checked={prefs.data?.keepScreenOn !== false}
            onChange={(v) => void rpc('app.prefs.update', { keepScreenOn: v }).then(() => prefs.reload())}
            label="Keep the screen on while agents work"
            hint="Studio only draws screenshots while the screen is on, so agents couldn't check how things look while it sleeps. Only while agents work; the screen sleeps normally otherwise."
          />
        </div>
      </Section>
    </>
  );
}

type PolishChoice = 'none' | 'light' | 'standard' | 'thorough' | 'unlimited';
const POLISH_CHOICES: ReadonlyArray<readonly [PolishChoice, string]> = [
  ['none', 'None'],
  ['light', 'Light'],
  ['standard', 'Standard'],
  ['thorough', 'Thorough'],
  ['unlimited', 'No limit'],
];

/** What a polish setting means, in the numbers of a 24-task plan (orchestrator/proposal-triage.ts FOLLOW_UP_BUDGET). */
function polishHint(v: PolishChoice): string {
  const lead = 'While they build, agents propose improvements nobody asked for, and each one that is done brings more. This sets how many a goal may take on before it finishes.';
  if (v === 'none') return `${lead} None: the plan is built and checked, reported defects are fixed, and proposals are closed for you to read.`;
  if (v === 'light') return `${lead} Light (the default): a quarter of the plan's size (6 polish tasks for a plan of 24).`;
  if (v === 'standard') return `${lead} Standard: half the plan's size (12 polish tasks for a plan of 24).`;
  if (v === 'thorough') return `${lead} Thorough: as many as the plan itself (24 for a plan of 24).`;
  return `${lead} No limit: every proposal a planner thinks a player would notice becomes a task. A goal may then never finish: two builds made 119 and 85 polish tasks for plans of 24 and 33.`;
}

function AgentsSection() {
  const prefs = useRpc<AppPrefs>('app.prefs');
  const update = (patch: Partial<AppPrefs>) => void rpc('app.prefs.update', patch).then(() => prefs.reload());
  return (
    <>
      <Section title="Permissions" hint="What the team may decide by itself.">
        <div className="flex max-w-xl flex-col gap-2" role="radiogroup" aria-label="Permissions">
          {PERMISSION_MODES.map((o) => {
            const on = appMode(prefs.data?.permissionMode) === o.value;
            return (
              <button key={o.value} role="radio" aria-checked={on} onClick={() => update({ permissionMode: o.value })} className={cx('rounded-xl px-4 py-2.5 text-left ring-1 transition-colors', on ? 'bg-accent/15 text-accent2 ring-accent/50' : 'text-dim ring-line hover:bg-white/4')}>
                <span className="block text-[13px]">{o.label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">{o.hint}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-[11.5px] leading-snug text-faint">{ALWAYS_ASKS}</div>
        <ProjectPermissions app={prefs.data?.permissionMode} />
      </Section>
      <Section title="The team" hint="Planning, building and review use Opus; research and the director's replies use Sonnet; suggestion bubbles and quick looks use Haiku.">
        <div className="card divide-y divide-line px-4">
          <StepSlider
            label="Most agents at once"
            value={prefs.data?.agentCap ?? 8}
            stops={AGENT_CAP_STOPS}
            labels={[0, 3, 7, 11, 15, 19, 23, 27, 31]}
            onChange={(v) => update({ agentCap: v, maxConcurrentAgents: 0 })}
            note="An agent starts for every task that is ready, up to this many in one build (8 by default, 32 at most). A big number uses your plan's usage faster. Planning takes a place like any agent; how many of them may work in Studio at once is the next setting, and a task that needs Studio waits unstarted until a place there is free. Agents only waiting for a Kiln build or an upload take no place. The top bar says why the number is what it is."
          />
          <StepSlider
            label="Agents in Studio at once"
            value={prefs.data?.studioAgents ?? 4}
            stops={STUDIO_AGENT_STOPS}
            labels={[0, 1, 3, 5, 7, 9, 11, 13, 15]}
            onChange={(v) => update({ studioAgents: v })}
            note="How many of a build's agents may work in its Studio at the same time (4 by default, 16 at most); the others write code, sounds and models meanwhile. Agents in Studio mostly write and check code, and playtests go one at a time, so the price of a big number is the line when many want a playtest together: over about 12,000 Studio calls, playtests took 25 s with 1 or 2 agents in Studio, 49 s with 5 or 6 and 117 s with 10 or more, and more of them failed (3% to 15%). Each build has its own Studio, so this is per build."
          />
          <ProjectLimit
            setting="agentCap"
            label="Most agents at once in this project"
            app={prefs.data?.agentCap ?? 8}
            stops={AGENT_CAP_STOPS}
            note="This window only. A big game that is being iterated needs fewer agents than a fresh build: its Studio can take only so many playtests an hour, and the rest wait in line (about 6 on a heavy place). A lower number starts nobody new; agents already working finish."
          />
          <StepSlider
            label="How deeply the agents think"
            value={prefs.data?.agentEffort ?? 'high'}
            stops={EFFORT_STOPS}
            onChange={(v) => update({ agentEffort: v })}
            note="Every agent but the planner: the specialists, the critic, research, the director's replies and the dock copilots. Most of an agent's time goes into thinking: High (the default) is careful; Medium moves quicker with somewhat less care; Extra high and Max think longer again."
          />
          <StepSlider
            label="How deeply the planner thinks"
            value={prefs.data?.plannerEffort ?? 'max'}
            stops={EFFORT_STOPS}
            onChange={(v) => update({ plannerEffort: v })}
            note="The plan decides what every agent does, and its misses are redone by the whole team: in 19 builds, 331 tasks redid finished work, mostly for what the plan left out. Max (the default) thinks as long as the plan needs; Extra high takes 5 to 8 minutes before the first task starts; Medium starts work in about a minute. For every plan, plan change and triage."
          />
          <StepSlider label="Polish" value={prefs.data?.polish ?? 'light'} stops={POLISH_CHOICES} onChange={(v) => update({ polish: v })} note={polishHint(prefs.data?.polish ?? 'light')} />
          <ProjectKeepBuilding />
          <ProjectAutoQa />
        </div>
      </Section>
    </>
  );
}

/** The Storefront's two switches: what the game sells, and the words that sell it (core storefront/, app-prefs.ts). */
function StorefrontSection() {
  const prefs = useRpc<AppPrefs>('app.prefs', undefined, ['storefront.changed']);
  const update = (patch: Partial<AppPrefs>) => void rpc('app.prefs.update', patch).then(() => prefs.reload());
  return (
    <>
      <Section
        title="Storefront"
        hint="What sells the game on Roblox, made by its own experts beside the build: a store designer, a copywriter and a thumbnail artist, each with a copilot on the Storefront page. With both switches off, games are built without any of it."
      >
        <div className="card divide-y divide-line px-4">
          <Toggle
            checked={prefs.data?.monetization !== false}
            onChange={(v) => update({ monetization: v })}
            label="Monetization"
            hint="Every new game's plan designs a store for its genre (cosmetics and status only for a competitive game, never an advantage; stronger sellers where the genre is built on them): game passes and developer products, built into the game and tested with Studio's test purchases, with one consistent set of icons. Nothing goes on Roblox until you press Push to Roblox on the Storefront page or tell the director to."
          />
          <Toggle
            checked={prefs.data?.copy !== false}
            onChange={(v) => update({ copy: v })}
            label="Copy"
            hint="The game's title, its description and its store's texts, written the way the top Roblox games write theirs, by a copywriter who works beside the build without holding it up. You put the title and description on Roblox yourself."
          />
        </div>
        <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-faint">
          Thumbnails and the game's icon are made with either switch on: five thumbnails a judge narrows to one, saved as PNG for you to upload. Pushing the store needs the game published and an Open Cloud key (Roblox & Studio) with the Game Passes and Developer Products APIs (write) for it. The game itself, its thumbnails and its description are never published from Shuriken.
        </p>
      </Section>
    </>
  );
}

function ModelsSection() {
  const prefs = useRpc<AppPrefs>('app.prefs');
  const update = (patch: Partial<AppPrefs>) => void rpc('app.prefs.update', patch).then(() => prefs.reload());
  return (
    <>
      <Section title="Kiln" hint="Kiln builds every model: its own copilot builds each one in its own Blender, and Shuriken brings the result into the game.">
        <KilnField path={prefs.data?.kilnPath ?? ''} onSaved={() => prefs.reload()} />
        <div className="card mt-4 divide-y divide-line px-4">
          <StepSlider
            label="Kiln builds at once"
            value={prefs.data?.kilnBuildsAtOnce ?? 8}
            stops={KILN_BUILD_STOPS}
            onChange={(v) => update({ kilnBuildsAtOnce: v })}
            note={
              <>
                The rest wait their turn. Each build is a turn of Kiln's copilot on your subscription (a kit of parts about 10 minutes and $2, one prop about 5 minutes and $1.20) and a Blender on your graphics card. Kiln 0.8.1 and older run at most 6 at once. When builds fail, slow down or queue for the graphics card, Shuriken lowers the number by itself and says so.
                <KilnQueueNote />
              </>
            }
          />
          <ProjectLimit
            setting="kilnBuildsAtOnce"
            label="Kiln builds at once in this project"
            app={prefs.data?.kilnBuildsAtOnce ?? 8}
            stops={KILN_BUILD_STOPS}
            note="This window only: how many of this project's models Kiln builds at once. Each window counts its own builds."
          />
          <Toggle
            checked={prefs.data?.startKilnWhenNeeded !== false}
            onChange={(v) => update({ startKilnWhenNeeded: v })}
            label="Start Kiln when a build needs a model"
            hint="On (the default): if Kiln isn't running when the team needs a model, Shuriken starts it in the background and says so in the chat."
          />
          <Toggle
            checked={prefs.data?.startKilnWithShuriken === true}
            onChange={(v) => update({ startKilnWithShuriken: v })}
            label="Start Kiln with Shuriken"
            hint="Starts Kiln in the background when Shuriken opens, unless it already runs. Your own Kiln windows stay as they are."
          />
          <Toggle
            checked={prefs.data?.dockKiln !== false}
            onChange={(v) => update({ dockKiln: v })}
            label="Dock Kiln"
            hint="The Kiln page shows Kiln inside Shuriken's window. Off: it opens in a window of its own you can put on another monitor."
          />
        </div>
      </Section>
      <Section title="Blender" hint="Shuriken's own Blender renders models for the agents and takes over when Kiln can't be reached.">
        <BlenderField path={prefs.data?.blenderPath ?? ''} onSaved={() => prefs.reload()} />
        <div className="card mt-4 divide-y divide-line px-4">
          <StepSlider
            label="3D models worked on at once"
            value={prefs.data?.modelingWorkspaces ?? 8}
            stops={[1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24].map((v) => [v, String(v)] as const)}
            onChange={(v) => update({ modelingWorkspaces: v })}
            note="Each model gets its own headless Blender (about 200 to 400 MB of memory each)."
          />
          <Toggle
            checked={prefs.data?.modelInKiln === true}
            onChange={(v) => update({ modelInKiln: v })}
            label="Run the agents' own Blender work inside Kiln (advanced)"
            hint="Only for the fallback, when agents write Blender Python themselves because Kiln couldn't build a model. Off (the default): it runs in Shuriken's own Blender. On: it runs in a Kiln project you can watch live."
          />
        </div>
      </Section>
    </>
  );
}

/** Shuriken Link: the Studio plugin, with what it is and its state. */
function StudioLinkToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const status = useRpc<StudioLinkInfo>('studio.link.status', undefined, ['roblox.changed', 'prefs.changed']);
  return (
    <>
      <Toggle
        checked={checked}
        onChange={onChange}
        label="Studio plugin (Shuriken Link)"
        hint="A small plugin in Studio's Plugins folder that Shuriken runs its code through: it may create scripts, load the game's modules and fire events, which Studio's AI connection no longer may, and it is many times faster. It only talks to Shuriken on this PC, checks it really is Shuriken before it runs anything, and does nothing in places that aren't a Shuriken project's. Off removes the plugin file."
      />
      <div className="pb-3 text-[12px] leading-snug text-dim">{studioLinkLine(status.data)}</div>
    </>
  );
}

/**
 * Communities are the standard owner of what the agents upload: the default community, and where uploads go right now
 * when no project is open (a published game's community wins over the default; see roblox/upload-owner.ts). A project's
 * own community, account and key: ProjectRobloxSection.
 */
function UploadOwnerFields({ app, onSaved }: { app: string; onSaved: () => void }) {
  const project = useCurrentProject();
  const where = useRpc<{ line: string }>('uploads.owner');
  const digits = (v: string) => !v || /^\d{1,20}$/.test(v);
  return (
    <>
      <div className="py-3">
        <Field label="Community to upload to (default)" hint="Communities are the standard: a game published under a community uploads to it by itself, and this is the community for games that aren't published yet. Its uploads need one of the community's own Open Cloud keys (create.roblox.com → switch to the community → Open Cloud → API Keys). Leave empty to upload to your account.">
          <input
            className={cx(inputClass, 'max-w-xs tabular-nums')}
            placeholder="Community (group) id"
            defaultValue={app}
            key={app || 'none'}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === app || !digits(v)) return;
              void rpc('app.prefs.update', { robloxGroupId: v }).then(() => {
                onSaved();
                where.reload();
              });
            }}
          />
        </Field>
      </div>
      {!project.data && where.data && <div className="pb-3 text-[12px] leading-snug text-dim">Uploads go to: {where.data.line}</div>}
    </>
  );
}

const PROJECT_OWNER_CHOICES: ReadonlyArray<readonly [RobloxMode, string]> = [
  ['default', 'Defaults'],
  ['community', 'A community'],
  ['account', 'Another account'],
];

/**
 * The open project's Roblox side: where its uploads and store go (the defaults, a community, another account) and its
 * own Open Cloud key, used instead of the default one while it is saved (core roblox/project-keys.ts). The key is
 * saved encrypted by the main process under the project's name for it; it never reaches the core through RPC.
 */
function ProjectRobloxSection({ defaultUser, defaultKey }: { defaultUser: string; defaultKey: boolean }) {
  const project = useCurrentProject();
  const info = useRpc<{ settings: { robloxGroupId?: string | null; robloxUserId?: string | null } }>(project.data ? 'project.settings' : null);
  const where = useRpc<{ line: string; key: OpenCloudKeySource; projectKey: string | null }>(project.data ? 'uploads.owner' : null);
  const [picked, setPicked] = useState<RobloxMode | null>(null);
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  if (!project.data) return null;
  const settings = info.data?.settings;
  const stored: RobloxMode = settings?.robloxGroupId ? 'community' : settings?.robloxUserId ? 'account' : 'default';
  const mode = picked ?? stored;
  const storedId = mode === 'community' ? (settings?.robloxGroupId ?? '') : mode === 'account' ? (settings?.robloxUserId ?? '') : '';
  const refresh = () => {
    info.reload();
    where.reload();
  };
  const save = (patch: { robloxGroupId: string | null; robloxUserId: string | null }) => void rpc('project.settings.update', { settings: patch }).then(refresh);
  const choose = (m: RobloxMode) => {
    setPicked(m);
    setProblem(null);
    // Defaults right away; a community or an account once its id is typed.
    if (m === 'default') save({ robloxGroupId: null, robloxUserId: null });
  };
  const saveId = (v: string) => {
    const id = robloxId(v);
    if (!v.trim() || v.trim() === storedId) return;
    if (!id) return setProblem('Digits only: the id in the address of the community or profile on roblox.com.');
    setProblem(null);
    save(mode === 'community' ? { robloxGroupId: id, robloxUserId: null } : { robloxGroupId: null, robloxUserId: id });
  };
  const saveKey = async () => {
    if (!where.data?.projectKey || !key.trim()) return;
    await window.shuriken.secrets.set(where.data.projectKey, key.trim());
    setKey('');
    refresh();
  };
  const removeKey = async () => {
    if (!where.data?.projectKey) return;
    await window.shuriken.secrets.delete(where.data.projectKey);
    refresh();
  };
  // A community key saved as the default (before projects had their own): keep it for this project, then the
  // personal key can become the default again.
  const keepDefault = async () => {
    if (!where.data?.projectKey) return;
    await window.shuriken.secrets.copy(OPEN_CLOUD_KEY, where.data.projectKey);
    refresh();
  };
  const own = where.data?.key === 'project';
  const keyLine = own ? "this project's own key" : where.data?.key === 'default' ? 'the default key' : 'no key yet (none is saved here or as the default)';
  return (
    <Section
      title={`This project: ${project.data.name}`}
      hint="Its own community or account, and its own Open Cloud key. A community's uploads and store need one of the community's own keys, so a community project keeps that key here while your personal key stays the default. The store push and Luau on the published place use the same key."
    >
      <div className="card divide-y divide-line px-4">
        <div className="py-3">
          <div className="mb-1.5 text-[12px] font-medium text-dim">Uploads and the store go to</div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Where this project's uploads go">
            {PROJECT_OWNER_CHOICES.map(([m, label]) => (
              <button key={m} role="radio" aria-checked={mode === m} onClick={() => choose(m)} className={cx('rounded-xl px-4 py-2 text-[13px] ring-1 transition-colors', mode === m ? 'bg-accent/15 text-accent2 ring-accent/50' : 'text-dim ring-line hover:bg-white/4')}>
                {label}
              </button>
            ))}
          </div>
          {mode !== 'default' && (
            <input
              className={cx(inputClass, 'mt-2.5 max-w-xs tabular-nums')}
              inputMode="numeric"
              placeholder={mode === 'community' ? 'Community (group) id' : `Roblox user id${defaultUser ? ` (default: ${defaultUser})` : ''}`}
              defaultValue={storedId}
              key={`${mode}:${storedId || 'none'}`}
              onBlur={(e) => saveId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveId((e.target as HTMLInputElement).value)}
            />
          )}
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{mode === 'default' ? "Follows the published game's owner, then your defaults above." : modeHint(mode)}</div>
          {problem && <div className="mt-1.5 text-[12px] text-bad">{problem}</div>}
        </div>
        <div className="py-3">
          <div className="mb-1.5 text-[12px] font-medium text-dim">This project's Open Cloud key</div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              className={cx(inputClass, 'max-w-md')}
              placeholder={own ? "This project's key is saved — paste a new one to replace it" : defaultKey ? 'Empty: the default key is used' : "Paste this project's Open Cloud key"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button kind="primary" icon={<KeyRound size={14} />} disabled={!key.trim() || !where.data?.projectKey} onClick={() => void saveKey()}>
              Save key
            </Button>
            {own && (
              <Button kind="ghost" onClick={() => void removeKey()}>
                Use the default
              </Button>
            )}
          </div>
          {own && <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ok"><CheckCircle2 size={14} /> This project's own key is saved</div>}
          {!own && defaultKey && mode !== 'default' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] leading-snug text-dim">
              <span className="min-w-[240px] flex-1">Is the default key this {mode === 'community' ? "community's" : "account's"} key? Keep it for this project alone, then paste your personal key as the default above.</span>
              <Button size="sm" onClick={() => void keepDefault()}>
                Keep the default key for this project
              </Button>
            </div>
          )}
        </div>
        {where.data && <div className="py-3 text-[12px] leading-snug text-dim">Uploads and the store go to {where.data.line}, with {keyLine}.</div>}
      </div>
    </Section>
  );
}

/** This window's QA passes (ProjectSettings.autoQa): on by default; off, the planner adds no separate QA tasks. */
function ProjectAutoQa() {
  const project = useCurrentProject();
  const info = useRpc<{ settings: { autoQa?: boolean | null } }>(project.data ? 'project.settings' : null);
  if (!project.data) return null;
  return (
    <Toggle
      checked={info.data?.settings.autoQa !== false}
      onChange={(v) => void rpc('project.settings.update', { settings: { autoQa: v } }).then(() => info.reload())}
      label={`Add QA passes to plans: ${project.data.name}`}
      hint="This window only. On (the default): plans may end with a QA task that plays the new work through. Off: no separate QA tasks; every task still has its own checks and the critic's review."
    />
  );
}

/**
 * This window's "Keep building" (ProjectSettings.keepBuilding): when a goal is done, the next milestone of the roadmap
 * starts by itself. Off by default: a finished goal stops there.
 */
function ProjectKeepBuilding() {
  const project = useCurrentProject();
  const info = useRpc<{ settings: { keepBuilding?: boolean | null } }>(project.data ? 'project.settings' : null);
  if (!project.data) return null;
  return (
    <Toggle
      checked={info.data?.settings.keepBuilding === true}
      onChange={(v) => void rpc('project.settings.update', { settings: { keepBuilding: v } }).then(() => info.reload())}
      label={`Keep building after a goal: ${project.data.name}`}
      hint="This window only. Off (the default): when a goal is done and checked, the team stops there, and the chat says when the roadmap has more; ask for the next milestone when you want it. On: the next milestone of the roadmap is planned and built by itself, one after another (up to 8), for a build you leave running overnight."
    />
  );
}

/**
 * The open project's own limit (agents at once, Kiln builds at once): the app's setting, or a number for this project
 * (window) alone. Stored in the project's settings; null follows the app.
 */
function ProjectLimit({ setting, label, app, stops, note }: { setting: 'agentCap' | 'kilnBuildsAtOnce'; label: string; app: number; stops: ReadonlyArray<readonly [number, string]>; note: string }) {
  const project = useCurrentProject();
  const info = useRpc<{ settings: { agentCap?: number | null; kilnBuildsAtOnce?: number | null } }>(project.data ? 'project.settings' : null);
  if (!project.data) return null;
  const stored = info.data?.settings[setting];
  const choices: ReadonlyArray<readonly [string, string]> = [['app', `Same as app (${app})`], ...stops.map(([v, l]) => [String(v), l] as const)];
  return (
    <StepSlider
      label={`${label}: ${project.data.name}`}
      value={stored == null ? 'app' : String(stored)}
      stops={choices}
      onChange={(v) => void rpc('project.settings.update', { settings: { [setting]: v === 'app' ? null : Number(v) } }).then(() => info.reload())}
      note={note}
    />
  );
}

/** The open project's own permission mode: the app's, or Autonomous or Ask for this project alone. */
function ProjectPermissions({ app }: { app: PermissionMode | undefined }) {
  const project = useCurrentProject();
  const info = useRpc<{ settings: { permissionMode?: PermissionMode | null } }>(project.data ? 'project.settings' : null);
  if (!project.data) return null;
  const stored = info.data?.settings.permissionMode;
  const choice = projectChoice(stored);
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[12px] font-medium text-dim">For this project: {project.data.name}</div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Permissions for this project">
        {PROJECT_MODE_CHOICES.map((c) => (
          <button
            key={c.value}
            role="radio"
            aria-checked={choice === c.value}
            onClick={() => void rpc('project.settings.update', { settings: { permissionMode: projectSetting(c.value) } }).then(() => info.reload())}
            className={cx('rounded-xl px-4 py-2 text-[13px] ring-1 transition-colors', choice === c.value ? 'bg-accent/15 text-accent2 ring-accent/50' : 'text-dim ring-line hover:bg-white/4')}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{projectModeNote(stored, app)}</div>
    </div>
  );
}

interface AppPrefs {
  maxConcurrentAgents: number;
  autoSave: boolean;
  uploadAssets: boolean;
  robloxCreatorId: string;
  robloxGroupId?: string;
  keepScreenOn: boolean;
  blenderPath: string;
  modelingWorkspaces: number;
  modelInKiln: boolean;
  kilnPath: string;
  startKilnWithShuriken: boolean;
  startKilnWhenNeeded: boolean;
  kilnBuildsAtOnce: number;
  dockKiln: boolean;
  agentEffort: 'medium' | 'high' | 'xhigh' | 'max';
  agentCap: number;
  studioAgents: number;
  plannerEffort: 'medium' | 'high' | 'xhigh' | 'max';
  polish: PolishChoice;
  permissionMode: PermissionMode;
  studioLink: boolean;
  monetization: boolean;
  copy: boolean;
}

/** Why fewer Kiln builds run than the setting says (an older Kiln, or the queue stepped down), when that is so. */
function KilnQueueNote() {
  const q = useRpc<{ status: { atOnce: number; setting: number; note: string | null } | null }>('kiln.builds', {}, ['kiln.builds', 'prefs.changed']);
  const s = q.data?.status;
  if (!s?.note) return null;
  return (
    <span className="mt-1 block text-warn">
      Running {s.atOnce} at once now: {s.note}.
    </span>
  );
}

/** Where Kiln.exe is (the Desktop shortcut's target when empty), and whether Kiln runs now. */
function KilnField({ path, onSaved }: { path: string; onSaved: () => void }) {
  const [text, setText] = useState(path);
  const [found, setFound] = useState<{ exe: string | null; running: boolean; version: string | null } | null>(null);
  useEffect(() => setText(path), [path]);
  useEffect(() => {
    void window.shuriken.kiln.locate(path).then(setFound);
  }, [path]);
  const save = (v: string) => void rpc('app.prefs.update', { kilnPath: v.trim() }).then(onSaved);
  return (
    <Field label="Kiln location">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== path && save(text)}
          placeholder={found?.exe ? `Found: ${found.exe}` : 'C:\\…\\Kiln.exe (the Desktop shortcut when empty)'}
          className="min-w-0 flex-1 rounded-xl bg-surface2 px-3 py-2 text-[12.5px] text-text ring-1 ring-line outline-none placeholder:text-faint focus:ring-accent/50"
        />
        {text && (
          <button onClick={() => { setText(''); save(''); }} className="rounded-xl px-3 py-2 text-[12px] text-dim ring-1 ring-line hover:bg-white/4">
            Use the shortcut
          </button>
        )}
      </div>
      <div className={cx('mt-1.5 text-[11.5px] leading-snug', found?.running ? 'text-ok' : found?.exe ? 'text-faint' : 'text-warn')}>
        {!found ? '' : found.running ? `Kiln${found.version ? ` ${found.version}` : ''} is running` : found.exe ? "Kiln isn't running; Shuriken starts it in the background when you open the Kiln page" : "Kiln.exe wasn't found: set where it is"}
      </div>
    </Field>
  );
}

/** Where Blender is (found automatically; set a path when it lives somewhere else). */
function BlenderField({ path, onSaved }: { path: string; onSaved: () => void }) {
  const status = useRpc<{ ready: boolean; exe: string | null; detail: string }>('models.env', {}, ['blender.workspaces']);
  const [text, setText] = useState(path);
  useEffect(() => setText(path), [path]);
  const save = (v: string) => void rpc('app.prefs.update', { blenderPath: v.trim() }).then(() => {
    onSaved();
    status.reload();
  });
  return (
    <Field label="Blender (for 3D modeling)">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== path && save(text)}
          placeholder={status.data?.exe ? `Found: ${status.data.exe}` : 'C:\\…\\blender.exe (found automatically when empty)'}
          className="min-w-0 flex-1 rounded-xl bg-surface2 px-3 py-2 text-[12.5px] text-text ring-1 ring-line outline-none placeholder:text-faint focus:ring-accent/50"
        />
        {text && (
          <button onClick={() => { setText(''); save(''); }} className="rounded-xl px-3 py-2 text-[12px] text-dim ring-1 ring-line hover:bg-white/4">
            Find it
          </button>
        )}
      </div>
      <div className={cx('mt-1.5 text-[11.5px] leading-snug', status.data?.ready ? 'text-ok' : 'text-warn')}>{status.data?.detail ?? ''}</div>
    </Field>
  );
}

interface Health {
  id: string;
  name: string;
  status: string;
  summary: string;
}

function AppSection() {
  const health = useRpc<Health[]>('health.list', undefined, ['health.updated']);
  const project = useCurrentProject();
  const tone = (s: string) => (s === 'healthy' ? 'ok' : s === 'degraded' || s === 'needs_configuration' ? 'warn' : s === 'unknown' ? 'neutral' : 'bad');
  return (
    <>
      <Section title="Connections">
        <div className="card divide-y divide-line">
          {(health.data ?? []).map((h) => (
            <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
              <Pill tone={tone(h.status)}>{h.status.replace('_', ' ')}</Pill>
              <span className="w-44 shrink-0 text-[13px] text-text">{h.name}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-faint" title={h.summary}>
                {h.summary}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void rpc('health.run', {}).then(() => health.reload())}>
            Check again
          </Button>
        </div>
      </Section>
      <Section title="Session logs" hint="Every session (chat, agent work, errors, screenshots) is recorded on this PC so problems can be reviewed and fixed later.">
        <div className="flex gap-2">
          <Button icon={<FolderOpen size={14} />} onClick={() => void window.shuriken.journalDir().then((d) => d && window.shuriken.openPath(d))}>
            Open this session's log
          </Button>
          {project.data && (
            <Button icon={<FolderOpen size={14} />} onClick={() => void window.shuriken.openPath(project.data!.rootPath)}>
              Open project folder
            </Button>
          )}
        </div>
      </Section>
    </>
  );
}
