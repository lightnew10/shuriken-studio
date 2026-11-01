import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { studioForbidden } from './studio-guard';
export interface SavePlaceResult {
  ok: boolean;
  message: string;
  /** The place file's modification time after the save, when it could be checked. */
  savedAt?: string;
  /** How it was saved: through Studio's File menu, or with Ctrl+S. */
  how?: 'menu' | 'keys';
  /** Not saved, and nothing is wrong: the save waits (someone is typing, Studio has the menu entry switched off). */
  waiting?: boolean;
  /** Asked to save through the File menu only, and this Studio has no such menu (the caller uses the keys). */
  noMenu?: boolean;
  /** Why the File menu was not used, when the keys were (for the log). */
  menuNote?: string;
  /**
   * Windows would not bring Studio to the front (after three tries), so no keys were sent. Nothing is wrong with the
   * place or with Studio: a save through the window can't be done unattended right now (Studio's MCP has no save).
   */
  focus?: boolean;
  /** No Studio window has the place open (by its title): nothing was pressed. */
  noWindow?: boolean;
}

/**
 * Studio draws nothing while its window is minimized (its viewport shrinks to 1×1), so screenshots
 * time out and game input goes nowhere. This restores the window that has the place open *behind*
 * every other window without activating it: the user's work stays in front and keeps focus, and
 * Studio renders again. `titleNeedle` is the place file name ("x.rbxlx") or a published place's name
 * ("Schism (Dev)"); windows are titled "<file or name> - Roblox Studio". Windows only.
 */
export async function unminimizeStudioWindow(titleNeedle: string): Promise<'restored' | 'visible' | 'nowindow' | 'error'> {
  if (studioForbidden()) return 'nowindow';
  if (process.platform !== 'win32' || !titleNeedle) return 'error';
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Shuriken -Name Win2 -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
"@
${findStudioWindow(titleNeedle)}
if (-not $p) { Write-Output 'NOWINDOW'; exit 0 }
$h = $p.MainWindowHandle
if (-not [Shuriken.Win2]::IsIconic($h)) { Write-Output 'VISIBLE'; exit 0 }
$null = [Shuriken.Win2]::ShowWindow($h, 4)
$null = [Shuriken.Win2]::SetWindowPos($h, [System.IntPtr]1, 0, 0, 0, 0, 0x13)
Write-Output 'RESTORED'
`;
  const out = await new Promise<string>((resolve) => {
    const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let text = '';
    ps.stdout.on('data', (d: Buffer) => (text += d.toString()));
    ps.stderr.on('data', (d: Buffer) => (text += d.toString()));
    ps.on('close', () => resolve(text.trim()));
    ps.on('error', (e) => resolve(`ERROR ${e.message}`));
  });
  return out.startsWith('RESTORED') ? 'restored' : out.startsWith('VISIBLE') ? 'visible' : out.startsWith('NOWINDOW') ? 'nowindow' : 'error';
}

/** Runs a PowerShell script hidden and returns what it printed (stdout and stderr), trimmed; "ERROR …" when it could not run. */
function powershell(script: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let text = '';
    ps.stdout.on('data', (d: Buffer) => (text += d.toString()));
    ps.stderr.on('data', (d: Buffer) => (text += d.toString()));
    ps.on('close', () => resolve(text.trim()));
    ps.on('error', (e) => resolve(`ERROR ${e.message}`));
  });
}

/** A place name or file name inside a single-quoted PowerShell string used with -like. */
const likeQuoted = (needle: string) => needle.replace(/'/g, "''").replace(/([[\]*?`])/g, '`$1');

/** A title or a place name reduced to its letters and digits, lower case: what survives however Studio punctuates it. */
export const titleKey = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{Nd}]/gu, '').toLowerCase();

/**
 * PowerShell that sets `$p` to the Studio process whose main window has the place open (or to nothing). In one of the
 * user's three simultaneous builds, a place named "BuilderFan's Place: 10012026_4", no capture worked for hours
 * while the other two projects' windows drew: Studio's connection gives the place's name, and nothing says its
 * window is titled with the same punctuation. So after the exact title, the title's letters and digits are compared;
 * and when one Studio window is open at all, it is the one (the caller only asks for a place Studio has connected).
 */
export function findStudioWindow(titleNeedle: string): string {
  const key = titleKey(titleNeedle);
  return `$all = @(Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle })
$p = $all | Where-Object { $_.MainWindowTitle -like '*${likeQuoted(titleNeedle)} - Roblox Studio' } | Select-Object -First 1
${key.length >= 3 ? `if (-not $p) { $p = $all | Where-Object { (($_.MainWindowTitle -replace '[^\\p{L}\\p{Nd}]', '').ToLowerInvariant()).Contains('${key}') } | Select-Object -First 1 }` : ''}
if (-not $p -and $all.Count -eq 1) { $p = $all[0] }`;
}

/**
 * Whether Studio has the place open, by its processes (not by its MCP connection): 'open' when a Studio window is
 * titled with the place, 'starting' when a Studio process is younger than two minutes (it may be loading the place
 * and has no title yet), 'none' when neither, 'unknown' when it can't be told (not Windows, PowerShell failed).
 * After a crash the answer is 'none' while Studio's MCP proxy still answers: that is what tells a Studio that is
 * gone from one that is only slow to connect.
 */
export async function studioWindowState(titleNeedle: string): Promise<'open' | 'starting' | 'none' | 'unknown'> {
  if (process.platform !== 'win32' || !titleNeedle) return 'unknown';
  const script = `
$all = @(Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue)
if ($all | Where-Object { $_.MainWindowTitle -like '*${likeQuoted(titleNeedle)} - Roblox Studio' }) { Write-Output 'OPEN'; exit 0 }
$young = $all | Where-Object { try { ((Get-Date) - $_.StartTime).TotalSeconds -lt 120 } catch { $false } }
if ($young) { Write-Output 'STARTING' } else { Write-Output 'NONE' }
`;
  const out = await powershell(script);
  return out.startsWith('OPEN') ? 'open' : out.startsWith('STARTING') ? 'starting' : out.startsWith('NONE') ? 'none' : 'unknown';
}

/**
 * Closes the Studio window that has the place open, the way its X button does (no keys, no focus): a place with
 * nothing unsaved goes at once. One that asks about unsaved changes, or is not gone within `graceMs`, is ended as a
 * process: the caller saved the place a moment ago (StudioRecovery.refresh), so nothing is lost. Only a window
 * titled with exactly this place file is ever closed. Windows only.
 */
export async function closeStudioWindow(placeFileName: string, graceMs = 15_000, opts: { startedWith?: boolean } = {}): Promise<'closed' | 'killed' | 'nowindow' | 'error'> {
  if (studioForbidden()) return 'nowindow';
  if (process.platform !== 'win32' || !placeFileName) return 'error';
  // `startedWith`: a Studio that was started with this file and never opened it has no window titled with it (it
  // hung while starting: five of them piled up in one build, each 0.5 to 1.2 GB, and every Studio started after
  // the first hung behind it). Such a process is found by its command line and ended. Only for files that are
  // Shuriken's own copies (play windows): never for a place of the user's.
  const out = await powershell(`
$p = Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${likeQuoted(placeFileName)} - Roblox Studio' } | Select-Object -First 1
${
  opts.startedWith
    ? `if (-not $p) {
  $stuck = @(Get-CimInstance Win32_Process -Filter "Name='RobloxStudioBeta.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${likeQuoted(placeFileName)}*' })
  if ($stuck.Count -eq 0) { Write-Output 'NOWINDOW'; exit 0 }
  foreach ($s in $stuck) { Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Output 'KILLED'; exit 0
}`
    : ''
}
if (-not $p) { Write-Output 'NOWINDOW'; exit 0 }
$null = $p.CloseMainWindow()
if ($p.WaitForExit(${Math.round(graceMs)})) { Write-Output 'CLOSED'; exit 0 }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
if ($p.WaitForExit(10000)) { Write-Output 'KILLED' } else { Write-Output 'ERROR still running' }
`);
  return out.startsWith('CLOSED') ? 'closed' : out.startsWith('KILLED') ? 'killed' : out.startsWith('NOWINDOW') ? 'nowindow' : 'error';
}

/**
 * How long nobody must have touched the keyboard or mouse before Shuriken may move Studio's window where the user
 * would see it (`idleMs`: to the top for a capture, to the foreground for a save), and how long one reading of the
 * user's activity is reused (`cacheMs`). An object so a test can shorten it.
 */
export const UNATTENDED = { idleMs: 3 * 60_000, cacheMs: 10_000 };

export interface UserActivity {
  /** Milliseconds since the last keyboard or mouse input (Windows' GetLastInputInfo). */
  idleMs: number;
  /** The process name of the window in front ("RobloxStudioBeta", "chrome", …; '' when unknown). */
  foreground: string;
}

/** What the user is doing, as Windows knows it (null when it can't be told: not Windows, PowerShell failed). */
export async function readUserActivity(): Promise<UserActivity | null> {
  if (process.platform !== 'win32') return null;
  const script = `
Add-Type -Namespace Shuriken -Name Idle -MemberDefinition @"
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
"@
$i = New-Object Shuriken.Idle+LASTINPUTINFO
$i.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($i)
$null = [Shuriken.Idle]::GetLastInputInfo([ref]$i)
$idle = [Environment]::TickCount - $i.dwTime
$fgPid = 0
$null = [Shuriken.Idle]::GetWindowThreadProcessId([Shuriken.Idle]::GetForegroundWindow(), [ref]$fgPid)
$name = ''
try { $name = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch {}
Write-Output "$idle $name"
`;
  const [idleText, name = ''] = (await powershell(script)).split(/\s+/);
  const idle = Number(idleText);
  return Number.isFinite(idle) && idleText !== '' ? { idleMs: Math.max(0, idle), foreground: name } : null;
}

/**
 * Whether anybody is at the PC. Waking the display for a capture is input as far as Windows is concerned, so the
 * reading right after it would say "someone just moved the mouse": the tracker remembers its own wake (noteOwnInput)
 * and keeps counting the idle time from before it.
 */
export class IdleTracker {
  /**
   * A file every Shuriken window on this PC shares (set by the core): the last input Shuriken itself made, whichever
   * window made it. Each project window runs its own core with its own tracker. With two builds side by side, one
   * window's display wake, its Ctrl+S save and the keys it sends into a playtest all read as "someone is at the PC"
   * to the other for three minutes: it then left its Studio window where it was, covered by the other project's,
   * and its captures timed out (25-41 s each, inside playtests everyone else waited behind).
   */
  static shared: string | null = null;
  /** How close Windows' last input must be to an input Shuriken noted for it to be Shuriken's own. */
  static readonly OWN_INPUT_MS = 4000;

  private last: { at: number; value: UserActivity | null } | null = null;
  private own: { at: number; idleBefore: number } | null = null;

  constructor(private readonly read: () => Promise<UserActivity | null> = readUserActivity) {}

  /** The newest input Shuriken made: this window's, or another's from the shared file. */
  private latestOwn(): { at: number; idleBefore: number } | null {
    let other: { at: number; idleBefore: number } | null = null;
    if (IdleTracker.shared) {
      try {
        const j = JSON.parse(readFileSync(IdleTracker.shared, 'utf8')) as { at?: unknown; idleBefore?: unknown };
        if (typeof j.at === 'number' && typeof j.idleBefore === 'number') other = { at: j.at, idleBefore: j.idleBefore };
      } catch {
        /* nobody noted one yet */
      }
    }
    return other && (!this.own || other.at > this.own.at) ? other : this.own;
  }

  async activity(): Promise<UserActivity | null> {
    const now = Date.now();
    if (this.last && now - this.last.at < UNATTENDED.cacheMs) return this.last.value;
    let value = await this.read().catch(() => null);
    // The last input was Shuriken's own (the display's wake, a save, keys sent into a playtest): nobody came back.
    const own = this.latestOwn();
    if (value && own && Math.abs(Date.now() - value.idleMs - own.at) < IdleTracker.OWN_INPUT_MS) value = { ...value, idleMs: own.idleBefore + (Date.now() - own.at) };
    this.last = { at: Date.now(), value };
    return value;
  }

  /** Nobody has touched the PC for `UNATTENDED.idleMs` (false when it can't be told: then the user's focus is never touched). */
  async unattended(): Promise<boolean> {
    const a = await this.activity();
    return !!a && a.idleMs >= UNATTENDED.idleMs;
  }

  /** Shuriken itself just made input (the display's wake): it is not the user coming back. */
  noteOwnInput(idleBefore: number): void {
    this.own = { at: Date.now(), idleBefore };
    this.last = null;
    if (IdleTracker.shared) {
      try {
        writeFileSync(IdleTracker.shared, JSON.stringify(this.own), 'utf8');
      } catch {
        /* the other windows then take it for the user's, as before */
      }
    }
  }

  /** Runs something that makes input as Shuriken (keys into a playtest, Ctrl+S) and notes it as its own. */
  async ownInput<T>(fn: () => Promise<T>): Promise<T> {
    const before = await this.activity().catch(() => null);
    try {
      return await fn();
    } finally {
      if (before) this.noteOwnInput(before.idleMs);
    }
  }
}

/** The C# behind the window work that needs more than one call on the same thread (Add-Type compiles it per script). */
const WIN_HELPER = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ShurikenWin {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  const uint KEEP = 0x13; // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE

  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  // Milliseconds since the last key or mouse input on this PC (a large number when it can't be told).
  public static uint IdleMs() {
    LASTINPUTINFO i = new LASTINPUTINFO();
    i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return 3600000;
    return GetTickCount() - i.dwTime;
  }
  public static uint ForegroundPid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }

  // Brings a window to the foreground. Windows refuses that to a background process unless it shares the input
  // state of the thread that owns the foreground: attached for the length of the call.
  public static bool Front(long target) {
    IntPtr h = new IntPtr(target);
    if (!IsWindow(h)) return false;
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint pid;
    uint other = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    bool attached = other != 0 && other != me && AttachThreadInput(me, other, true);
    if (IsIconic(h)) ShowWindow(h, 9);
    SetForegroundWindow(h);
    BringWindowToTop(h);
    if (attached) AttachThreadInput(me, other, false);
    return GetForegroundWindow() == h;
  }

  // Puts a window above the others WITHOUT activating it (focus stays where it is). Answers "<the window that was
  // above it> <1 when it was minimized>", for Lower.
  public static string Raise(long target) {
    IntPtr h = new IntPtr(target);
    long above = GetWindow(h, 3).ToInt64();
    bool min = IsIconic(h);
    if (min) ShowWindow(h, 4);
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, KEEP);
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, KEEP);
    return above + " " + (min ? 1 : 0);
  }

  // Puts it back: under the window that was above it; one that was minimized goes behind every window (it keeps drawing there).
  public static void Lower(long target, long above, bool wasMin) {
    IntPtr h = new IntPtr(target);
    if (!IsWindow(h)) return;
    IntPtr a = new IntPtr(above);
    if (wasMin || above == 0 || !IsWindow(a)) { if (wasMin) SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, KEEP); return; }
    SetWindowPos(h, a, 0, 0, 0, 0, KEEP);
  }

  static uint PidOf(long hWnd) { uint pid; GetWindowThreadProcessId(new IntPtr(hWnd), out pid); return pid; }
  static bool KeyDown(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }

  // The focus guard's orders ("ARM <ms>" lines), read from its input on a thread of their own: Console.In's
  // ReadLineAsync blocks in .NET Framework, and the guard's loop must keep looking at the foreground meanwhile.
  static volatile int armUntil = 0, arms = 0, openSince = 0, openUntil = 0;
  static volatile bool inputClosed = false, playing = false;
  public static void Listen() {
    System.Threading.Thread t = new System.Threading.Thread(delegate () {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          int ms;
          if (line.StartsWith("ARM ") && int.TryParse(line.Substring(4), out ms)) { armUntil = Environment.TickCount + ms; arms = arms + 1; }
          else if (line == "PLAY 1") { playing = true; arms = arms + 1; }
          else if (line == "PLAY 0") { playing = false; }
          else if (line.StartsWith("OPEN ") && int.TryParse(line.Substring(5), out ms)) { openSince = Environment.TickCount; openUntil = openSince + ms; openUser = 0; }
        }
      } catch { }
      inputClosed = true;
    });
    t.IsBackground = true;
    t.Start();
  }
  public static int Arms() { return arms; }
  public static bool Armed() { return unchecked(armUntil - Environment.TickCount) > 0; }
  public static bool InputClosed() { return inputClosed; }

  // The focus guard's state (StudioFocusGuard): the window the user is in, and their last mouse press.
  static long userWindow = 0, pressedOn = 0;
  static int pressedAt = 0;
  static bool buttonDown = false, pressedOnce = false;

  // One look of the focus guard: follows the window the user is in (any window not of the target's Studio process)
  // and, while armed, gives the foreground back to it when the target's Studio took it. A switch the user made (a
  // press on a window of another program than theirs a moment before, Alt or the Windows key down) is theirs.
  // Answers what it did ("" for nothing).
  public static string GuardStep(long target, bool armed) {
    bool down = KeyDown(1) || KeyDown(2) || KeyDown(4);
    if (down && !buttonDown) {
      POINT p;
      GetCursorPos(out p);
      pressedOn = GetAncestor(WindowFromPoint(p), 2).ToInt64();
      pressedAt = Environment.TickCount;
      pressedOnce = true;
    }
    buttonDown = down;
    long fg = Foreground();
    if (fg == 0) return "";
    uint studio = target == 0 ? 0 : PidOf(target);
    if (studio == 0 || PidOf(fg) != studio) { userWindow = fg; return ""; }
    if (userWindow == 0 || PidOf(userWindow) == studio) return "";
    long back = userWindow;
    bool chosen = KeyDown(0x12) || KeyDown(0x5B) || KeyDown(0x5C) || (pressedOnce && unchecked(Environment.TickCount - pressedAt) < 1000 && PidOf(pressedOn) != PidOf(back));
    if (!armed || chosen || !IsWindow(new IntPtr(back))) { userWindow = fg; return armed && chosen ? "USER" : ""; }
    string name = "?";
    try { name = System.Diagnostics.Process.GetProcessById((int)PidOf(back)).ProcessName; } catch { }
    if (Front(back)) return "GAVEBACK " + name;
    userWindow = fg; // Windows refused: not tried again for this switch
    return "REFUSED " + name;
  }

  public static bool AnyButtonDown() { return KeyDown(1) || KeyDown(2) || KeyDown(4); }
  public static uint StudioPid(long target) { return target == 0 ? 0 : PidOf(target); }

  // While an agent's playtest runs (PLAY 1): the game may lock the mouse (a shoulder or first-person camera), and Studio
  // applies that lock to the user's real cursor even when its window is behind others. "FREE 1" (the core then tells
  // the playtest to let go) while the user is at the PC (input within idleLimit) in a window that isn't this Studio's;
  // "FREE 0" otherwise (away, the agents' mouse-look checks work as the game means). Answers a change only.
  static int lastFree = -1;
  public static string FreeStep(long target, uint idleLimit) {
    uint studio = StudioPid(target);
    int free = playing && studio != 0 && ForegroundPid() != studio && IdleMs() < idleLimit ? 1 : 0;
    if (free == lastFree) return "";
    lastFree = free;
    return "FREE " + free;
  }

  // Whether this Studio's sound should be off now: an agent's playtest runs and this Studio isn't the window in front.
  public static bool WantMute(long target) {
    uint studio = StudioPid(target);
    return playing && studio != 0 && ForegroundPid() != studio;
  }

  // While a Studio opens in the background (OPEN <ms>: a reopen after a crash, a build's own open), a Studio process
  // started since then that takes the foreground from the user's window gives it straight back and goes behind the
  // other windows. A switch the user made (a press on that Studio, Alt or the Windows key) is theirs, and ends it.
  static long openUser = 0;
  static uint openFresh = 0, openStale = 0;
  public static string OpenStep() {
    if (unchecked(openUntil - Environment.TickCount) <= 0) return "";
    long fg = Foreground();
    if (fg == 0) return "";
    uint pid = PidOf(fg);
    bool fresh = pid == openFresh;
    if (!fresh && pid != openStale) {
      try {
        System.Diagnostics.Process pr = System.Diagnostics.Process.GetProcessById((int)pid);
        double age = (DateTime.Now - pr.StartTime).TotalMilliseconds;
        fresh = pr.ProcessName == "RobloxStudioBeta" && age < unchecked(Environment.TickCount - openSince) + 5000;
      } catch { }
      if (fresh) openFresh = pid; else openStale = pid;
    }
    if (!fresh) { openUser = fg; return ""; }
    if (openUser == 0 || !IsWindow(new IntPtr(openUser))) return "";
    bool chosen = KeyDown(0x12) || KeyDown(0x5B) || KeyDown(0x5C) || (pressedOnce && unchecked(Environment.TickCount - pressedAt) < 1000 && PidOf(pressedOn) == pid);
    if (chosen) { openUser = 0; openUntil = Environment.TickCount; return "USER"; }
    if (!Front(openUser)) return "";
    SetWindowPos(new IntPtr(fg), new IntPtr(1), 0, 0, 0, 0, KEEP);
    return "GAVEBACK opened";
  }

  // A display that went to sleep draws nothing: a one-pixel mouse move and back wakes it, and the idle timer starts over.
  public static void Wake() {
    SetThreadExecutionState(0x00000002 | 0x00000001);
    mouse_event(1, 1, 0, 0, UIntPtr.Zero);
    mouse_event(1, -1, 0, 0, UIntPtr.Zero);
  }

  // Gives a window its place and size and puts it behind every other window, without activating it (a window that
  // was maximized or minimized is restored first: a minimized Studio draws nothing).
  public static void Tuck(long target, int x, int y, int w, int h) {
    IntPtr p = new IntPtr(target);
    if (!IsWindow(p)) return;
    ShowWindow(p, 4);
    SetWindowPos(p, new IntPtr(1), x, y, w, h, 0x0010);
  }

  // The titles of the other visible windows of a process (dialogs in front of its main window), separated by " | ".
  public static string Dialogs(uint pid, long main) {
    List<string> found = new List<string>();
    EnumWindows(delegate (IntPtr w, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(w, out p);
      if (p != pid || w.ToInt64() == main || !IsWindowVisible(w)) return true;
      StringBuilder sb = new StringBuilder(200);
      GetWindowText(w, sb, 200);
      string t = sb.ToString().Trim();
      if (t.Length > 0 && !found.Contains(t)) found.Add(t);
      return true;
    }, IntPtr.Zero);
    return string.Join(" | ", found.ToArray());
  }
}
'@
`;

/** The sound helper's source, for the test that compiles it. */
export const AUDIO_HELPER_SOURCE = (): string => AUDIO_HELPER;

/** The C# helper's source, for the test that compiles it. */
export const WIN_HELPER_SOURCE = WIN_HELPER;

/** The memory (MB) the Studio process that has this place file open is using; 0 when there is none or it can't be told. */
export async function studioMemoryMb(placeFileName: string): Promise<number> {
  if (process.platform !== 'win32' || !placeFileName) return 0;
  const out = await powershell(`$p = Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${likeQuoted(placeFileName)} - Roblox Studio' } | Select-Object -First 1
if ($p) { Write-Output "MB $([int]($p.WorkingSet64 / 1MB))" } else { Write-Output 'MB 0' }`);
  return Number(/^MB (\d+)/m.exec(out)?.[1] ?? 0);
}

/** The window that is in front right now, as a handle to give back to tuckStudioWindow ('' when it can't be told). */
export async function foregroundWindow(): Promise<string> {
  if (process.platform !== 'win32') return '';
  const out = await powershell(`
${WIN_HELPER}
Write-Output "FG $([ShurikenWin]::Foreground())"
`);
  return /^FG (-?\d+)/m.exec(out)?.[1] ?? '';
}

/**
 * A play window (a copy of the place that only runs playtests) goes to the bottom right of the screen, at the given
 * size, behind every other window and without the focus; the window that was in front before it opened (`previous`,
 * from foregroundWindow) is put in front again when the new Studio took its place. Nothing is minimized: a minimized
 * Studio draws nothing. Only a window titled with exactly this place file is touched. Windows only.
 */
export async function tuckStudioWindow(placeFileName: string, width: number, height: number, previous: string | null): Promise<'tucked' | 'nowindow' | 'error'> {
  if (studioForbidden()) return 'nowindow';
  if (process.platform !== 'win32' || !placeFileName) return 'error';
  const prev = previous && /^-?\d+$/.test(previous) && previous !== '0' ? previous : null;
  const out = await powershell(`
${WIN_HELPER}
Add-Type -AssemblyName System.Windows.Forms
$p = Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${likeQuoted(placeFileName)} - Roblox Studio' } | Select-Object -First 1
if (-not $p) { Write-Output 'NOWINDOW'; exit 0 }
$h = $p.MainWindowHandle.ToInt64()
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = [Math]::Min(${Math.round(width)}, $wa.Width)
$hh = [Math]::Min(${Math.round(height)}, $wa.Height)
[ShurikenWin]::Tuck($h, $wa.Right - $w, $wa.Bottom - $hh, $w, $hh)
${prev ? `if ([ShurikenWin]::Foreground() -eq $h) { $null = [ShurikenWin]::Front(${prev}) }` : ''}
Write-Output 'TUCKED'
`);
  return out.includes('TUCKED') ? 'tucked' : out.includes('NOWINDOW') ? 'nowindow' : 'error';
}

/** A Studio window that was raised for a capture, and how to put it back. */
export interface RaisedWindow {
  hwnd: string;
  /** The window that was right above it (0: it was on top already). */
  above: string;
  wasMinimized: boolean;
}

/**
 * Nobody is at the PC (the caller checked): puts the Studio window that has the place open above the other windows
 * without activating it, so nothing covers its viewport while it is captured, and with `wake` wakes a sleeping
 * display first. Returns what lowerStudioWindow needs to put it back; null when there is no such window (or not
 * on Windows).
 */
export async function raiseStudioWindow(titleNeedle: string, wake: boolean): Promise<RaisedWindow | null> {
  if (studioForbidden()) return null;
  if (process.platform !== 'win32' || !titleNeedle) return null;
  const script = `
$ErrorActionPreference = 'Stop'
${WIN_HELPER}
${findStudioWindow(titleNeedle)}
if (-not $p) { Write-Output 'NOWINDOW'; exit 0 }
${wake ? '[ShurikenWin]::Wake()' : ''}
$h = $p.MainWindowHandle.ToInt64()
Write-Output "RAISED $h $([ShurikenWin]::Raise($h))"
`;
  const m = /^RAISED (-?\d+) (-?\d+) ([01])/.exec(await powershell(script));
  return m ? { hwnd: m[1]!, above: m[2]!, wasMinimized: m[3] === '1' } : null;
}

/** Puts a raised Studio window back where it was in the stack of windows (focus was never touched). */
export async function lowerStudioWindow(r: RaisedWindow): Promise<void> {
  if (process.platform !== 'win32' || !/^-?\d+$/.test(r.hwnd) || !/^-?\d+$/.test(r.above)) return;
  await powershell(`
${WIN_HELPER}
[ShurikenWin]::Lower(${r.hwnd}, ${r.above}, $${r.wasMinimized ? 'true' : 'false'})
`);
}

/**
 * The focus guard around a start or stop of play: armed for the start or stop itself, then for `settleMs` after
 * Studio answered (it took the foreground up to 2 s after the request). `pollMs`: how often the guard looks at the
 * foreground. `readyMs`: how long its PowerShell may take to start (about 1.2 s). `retryMs`: after it failed to
 * start, how long it is not tried again. An object so a test can change it.
 */
export const FOCUS_GUARD = { settleMs: 3000, pollMs: 30, readyMs: 8000, retryMs: 10 * 60_000, muteEvery: 30 };

/**
 * Windows' per-program sound (Core Audio sessions): an agent's playtest is silent while its Studio isn't the window in
 * front (FOCUS_GUARD.muteEvery: re-applied about once a second, because a session exists only once the program plays
 * something). Only the focus guard's PowerShell compiles it. A Studio it muted is unmuted when the playtest ends, when
 * the user brings that Studio to the front, and when the guard ends.
 */
const AUDIO_HELPER = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class ShurikenMMDeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShurikenDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IShurikenDevice endpoint);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShurikenDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShurikenSessionManager2 {
  int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr control);
  int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr volume);
  int GetSessionEnumerator(out IShurikenSessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShurikenSessionEnumerator {
  int GetCount(out int count);
  int GetSession(int index, out IShurikenSessionControl2 session);
}
[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShurikenSessionControl2 {
  int GetState(out int state);
  int GetDisplayName(out IntPtr name);
  int SetDisplayName(IntPtr value, IntPtr context);
  int GetIconPath(out IntPtr path);
  int SetIconPath(IntPtr value, IntPtr context);
  int GetGroupingParam(out Guid param);
  int SetGroupingParam(IntPtr param, IntPtr context);
  int RegisterAudioSessionNotification(IntPtr client);
  int UnregisterAudioSessionNotification(IntPtr client);
  int GetSessionIdentifier(out IntPtr id);
  int GetSessionInstanceIdentifier(out IntPtr id);
  int GetProcessId(out uint pid);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShurikenSimpleVolume {
  int SetMasterVolume(float level, IntPtr context);
  int GetMasterVolume(out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
public static class ShurikenAudio {
  // Mutes or unmutes every sound session of a process on the default output; answers how many sessions it touched.
  public static int SetMute(uint pid, bool mute) {
    if (pid == 0) return 0;
    int touched = 0;
    IShurikenDeviceEnumerator devices = (IShurikenDeviceEnumerator)(new ShurikenMMDeviceEnumerator());
    IShurikenDevice device;
    if (devices.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) return 0;
    Guid iid = typeof(IShurikenSessionManager2).GUID;
    object o;
    if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return 0;
    IShurikenSessionManager2 manager = (IShurikenSessionManager2)o;
    IShurikenSessionEnumerator sessions;
    if (manager.GetSessionEnumerator(out sessions) != 0) return 0;
    int count;
    sessions.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IShurikenSessionControl2 s;
      if (sessions.GetSession(i, out s) != 0 || s == null) continue;
      uint p;
      if (s.GetProcessId(out p) != 0 || p != pid) continue;
      IShurikenSimpleVolume v = s as IShurikenSimpleVolume;
      if (v != null && v.SetMute(mute, IntPtr.Zero) == 0) touched++;
    }
    return touched;
  }
  // Whether a process's sessions on the default output are muted: 1 all, 0 not all, -1 it has none (for checks).
  public static int IsMuted(uint pid) {
    IShurikenDeviceEnumerator devices = (IShurikenDeviceEnumerator)(new ShurikenMMDeviceEnumerator());
    IShurikenDevice device;
    if (devices.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) return -1;
    Guid iid = typeof(IShurikenSessionManager2).GUID;
    object o;
    if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return -1;
    IShurikenSessionEnumerator sessions;
    if (((IShurikenSessionManager2)o).GetSessionEnumerator(out sessions) != 0) return -1;
    int count, found = 0, muted = 0;
    sessions.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IShurikenSessionControl2 s;
      if (sessions.GetSession(i, out s) != 0 || s == null) continue;
      uint p;
      if (s.GetProcessId(out p) != 0 || p != pid) continue;
      found++;
      IShurikenSimpleVolume v = s as IShurikenSimpleVolume;
      bool m;
      if (v != null && v.GetMute(out m) == 0 && m) muted++;
    }
    return found == 0 ? -1 : muted == found ? 1 : 0;
  }
}
'@
`;

/**
 * Studio brings its own window to the foreground when play starts or stops. Measured on 2026-10-26 with three
 * builds open: six of six starts and stops agents asked for in one project's Studio took the foreground from the
 * user, who was playtesting another project in their own Studio, 0.2 to 2 s after the request. A game that locks
 * the mouse (MouseBehavior.LockCenter: a shoulder camera, first person) then pins the user's cursor to the middle
 * of that Studio's viewport, and a camera drag the user was making in their own game is cut off.
 *
 * One hidden PowerShell per place window that always knows which window the user is in. While it is armed (`arm`),
 * each time this place's Studio takes the foreground from that window, it is given straight back. A switch the user
 * made (a press on another program's window a moment before, Alt or the Windows key down) is left alone. It starts
 * on the first order (about a second, once), and ends with Shuriken (its input closes) or with `close`.
 *
 * 1.16.1, builds stay out of the way of the user's own work: while an agent's playtest runs (`play`),
 * it says when the playtest must let go of the mouse ("FREE 1": the user is at the PC, in another window) and keeps
 * that Studio silent while it isn't the window in front; while a place opens in the background (`opening`), a new
 * Studio that comes to the front is sent behind again.
 */
export class StudioFocusGuard {
  private ps: ChildProcessWithoutNullStreams | null = null;
  private needle = '';
  private ready: Promise<boolean> = Promise.resolve(false);
  private failedAt = 0;

  /** `onEvent` hears what the guard did: "GAVEBACK <program>", "REFUSED <program>", "USER", "NOWINDOW", "FREE 1|0". */
  constructor(private readonly onEvent: (what: string) => void = () => undefined) {}

  /** Arms the guard for the place window `titleNeedle` for `ms` from now (replacing what was left). False when it can't run. */
  async arm(titleNeedle: string, ms: number): Promise<boolean> {
    if (studioForbidden() || process.platform !== 'win32' || !titleNeedle) return false;
    if (!this.ps || this.needle !== titleNeedle) {
      if (Date.now() - this.failedAt < FOCUS_GUARD.retryMs) return false;
      this.start(titleNeedle);
    }
    const ps = this.ps;
    if (!ps || !(await this.ready)) return false;
    try {
      ps.stdin.write(`ARM ${Math.max(0, Math.round(ms))}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** An agent's playtest of this place window came up (or ended): the mouse and the sound follow the user (FreeStep, WantMute). */
  async play(titleNeedle: string, on: boolean): Promise<boolean> {
    return this.order(titleNeedle, `PLAY ${on ? 1 : 0}`);
  }

  /** This place is being opened in the background for `ms`: a new Studio that takes the foreground gives it back (OpenStep). */
  async opening(titleNeedle: string, ms: number): Promise<boolean> {
    return this.order(titleNeedle, `OPEN ${Math.max(0, Math.round(ms))}`);
  }

  private async order(titleNeedle: string, line: string): Promise<boolean> {
    if (studioForbidden() || process.platform !== 'win32' || !titleNeedle) return false;
    if (!this.ps || this.needle !== titleNeedle) {
      if (Date.now() - this.failedAt < FOCUS_GUARD.retryMs) return false;
      this.start(titleNeedle);
    }
    const ps = this.ps;
    if (!ps || !(await this.ready)) return false;
    try {
      ps.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    const ps = this.ps;
    this.ps = null;
    if (!ps) return;
    try {
      // Its input closing ends its loop, which unmutes a Studio it muted; killed only if it hasn't gone a moment later.
      ps.stdin.end();
      setTimeout(() => {
        try {
          ps.kill();
        } catch {
          /* gone already */
        }
      }, 3000).unref?.();
    } catch {
      /* gone already */
    }
  }

  private start(titleNeedle: string): void {
    this.close();
    this.needle = titleNeedle;
    // Each ARM finds the window again (Studio may have been reopened since). The loop never waits on its input.
    const script = `
$ErrorActionPreference = 'Stop'
${WIN_HELPER}
$audio = $true
try { ${AUDIO_HELPER} } catch { $audio = $false }
[ShurikenWin]::Listen()
$h = 0
$seen = 0
$muted = 0
$tick = 0
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while (-not [ShurikenWin]::InputClosed()) {
  $n = [ShurikenWin]::Arms()
  if ($n -ne $seen) {
    $seen = $n
    ${findStudioWindow(titleNeedle)}
    if ($p) { $h = $p.MainWindowHandle.ToInt64() } else { $h = 0; [Console]::Out.WriteLine('NOWINDOW'); [Console]::Out.Flush() }
  }
  $did = [ShurikenWin]::GuardStep($h, [ShurikenWin]::Armed())
  if ($did) { [Console]::Out.WriteLine($did); [Console]::Out.Flush() }
  $free = [ShurikenWin]::FreeStep($h, ${Math.round(UNATTENDED.idleMs)})
  if ($free) { [Console]::Out.WriteLine($free); [Console]::Out.Flush() }
  $opened = [ShurikenWin]::OpenStep()
  if ($opened) { [Console]::Out.WriteLine($opened); [Console]::Out.Flush() }
  $tick++
  if ($audio -and ($tick % ${Math.round(FOCUS_GUARD.muteEvery)}) -eq 0) {
    try {
      $sp = [ShurikenWin]::StudioPid($h)
      if ([ShurikenWin]::WantMute($h) -and $sp -ne 0) {
        if ($muted -ne 0 -and $muted -ne $sp) { $null = [ShurikenAudio]::SetMute($muted, $false) }
        $null = [ShurikenAudio]::SetMute($sp, $true); $muted = $sp
      } elseif ($muted -ne 0) { $null = [ShurikenAudio]::SetMute($muted, $false); $muted = 0 }
    } catch { }
  }
  Start-Sleep -Milliseconds ${Math.round(FOCUS_GUARD.pollMs)}
}
if ($muted -ne 0) { try { $null = [ShurikenAudio]::SetMute($muted, $false) } catch { } }
`;
    let ps: ChildProcessWithoutNullStreams;
    try {
      ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    } catch {
      this.failedAt = Date.now();
      this.ready = Promise.resolve(false);
      return;
    }
    this.ps = ps;
    // Shuriken may exit without closing it: its input closes then, and the loop ends.
    ps.unref();
    for (const s of [ps.stdin, ps.stdout, ps.stderr]) (s as unknown as { unref?: () => void }).unref?.();
    this.ready = new Promise<boolean>((resolve) => {
      let text = '';
      const timer = setTimeout(() => {
        this.failedAt = Date.now();
        resolve(false);
        if (this.ps === ps) this.close();
      }, FOCUS_GUARD.readyMs);
      timer.unref?.();
      ps.stdout.on('data', (d: Buffer) => {
        text += d.toString();
        for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n')) {
          const line = text.slice(0, i).trim();
          text = text.slice(i + 1);
          if (line === 'READY') {
            clearTimeout(timer);
            resolve(true);
          } else if (line) this.onEvent(line);
        }
      });
      ps.stderr.on('data', () => undefined);
      const gone = (): void => {
        clearTimeout(timer);
        resolve(false);
        if (this.ps === ps) {
          this.ps = null;
          this.failedAt = Date.now();
        }
      };
      ps.on('close', gone);
      ps.on('error', gone);
    });
  }
}

/**
 * The save through Studio's File menu: `pressMs` is how long the press may take (Studio saves on its own thread and
 * answers when the file is written: seconds for a big place), `afterMs` how long the file is watched after it,
 * `giveBackMs` how long after the press the window that was in front is put in front again. An object so a test
 * can shorten it.
 */
export const SAVE_MENU = { pressMs: 60_000, afterMs: 5000, giveBackMs: 150, pauseWaitMs: 12_000 };

/**
 * How long a save may take to reach the disk: Studio writes a big place for many seconds after it answers the press.
 * A 96 MB place was written about 5 s after the press, so every periodic save of a mech build was reported "did not
 * change" (twelve in a row) while the file changed the same second. 5 s plus 1 s per 4 MB, at most a minute.
 */
export function saveWaitMs(bytes: number, base = SAVE_MENU.afterMs): number {
  return Math.min(60_000, base + Math.ceil(bytes / (4 * 1024 * 1024)) * 1000);
}

/**
 * Saves pressed whose file hasn't changed yet, per place file. Studio refuses a save while one is being written and
 * says so in a dialog nobody answers ("Save File Failure: Another save in progress"): in the mech build a save took
 * 214 s (Studio frozen meanwhile) and two more presses landed on it. Until the file changes (or SAVE_PENDING_MS has
 * passed) no save is pressed again.
 */
const pendingSaves = new Map<string, { at: number; before: number }>();
export const SAVE_PENDING_MS = 10 * 60_000;

/** Whether a save pressed earlier is still on its way to the disk (the file hasn't changed since). */
export function savePending(placeFile: string, now = Date.now()): boolean {
  const p = pendingSaves.get(placeFile);
  if (!p) return false;
  const mtime = existsSync(placeFile) ? statSync(placeFile).mtimeMs : 0;
  if (mtime > p.before || now - p.at > SAVE_PENDING_MS) {
    pendingSaves.delete(placeFile);
    return false;
  }
  return true;
}

/** A save was pressed and the file hasn't changed yet: it may still be being written. */
export function notePendingSave(placeFile: string, before: number, at = Date.now()): void {
  pendingSaves.set(placeFile, { at, before });
}

export interface MenuPress {
  state: 'pressed' | 'nowindow' | 'disabled' | 'nomenu' | 'typing';
  /** What went wrong, when something did (for the log and the message). */
  note?: string;
  /** Studio's other visible windows after the press (dialogs), " | " between them. */
  dialogs?: string;
  /** How long Studio was the foreground window for the press (ms), when it could be told. */
  frontMs?: number;
  /** How many times the menu was asked to open. */
  tries?: number;
}

/**
 * Presses File > Save to File in the Studio window that has the place open, through the window's accessibility
 * interface (UI Automation), the way a screen reader would. Measured in Studio 0.741 (tests/e2e/save-menu.e2e.ts):
 * - The menu's entries exist only while the menu is open, and opening it makes Studio the foreground window, whoever
 *   asks and whatever is in front. So the menu is opened, "Save to File" is pressed, and the window that was in front
 *   is put back in front `giveBackMs` later: Studio has the focus for a fraction of a second, and never a key.
 * - No key is sent, so nothing can land in a game, a script or a dialog (Ctrl+S did: "S" walked a character
 *   backwards, and a dialog in front of the place swallowed the keys for hours).
 * - It does not depend on Windows letting a background process bring a window to the front, which it refused
 *   in every long build so far, sometimes for hours.
 * - During a playtest it saves the place being edited, not the running game, and the playtest plays on: a save needs
 *   no turn in Studio's line.
 * 'nomenu' when the window has no such entries (a Studio in another language): the caller falls back to the keys.
 * `minIdleMs`: the menu is only opened when nobody has typed or moved the mouse for that long (waited for up to
 * `SAVE_MENU.pauseWaitMs`; 'typing' when no such pause came): a key pressed while the menu is open would choose
 * one of its entries.
 */
export async function pressSaveInMenu(placeFileName: string, pressMs = SAVE_MENU.pressMs, minIdleMs = 0): Promise<MenuPress> {
  if (process.platform !== 'win32' || !placeFileName) return { state: 'nomenu', note: 'not on Windows' };
  if (studioForbidden()) return { state: 'nomenu', note: 'Studio is switched off for this run' };
  const script = `
$ErrorActionPreference = 'Stop'
${WIN_HELPER}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# Two windows with this place (one that hung, and the one opened after it): the one that answers, opened last.
$p = Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${likeQuoted(placeFileName)} - Roblox Studio' } | Sort-Object @{ Expression = { $_.Responding }; Descending = $true }, @{ Expression = { try { $_.StartTime } catch { [datetime]::MinValue } }; Descending = $true } | Select-Object -First 1
if (-not $p) { Write-Output 'NOWINDOW'; exit 0 }
$h = $p.MainWindowHandle.ToInt64()
$was = [ShurikenWin]::Foreground()
$AE = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]::Descendants
function Item([string]$name) {
  New-Object System.Windows.Automation.AndCondition((New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)), (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)))
}
function GiveBack { if ($was -ne 0 -and $was -ne $h -and [ShurikenWin]::ForegroundPid() -eq $p.Id) { $null = [ShurikenWin]::Front($was) } }
$out = 'NOMENU'
$note = ''
$ec = $null
$async = $null
$tries = 0
$front = [Diagnostics.Stopwatch]::new()
try {
  $root = $AE::FromHandle($p.MainWindowHandle)
  $menu = $root.FindFirst($scope, (Item 'File'))
  if ($menu) {
    $ec = $menu.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $quiet = $true
    if (${Math.round(minIdleMs)} -gt 0) {
      for ($w = 0; [ShurikenWin]::IdleMs() -lt ${Math.round(minIdleMs)} -or [ShurikenWin]::AnyButtonDown(); $w += 200) {
        if ($w -ge ${Math.round(SAVE_MENU.pauseWaitMs)}) { $quiet = $false; break }
        Start-Sleep -Milliseconds 200
      }
    }
    if (-not $quiet) { Write-Output 'TYPING'; exit 0 }
    $was = [ShurikenWin]::Foreground()
    $front.Start()
    $save = $null
    # The menu sometimes does not open at the first request (one that was closed a moment ago): asked up to three
    # times. Its entries hang under the menu's own entry, and are looked for only there: a search of the whole
    # window takes a second in an empty place, with the menu open and the focus in Studio all the while.
    for ($try = 1; $try -le 3 -and -not $save; $try++) {
      if ($try -gt 1) { try { $ec.Collapse() } catch { }; Start-Sleep -Milliseconds 200 }
      $ec.Expand()
      for ($i = 0; $i -lt 24 -and -not $save; $i++) {
        Start-Sleep -Milliseconds 15
        $save = $menu.FindFirst($scope, (Item 'Save to File'))
      }
      $tries = $try
    }
    if (-not $save) { $note = 'the File menu has no Save to File' }
    elseif (-not $save.Current.IsEnabled) { $out = 'DISABLED' }
    else {
      # Studio saves on its own thread and answers the press when the file is written: pressed from a second thread,
      # so the window that was in front has the focus back long before that.
      $ps = [powershell]::Create()
      $null = $ps.AddScript({ param($el) $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }).AddArgument($save)
      $async = $ps.BeginInvoke()
      $null = $async.AsyncWaitHandle.WaitOne(${Math.round(SAVE_MENU.giveBackMs)})
      $out = 'PRESSED'
    }
  } else { $note = 'no File menu' }
} catch { $note = $_.Exception.Message }
GiveBack
$front.Stop()
if ($async) {
  if ($async.AsyncWaitHandle.WaitOne(${Math.round(pressMs)})) { try { $null = $ps.EndInvoke($async); if ($ps.Streams.Error.Count) { $note = [string]$ps.Streams.Error[0] } } catch { $note = $_.Exception.Message } }
  else { $note = 'Studio has not answered the press yet' }
}
# A menu that is still open is closed (it closes by itself when its entry is clicked, not when it is pressed this way).
if ($ec) { try { if ($ec.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $ec.Collapse() } } catch { } }
GiveBack
Write-Output "$out|$([ShurikenWin]::Dialogs($p.Id, $h))|$($front.ElapsedMilliseconds)|$($note -replace '[\\r\\n|]+', ' ')|$tries"
`;
  const out = await powershell(script);
  const line = out.split(/\r?\n/).find((l) => /^(PRESSED|DISABLED|NOMENU|NOWINDOW|TYPING)/.test(l)) ?? '';
  if (line.startsWith('NOWINDOW')) return { state: 'nowindow' };
  if (line.startsWith('TYPING')) return { state: 'typing' };
  const [head, dialogs, front, note, opened] = line.split('|');
  const frontMs = Number(front) > 0 ? Number(front) : undefined;
  const tries = Number(opened) > 0 ? Number(opened) : undefined;
  if (head === 'PRESSED') return { state: 'pressed', dialogs: dialogs?.trim() || undefined, note: note?.trim() || undefined, frontMs, tries };
  if (head === 'DISABLED') return { state: 'disabled', frontMs, tries };
  return { state: 'nomenu', note: (note?.trim() || out.slice(0, 300)).trim(), tries };
}

/**
 * Studio's MCP server has no save command, so saving the place normally needs a human. This performs
 * exactly that human action on request: focus the Studio window that has the place open and press
 * Ctrl+S. Guard rails: the window is found by the place file in its title (Studio titles local places
 * "<full path> - Roblox Studio"), keys are sent only if that window is really in the foreground, and
 * the result is confirmed by the file's modification time. Windows only.
 *
 * `unattended` (nobody has touched the PC for a few minutes: the caller checked) changes two things. Studio is
 * brought to the foreground the way Windows allows a background process to do it (sharing the input state of the
 * foreground thread for the length of the call), where a plain request is often refused; and afterwards the
 * window that was in front is put back in front. With someone at the PC neither is done: their focus is theirs.
 * A save whose keys went out but changed nothing names the dialogs Studio shows (an auto-recovery prompt after a
 * crash swallowed Ctrl+S for five hours in one build).
 */
export async function saveStudioPlace(placeFile: string, timeoutMs = 15_000, opts: { unattended?: boolean; via?: 'auto' | 'menu' | 'keys'; minIdleMs?: number } = {}): Promise<SavePlaceResult> {
  if (process.platform !== 'win32') return { ok: false, message: 'Saving through Studio is only supported on Windows.' };
  if (studioForbidden()) return { ok: false, message: 'Studio is switched off for this run (SHURIKEN_NO_STUDIO=1)' };
  if (!existsSync(placeFile)) return { ok: false, message: `Place file not found: ${placeFile}` };
  const before = statSync(placeFile).mtimeMs;
  const needle = basename(placeFile);
  if (savePending(placeFile)) return { ok: false, waiting: true, message: `Waiting: Studio is still writing the last save of ${needle} (a big place can take minutes); pressing again now would make it refuse in a dialog.` };
  let menuNote: string | undefined;
  if (opts.via !== 'keys') {
    // Through the File menu first: it needs no keys and gives the focus back at once (see pressSaveInMenu).
    const menu = await pressSaveInMenu(needle, Math.max(timeoutMs, SAVE_MENU.pressMs), opts.minIdleMs ?? 0);
    if (menu.state === 'nowindow') return { ok: false, noWindow: true, message: `No Studio window has ${needle} open.` };
    if (menu.state === 'disabled') return { ok: false, waiting: true, message: `Waiting: Studio has "Save to File" switched off for ${needle} right now; the save is tried again in a moment.` };
    if (menu.state === 'typing') return { ok: false, waiting: true, message: 'Waiting: for a pause in your typing (the save opens a menu in Studio for a moment).' };
    if (menu.state === 'pressed') {
      let saved: number | null = null;
      const deadline = Date.now() + saveWaitMs(statSync(placeFile).size);
      for (;;) {
        const now = statSync(placeFile).mtimeMs;
        if (now > before) saved = now;
        if (saved !== null || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (saved !== null) return { ok: true, message: `Saved ${needle}.`, savedAt: new Date(saved).toISOString(), how: 'menu' };
      // Not on the disk yet: it may still be being written. No press until it is (or a while has passed).
      notePendingSave(placeFile, before);
      const dialogs = menu.dialogs;
      return {
        ok: false,
        message: dialogs
          ? `File > Save to File was pressed in Studio but ${needle} did not change: Studio shows ${dialogs.includes(' | ') ? 'dialogs' : 'a dialog'} ("${dialogs.slice(0, 200)}"). Answer it in Studio; saves work again after that.`
          : `File > Save to File was pressed in Studio but ${needle} did not change${menu.note ? ` (${menu.note.slice(0, 160)})` : ''}. Check Studio for a dialog.`,
      };
    }
    // No such menu (a Studio in another language, a changed menu): the keys, as before.
    menuNote = menu.note ?? 'no File menu';
    if (opts.via === 'menu') return { ok: false, noMenu: true, menuNote, message: `Studio's File menu could not be used (${menuNote.slice(0, 160)}).` };
  }
  // The needle is a file name; escape it for a single-quoted PowerShell string and -like wildcards.
  const quoted = likeQuoted(needle);
  const script = `
$ErrorActionPreference = 'Stop'
${WIN_HELPER}
$p = Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${quoted} - Roblox Studio' } | Sort-Object @{ Expression = { $_.Responding }; Descending = $true }, @{ Expression = { try { $_.StartTime } catch { [datetime]::MinValue } }; Descending = $true } | Select-Object -First 1
if (-not $p) { Write-Output 'NOWINDOW'; exit 0 }
$h = $p.MainWindowHandle.ToInt64()
$was = [ShurikenWin]::Foreground()
$w = New-Object -ComObject WScript.Shell
$front = $false
# Windows sometimes refuses the first request to bring a window forward: ask up to three times before giving up.
for ($try = 0; $try -lt 3; $try++) {
  ${opts.unattended ? '$null = [ShurikenWin]::Front($h)' : '$null = $w.AppActivate($p.Id)'}
  Start-Sleep -Milliseconds 600
  if ([ShurikenWin]::ForegroundPid() -eq $p.Id) { $front = $true; break }
}
if (-not $front) { Write-Output "NOTFOREGROUND"; exit 0 }
$w.SendKeys('^s')
Write-Output "SENT $($p.Id) $h $was"
`;
  const out = await powershell(script);
  if (out.startsWith('NOWINDOW')) return { ok: false, noWindow: true, message: `No Studio window has ${needle} open.` };
  if (out.startsWith('NOTFOREGROUND')) return { ok: false, focus: true, message: 'Windows did not bring the Studio window to the front, so no keys were sent. Save it in Studio with Ctrl+S.' };
  const sent = /^SENT (\d+) (-?\d+) (-?\d+)/.exec(out);
  if (!sent) return { ok: false, message: `Could not drive Studio: ${out.slice(0, 300)}` };
  const [, pid, hwnd, was] = sent as unknown as [string, string, string, string];
  let saved: number | null = null;
  const deadline = Date.now() + Math.max(timeoutMs, saveWaitMs(statSync(placeFile).size, timeoutMs));
  while (Date.now() < deadline && saved === null) {
    await new Promise((r) => setTimeout(r, 400));
    const now = statSync(placeFile).mtimeMs;
    if (now > before) saved = now;
  }
  // Put the window that was in front back in front (only when nobody is there to mind the switching), and when the
  // keys changed nothing, look for what took them: a dialog of Studio's in front of the place.
  const after = await powershell(`
${WIN_HELPER}
${saved === null ? `Write-Output "DIALOGS $([ShurikenWin]::Dialogs(${pid}, ${hwnd}))"` : ''}
${opts.unattended && was !== hwnd && was !== '0' ? `$null = [ShurikenWin]::Front(${was})` : ''}
`).catch(() => '');
  if (saved !== null) return { ok: true, message: `Saved ${needle}.`, savedAt: new Date(saved).toISOString(), how: 'keys', menuNote };
  const dialogs = /^DIALOGS (.+)$/m.exec(after)?.[1]?.trim() ?? '';
  if (saved === null) notePendingSave(placeFile, before);
  return {
    ok: false,
    message: dialogs
      ? `Ctrl+S was sent to Studio but ${needle} did not change within ${Math.round(timeoutMs / 1000)} s: Studio shows ${dialogs.includes(' | ') ? 'dialogs' : 'a dialog'} that took the keys ("${dialogs.slice(0, 200)}"). Answer it in Studio; saves work again after that.`
      : `Ctrl+S was sent to Studio but ${needle} did not change within ${Math.round(timeoutMs / 1000)} s. Check Studio for a dialog.`,
  };
}
