import { useEffect } from 'react';
import { useCurrentProject } from './lib/project';
import { AnimatePresence, motion } from 'motion/react';
import { useCoreEvent, useCoreStatus } from './lib/rpc';
import { navigate, useRoute, type Page } from './lib/nav';
import { ShurikenMark } from './brand/logo';
import { StartPage } from './pages/start';
import { DashboardPage } from './pages/dashboard';
import { ViewerPage } from './pages/viewer';
import { AgentsPage } from './pages/agents';
import { SettingsPage } from './pages/settings';
import { ModelsPage } from './pages/models';
import { AudioPage } from './pages/audio';
import { AnimationPage } from './pages/animation';
import { UiPage } from './pages/ui';
import { StorefrontPage } from './pages/storefront';
import { ReferencesPage } from './pages/references';
import { VersionBadge } from './components/version-badge';
import { StripMenus } from './components/strip-menus';
import { KilnPage } from './pages/kiln';
import { OpenGameHost, openGameDialog } from './components/open-game';

const PAGES: Page[] = ['start', 'dashboard', 'viewer', 'agents', 'models', 'audio', 'animation', 'ui', 'kiln', 'storefront', 'references', 'settings'];

// Renderer errors go to the session journal (and the smoke report).
const errors: string[] = [];
window.__shurikenErrors = errors;
const benign = /ResizeObserver loop/;
window.addEventListener('error', (e) => {
  if (benign.test(e.message)) return;
  errors.push(e.message);
  window.shuriken.journal('error', { message: e.message, stack: e.error?.stack });
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (benign.test(msg)) return;
  errors.push(msg);
  window.shuriken.journal('error', { message: msg, stack: e.reason instanceof Error ? e.reason.stack : undefined });
});

export function App() {
  const status = useCoreStatus();
  const route = useRoute();
  // A build started from outside (CLI --prompt) jumps to the dashboard.
  useCoreEvent(['app.navigate'], (_c, p) => navigate(((p as { page?: Page }).page ?? 'dashboard') as Page));

  // Window shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+1…9, Ctrl+Shift+N) are handled by the main process.

  useEffect(() => {
    window.__shurikenViews = PAGES;
    // "page" or "page@item" (a page opened on one item, e.g. animation@SwordHit). Not ':' — Electron
    // refuses command lines where a URL-like argument ("animation:x") is followed by more switches.
    window.__shurikenOpenGame = openGameDialog;
    window.__shurikenSetView = (v: string) => {
      const [page, item] = v.split('@');
      navigate(page as Page, item || undefined);
    };
    window.shuriken.journal('app.open', { width: window.innerWidth, height: window.innerHeight });
  }, []);

  if (status.state !== 'ready') return <Booting state={status.state} detail={status.detail} />;

  return (
    <div className="h-full w-full overflow-hidden bg-bg">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={route.page === 'start' ? 'start' : 'app'}
          className="h-full w-full"
          initial={{ opacity: 0, scale: route.page === 'start' ? 1.02 : 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: route.page === 'start' ? 0.985 : 1.02, filter: 'blur(6px)' }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
          {route.page === 'start' ? <StartPage /> : <AppFrame page={route.page} id={route.id} />}
        </motion.div>
      </AnimatePresence>
      {/* The start page and the dashboard keep its corner free; on the other pages it covered a list's last row. */}
      {(route.page === 'start' || route.page === 'dashboard') && <VersionBadge />}
      {/* The bar's menus (Projects, the window's options) open here, right under the bar. */}
      <StripMenus />
      <OpenGameHost />
    </div>
  );
}

/** Dashboard and detail pages share the top bar; detail pages slide over the dashboard. */
function AppFrame({ page, id }: { page: Page; id?: string }) {
  const project = useCurrentProject();
  // Project pages need an open project; without one, the start page is where you pick or begin one.
  const orphan = project.data === null && !project.loading && page !== 'settings';
  useEffect(() => {
    if (orphan) navigate('start');
  }, [orphan]);
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={page}
        className="h-full w-full"
        initial={{ opacity: 0, y: page === 'dashboard' ? 0 : 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      >
        {page === 'dashboard' && <DashboardPage />}
        {page === 'viewer' && <ViewerPage selectedId={id} />}
        {page === 'agents' && <AgentsPage runId={id} />}
        {page === 'models' && <ModelsPage selectedId={id} />}
        {page === 'audio' && <AudioPage selectedId={id} />}
        {page === 'animation' && <AnimationPage selectedId={id} />}
        {page === 'ui' && <UiPage selectedId={id} />}
        {page === 'kiln' && <KilnPage project={id} />}
        {page === 'storefront' && <StorefrontPage tab={id} />}
        {page === 'references' && <ReferencesPage selectedId={id} />}
        {page === 'settings' && <SettingsPage section={id} />}
      </motion.div>
    </AnimatePresence>
  );
}

function Booting({ state, detail }: { state: string; detail?: string }) {
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-4 bg-bg">
      <ShurikenMark size={56} active={state !== 'failed'} />
      <div className="text-[13px] text-dim">{state === 'failed' ? 'Shuriken Studio could not start its engine' : state === 'restarting' ? 'Restarting…' : 'Starting Shuriken Studio…'}</div>
      {detail && <div className="max-w-md text-center text-[12px] text-faint">{detail}</div>}
    </div>
  );
}
