export interface CoreStatus {
  state: 'starting' | 'ready' | 'restarting' | 'failed';
  detail?: string;
  mcpUrl?: string;
}

/** A project window docked in an app window's bar: a project (or a start page) with its own engine. */
export interface TabInfo {
  id: number;
  title: string;
  /** Its agents are working. */
  busy: boolean;
  /** Its light: needs the user's answer, agents working, paused, idle; 'start' is a start page. */
  state: 'input' | 'working' | 'paused' | 'idle' | 'start';
  /** The light in words ("2 agents working", "Needs your answer"). */
  detail: string;
  active: boolean;
}

/** An app window's bar: its project windows, whether it is the main app window, and how many others there are. */
export interface StripState {
  tabs: TabInfo[];
  main: boolean;
  others: number;
}

/** A bar menu, opened in the page below the bar ('none' closes it). */
export interface StripMenu {
  kind: 'projects' | 'window' | 'none';
  /** Where the clicked window sits on the bar (px from the left). */
  x: number;
  /** The project window in front (the one the menu is for). */
  id: number;
  title: string;
  canDetach: boolean;
  canDock: boolean;
  main: boolean;
}

export interface ShurikenBridge {
  invoke<T = unknown>(method: string, params?: unknown): Promise<T>;
  on(listener: (channel: string, payload: unknown) => void): () => void;
  onStatus(listener: (s: CoreStatus) => void): () => void;
  status(): Promise<CoreStatus>;
  openDirectory(title?: string): Promise<string | null>;
  /** Pick a Roblox place file (.rbxl/.rbxlx); null when cancelled. */
  openPlaceFile(): Promise<string | null>;
  openPath(p: string): Promise<string>;
  /** Saves a copy of a file where the user picks (a save dialog); the chosen path, or null when cancelled. */
  saveFileAs(source: string, suggestedName: string): Promise<string | null>;
  showItem(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  readImage(p: string): Promise<string | null>;
  secrets: {
    set(key: string, value: string): Promise<boolean>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    /** Keeps a saved secret under another name too (still encrypted; the value never reaches the renderer). */
    copy(from: string, to: string): Promise<boolean>;
  };
  updates: {
    status(): Promise<{ state: string; detail: string; version?: string }>;
    check(): Promise<{ state: string; detail: string; version?: string }>;
    install(): Promise<void>;
  };
  /** Absolute path of a dropped file/folder (Electron removed File.path; this uses webUtils). */
  pathForFile(file: File): string | null;
  platform: string;
  /** Records an event in this session's journal (see docs/SESSIONS.md). */
  journal(kind: string, data?: unknown): void;
  /** Folder of the current session's journal. */
  journalDir(): Promise<string | null>;
  /** Moves a deleted project's folder to the Recycle Bin (only a Shuriken project folder). */
  trashProject(path: string): Promise<{ ok: boolean; error?: string }>;
  /** Every project window runs its own engine and project. */
  windows: {
    /** Open a new project window (with a project, or on the start page). If that project is already open in another one, that one comes to the front instead. */
    open(projectId?: string | null): Promise<{ focused: boolean }>;
    /** "Open blank": a new project straight into its workspace, nothing started (here on a start page, otherwise in a new project window). */
    blank(): Promise<{ name?: string }>;
    /**
     * "Open a game…": plug in a game Shuriken didn't build (a place open in Studio, by its name there, or
     * a place file) — here on a start page, otherwise in a new project window. A place plugged in before
     * reopens its project.
     */
    adopt(game: { studio?: string; file?: string; roblox?: { groupId?: string | null; userId?: string | null } }): Promise<{ name?: string; id?: string; here: boolean; error?: string }>;
    /** Projects open in the app's project windows, and whether they are this one's. */
    projects(): Promise<Array<{ projectId: string; mine: boolean }>>;
  };
  /** Kiln docked in this project window (main/kiln-dock.ts). */
  kiln: {
    /** The Kiln page is showing (its area for Kiln's view, in page coordinates) or not. */
    page(state: KilnPageState): void;
    /** Undocks Kiln into its own window, or docks it back. */
    toggleDock(): void;
    /** The Kiln.exe Shuriken would start (Settings path, else the Desktop shortcut's target), and whether Kiln runs. */
    locate(configured?: string): Promise<{ exe: string | null; running: boolean; version: string | null }>;
    onStatus(listener: (s: KilnStatus) => void): () => void;
  };
  /** The bar along the top of an app window, with its project windows. */
  tabs: {
    list(): Promise<StripState>;
    select(id: number): Promise<void>;
    close(id: number): Promise<void>;
    create(): Promise<{ focused: boolean }>;
    /** Moves a project window along its own bar (index among the others). */
    move(id: number, index: number): Promise<void>;
    /** A project window let go off its bar, at a point relative to this bar's page (it may lie far outside it): docks on the bar there, or gets an app window of its own. */
    drop(id: number, x: number, y: number): Promise<void>;
    /** Pulls a project window out into an app window of its own. */
    detach(id: number): Promise<void>;
    /** Docks a pulled-out project window back into the main app window. */
    dock(id: number): Promise<void>;
    /** Opens (or closes, 'none') a bar menu in the page below the bar. */
    menu(m: { kind: 'projects' | 'window' | 'none'; x?: number }): void;
    onChanged(listener: (s: StripState) => void): () => void;
    /** In a project window's page: a bar menu to show. */
    onMenu(listener: (m: StripMenu) => void): () => void;
  };
}

declare global {
  interface Window {
    shuriken: ShurikenBridge;
    __shurikenViews?: string[];
    __shurikenSetView?: (v: string) => void;
    __shurikenErrors?: string[];
    /** Opens the "Open a game" dialog (smoke runs photograph it). */
    __shurikenOpenGame?: () => void;
  }
}

/** Kiln docked in a project window: its state, as the Kiln page shows it. */
export interface KilnStatus {
  state: 'connecting' | 'ready' | 'unavailable' | 'undocked';
  detail?: string;
}

export interface KilnPageState {
  shown: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  /** A menu or dialog of Shuriken's is open over the page: the native view steps aside meanwhile. */
  covered?: boolean;
  /** The Kiln project to show (Watch in Kiln). */
  project?: string | null;
}
