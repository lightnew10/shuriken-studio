import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { TabStrip } from './components/tab-strip';
import { KilnWindowHeader } from './pages/kiln';
import { installRenderSheet } from './render-sheet';
import { installMediaPage } from './media-page';
import { watchAppearance } from './lib/appearance';

// An app window's own page is the bar along the top (?strip); every project window below it is the app (?tab).
const params = new URLSearchParams(location.search);
if (params.has('tab')) document.documentElement.dataset.tab = '1';
// The colour theme every window shares (and follows when another window changes it), before anything draws.
watchAppearance();

// The hidden render page (?render) draws pictures of models for agents; it shows nothing itself.
if (params.has('render')) installRenderSheet();
// The hidden media page (?media) decodes reference videos and pictures for the core; it shows nothing itself.
else if (params.has('media')) installMediaPage();
// Kiln's own window (undocked) shows Shuriken's slim header above Kiln's view (?kiln-window).
else createRoot(document.getElementById('root')!).render(<StrictMode>{params.has('strip') ? <TabStrip /> : params.has('kiln-window') ? <KilnWindowHeader /> : <App />}</StrictMode>);
