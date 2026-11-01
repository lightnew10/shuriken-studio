# Third-party notices

Shuriken Studio's own code is under the [MIT license](LICENSE). This file lists the third-party material that
is in this repository, what the built app bundles, and the outside software it works with. Each component
stays under its own license.

## 1. In this repository

| Path | What it is | License |
|---|---|---|
| `resources/ui-glyphs/lucide.json` | Icon path data extracted from [Lucide](https://lucide.dev) (lucide-react 1.48.0). Some of these icons derive from [Feather](https://feathericons.com). | ISC (Lucide Contributors); MIT (Cole Bemis) for the Feather-derived icons. Full text: [`resources/ui-glyphs/LICENSE`](resources/ui-glyphs/LICENSE). |
| `src/core/audio/mp3-tables.ts` | The Huffman code tables, scale-factor bands and synthesis window that the MPEG-1/2 Audio Layer III standard (ISO/IEC 11172-3, 13818-3) defines. | Numeric data required to implement the format. The decoder around it is original code. |
| `src/core/ui/lab/core-overlays.ts` | Single-line quotations from Roblox's CoreScripts, compared against the user's own Roblox Studio install to check that the on-screen overlays still match Roblox's layout. | Short quotations for compatibility checks. Roblox's scripts are not included. |

Everything else here is original work released under the MIT license. That covers the source, tests and test
fixtures, the bundled agent skills and seed knowledge, the Blender scripts (`resources/blender/`), the Studio
plugin that the app generates (Shuriken Link), and the app icon (`build/icon.*`, drawn by
`scripts/make-icon.mjs`). Where the skills and knowledge files mention outside documentation or community
libraries, they link to them and do not copy them.

## 2. Bundled into the built app

### Electron and Chromium

The app runs on [Electron](https://github.com/electron/electron) (MIT), which includes Chromium, Node.js and
their dependencies under their own licenses. electron-builder puts `LICENSE.electron.txt` and
`LICENSES.chromium.html` next to the installed app.

### Fonts

Three fonts are bundled into the renderer through Fontsource, all under the
[SIL Open Font License 1.1](https://openfontlicense.org):

- **Fraunces**: Copyright 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces)
- **Geist**: Copyright 2024 The Geist Project Authors (github.com/vercel/geist-font)
- **Geist Mono**: Copyright 2024 The Geist Project Authors (github.com/vercel/geist-font)

### npm packages

These packages are production dependencies. The installer includes them, each with its own license file. They
are not stored in this repository: `npm ci` installs them.

| Package | Version | License |
|---|---|---|
| [@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript) | 0.3.284 | Proprietary (see below) |
| [@anthropic-ai/claude-agent-sdk-win32-x64](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-win32-x64) | 0.3.284 | Proprietary (see below) |
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | 0.129.0 | MIT |
| [@babel/runtime](https://github.com/babel/babel) | 7.29.7 | MIT |
| [@breezystack/lamejs](https://github.com/shijinyu/lamejs) | 1.2.7 | LGPL-3.0 |
| [@fontsource-variable/fraunces](https://github.com/fontsource/font-files) | 5.3.0 | OFL-1.1 |
| [@fontsource-variable/geist](https://github.com/fontsource/font-files) | 5.3.0 | OFL-1.1 |
| [@fontsource-variable/geist-mono](https://github.com/fontsource/font-files) | 5.3.0 | OFL-1.1 |
| [@hono/node-server](https://github.com/honojs/node-server) | 2.1.1 | MIT |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.31.0 | MIT |
| [@stablelib/base64](https://github.com/StableLib/stablelib) | 1.0.1 | MIT |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) | 0.11.0 | MIT |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT |
| [accepts](https://github.com/jshttp/accepts) | 2.0.0 | MIT |
| [ajv](https://github.com/ajv-validator/ajv) | 8.20.0 | MIT |
| [ajv-formats](https://github.com/ajv-validator/ajv-formats) | 3.0.1 | MIT |
| [argparse](https://github.com/nodeca/argparse) | 2.0.1 | Python-2.0 |
| [body-parser](https://github.com/expressjs/body-parser) | 2.3.0 | MIT |
| [builder-util-runtime](https://github.com/electron-userland/electron-builder) | 9.7.0 | MIT |
| [bytes](https://github.com/visionmedia/bytes.js) | 3.1.2 | MIT |
| [call-bind-apply-helpers](https://github.com/ljharb/call-bind-apply-helpers) | 1.0.2 | MIT |
| [call-bound](https://github.com/ljharb/call-bound) | 1.0.4 | MIT |
| [clsx](https://github.com/lukeed/clsx) | 2.1.1 | MIT |
| [content-disposition](https://github.com/jshttp/content-disposition) | 1.1.0 | MIT |
| [content-type](https://github.com/jshttp/content-type) | 2.1.0 | MIT |
| [content-type](https://github.com/jshttp/content-type) | 1.0.5 | MIT |
| [cookie](https://github.com/jshttp/cookie) | 0.7.2 | MIT |
| [cookie-signature](https://github.com/visionmedia/node-cookie-signature) | 1.2.2 | MIT |
| [cors](https://github.com/expressjs/cors) | 2.8.6 | MIT |
| [cross-spawn](https://github.com/moxystudio/node-cross-spawn) | 7.0.6 | MIT |
| [debug](https://github.com/debug-js/debug) | 4.4.3 | MIT |
| [depd](https://github.com/dougwilson/nodejs-depd) | 2.0.0 | MIT |
| [dompurify](https://github.com/cure53/DOMPurify) | 3.4.16 | (MPL-2.0 OR Apache-2.0) |
| [dunder-proto](https://github.com/es-shims/dunder-proto) | 1.0.1 | MIT |
| [ee-first](https://github.com/jonathanong/ee-first) | 1.1.1 | MIT |
| [electron-updater](https://github.com/electron-userland/electron-builder) | 6.8.9 | MIT |
| [encodeurl](https://github.com/pillarjs/encodeurl) | 2.0.0 | MIT |
| [es-define-property](https://github.com/ljharb/es-define-property) | 1.0.1 | MIT |
| [es-errors](https://github.com/ljharb/es-errors) | 1.3.0 | MIT |
| [es-object-atoms](https://github.com/ljharb/es-object-atoms) | 1.1.2 | MIT |
| [escape-html](https://github.com/component/escape-html) | 1.0.3 | MIT |
| [etag](https://github.com/jshttp/etag) | 1.8.1 | MIT |
| [eventsource](https://github.com/EventSource/eventsource) | 3.0.7 | MIT |
| [eventsource-parser](https://github.com/rexxars/eventsource-parser) | 3.1.1 | MIT |
| [express](https://github.com/expressjs/express) | 5.2.1 | MIT |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | 8.7.0 | MIT |
| [fast-deep-equal](https://github.com/epoberezkin/fast-deep-equal) | 3.1.3 | MIT |
| [fast-equals](https://github.com/planttheidea/fast-equals) | 4.0.3 | MIT |
| [fast-sha256](https://github.com/dchest/fast-sha256-js) | 1.3.0 | Unlicense |
| [fast-uri](https://github.com/fastify/fast-uri) | 3.1.8 | BSD-3-Clause |
| [finalhandler](https://github.com/pillarjs/finalhandler) | 2.1.1 | MIT |
| [forwarded](https://github.com/jshttp/forwarded) | 0.2.0 | MIT |
| [framer-motion](https://github.com/motiondivision/motion/) | 13.4.4 | MIT |
| [fresh](https://github.com/jshttp/fresh) | 2.0.0 | MIT |
| [fs-extra](https://github.com/jprichardson/node-fs-extra) | 10.1.0 | MIT |
| [function-bind](https://github.com/Raynos/function-bind) | 1.1.2 | MIT |
| [get-intrinsic](https://github.com/ljharb/get-intrinsic) | 1.3.0 | MIT |
| [get-proto](https://github.com/ljharb/get-proto) | 1.0.1 | MIT |
| [gopd](https://github.com/ljharb/gopd) | 1.2.0 | MIT |
| [graceful-fs](https://github.com/isaacs/node-graceful-fs) | 4.2.11 | ISC |
| [has-symbols](https://github.com/inspect-js/has-symbols) | 1.1.0 | MIT |
| [hasown](https://github.com/inspect-js/hasOwn) | 2.0.4 | MIT |
| [hono](https://github.com/honojs/hono) | 4.13.10 | MIT |
| [http-errors](https://github.com/jshttp/http-errors) | 2.0.1 | MIT |
| [iconv-lite](https://github.com/pillarjs/iconv-lite) | 0.7.3 | MIT |
| [inherits](https://github.com/isaacs/inherits) | 2.0.4 | ISC |
| [ip-address](https://github.com/beaugunderson/ip-address) | 10.7.2 | MIT |
| [ipaddr.js](https://github.com/whitequark/ipaddr.js) | 1.9.1 | MIT |
| [is-promise](https://github.com/then/is-promise) | 4.0.0 | MIT |
| [isexe](https://github.com/isaacs/isexe) | 2.0.0 | ISC |
| [jose](https://github.com/panva/jose) | 6.2.12 | MIT |
| [js-tokens](https://github.com/lydell/js-tokens) | 4.0.0 | MIT |
| [js-yaml](https://github.com/nodeca/js-yaml) | 4.3.2 | MIT |
| [json-schema-to-ts](https://github.com/ThomasAribart/json-schema-to-ts) | 3.1.1 | MIT |
| [json-schema-traverse](https://github.com/epoberezkin/json-schema-traverse) | 1.0.0 | MIT |
| [json-schema-typed](https://github.com/RemyRylan/json-schema-typed) | 8.0.2 | BSD-2-Clause |
| [jsonfile](https://github.com/jprichardson/node-jsonfile) | 6.2.1 | MIT |
| [lazy-val](https://github.com/develar/lazy-val) | 1.0.5 | MIT |
| [lodash.escaperegexp](https://github.com/lodash/lodash) | 4.1.2 | MIT |
| [lodash.isequal](https://github.com/lodash/lodash) | 4.5.0 | MIT |
| [loose-envify](https://github.com/zertosh/loose-envify) | 1.4.0 | MIT |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.48.0 | ISC |
| [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT |
| [math-intrinsics](https://github.com/es-shims/math-intrinsics) | 1.1.0 | MIT |
| [media-typer](https://github.com/jshttp/media-typer) | 1.1.1 | MIT |
| [merge-descriptors](https://github.com/sindresorhus/merge-descriptors) | 2.0.0 | MIT |
| [mime-db](https://github.com/jshttp/mime-db) | 1.54.0 | MIT |
| [mime-types](https://github.com/jshttp/mime-types) | 3.0.2 | MIT |
| [motion](https://github.com/motiondivision/motion) | 13.4.4 | MIT |
| [motion-dom](https://github.com/motiondivision/motion) | 13.4.4 | MIT |
| [motion-utils](https://github.com/motiondivision/motion) | 13.3.0 | MIT |
| [ms](https://github.com/vercel/ms) | 2.1.3 | MIT |
| [negotiator](https://github.com/jshttp/negotiator) | 1.1.0 | MIT |
| [node-addon-api](https://github.com/nodejs/node-addon-api) | 7.1.1 | MIT |
| [node-pty](https://github.com/microsoft/node-pty) | 1.1.0 | MIT |
| [object-assign](https://github.com/sindresorhus/object-assign) | 4.1.1 | MIT |
| [object-inspect](https://github.com/inspect-js/object-inspect) | 1.13.4 | MIT |
| [on-finished](https://github.com/jshttp/on-finished) | 2.4.1 | MIT |
| [once](https://github.com/isaacs/once) | 1.4.0 | ISC |
| [parseurl](https://github.com/pillarjs/parseurl) | 1.3.3 | MIT |
| [path-key](https://github.com/sindresorhus/path-key) | 3.1.1 | MIT |
| [path-to-regexp](https://github.com/pillarjs/path-to-regexp) | 8.4.2 | MIT |
| [pkce-challenge](https://github.com/crouchcd/pkce-challenge) | 5.0.1 | MIT |
| [prop-types](https://github.com/facebook/prop-types) | 15.8.1 | MIT |
| [proxy-addr](https://github.com/jshttp/proxy-addr) | 2.0.8 | MIT |
| [qs](https://github.com/ljharb/qs) | 6.16.0 | BSD-3-Clause |
| [range-parser](https://github.com/jshttp/range-parser) | 1.3.0 | MIT |
| [raw-body](https://github.com/stream-utils/raw-body) | 3.0.2 | MIT |
| [react](https://github.com/react/react) | 19.3.0 | MIT |
| [react-dom](https://github.com/react/react) | 19.3.0 | MIT |
| [react-draggable](https://github.com/react-grid-layout/react-draggable) | 4.7.2 | MIT |
| [react-grid-layout](https://github.com/STRML/react-grid-layout) | 2.2.4 | MIT |
| [react-is](https://github.com/facebook/react) | 16.13.1 | MIT |
| [react-resizable](https://github.com/react-grid-layout/react-resizable) | 3.2.0 | MIT |
| [require-from-string](https://github.com/floatdrop/require-from-string) | 2.0.2 | MIT |
| [resize-observer-polyfill](https://github.com/que-etc/resize-observer-polyfill) | 1.5.1 | MIT |
| [router](https://github.com/pillarjs/router) | 2.2.0 | MIT |
| [safer-buffer](https://github.com/ChALkeR/safer-buffer) | 2.1.2 | MIT |
| [sax](https://github.com/isaacs/sax-js) | 1.6.1 | BlueOak-1.0.0 |
| [scheduler](https://github.com/react/react) | 0.28.0 | MIT |
| [semver](https://github.com/npm/node-semver) | 7.7.4 | ISC |
| [send](https://github.com/pillarjs/send) | 1.2.1 | MIT |
| [serve-static](https://github.com/expressjs/serve-static) | 2.2.1 | MIT |
| [setprototypeof](https://github.com/wesleytodd/setprototypeof) | 1.2.0 | ISC |
| [shebang-command](https://github.com/kevva/shebang-command) | 2.0.0 | MIT |
| [shebang-regex](https://github.com/sindresorhus/shebang-regex) | 3.0.0 | MIT |
| [side-channel](https://github.com/ljharb/side-channel) | 1.1.1 | MIT |
| [side-channel-list](https://github.com/ljharb/side-channel-list) | 1.0.1 | MIT |
| [side-channel-map](https://github.com/ljharb/side-channel-map) | 1.0.1 | MIT |
| [side-channel-weakmap](https://github.com/ljharb/side-channel-weakmap) | 1.0.2 | MIT |
| [standardwebhooks](https://github.com/standard-webhooks/standard-webhooks) | 1.1.1 | MIT |
| [statuses](https://github.com/jshttp/statuses) | 2.0.2 | MIT |
| [three](https://github.com/mrdoob/three.js) | 0.186.1 | MIT |
| [tiny-typed-emitter](https://github.com/binier/tiny-typed-emitter) | 2.1.0 | MIT |
| [toidentifier](https://github.com/component/toidentifier) | 1.0.1 | MIT |
| [ts-algebra](https://github.com/ThomasAribart/ts-algebra) | 2.0.0 | MIT |
| [tslib](https://github.com/Microsoft/tslib) | 2.8.1 | 0BSD |
| [type-is](https://github.com/jshttp/type-is) | 2.1.0 | MIT |
| [universalify](https://github.com/RyanZim/universalify) | 2.0.1 | MIT |
| [unpipe](https://github.com/stream-utils/unpipe) | 1.0.0 | MIT |
| [vary](https://github.com/jshttp/vary) | 1.1.2 | MIT |
| [which](https://github.com/isaacs/node-which) | 2.0.2 | ISC |
| [wrappy](https://github.com/npm/wrappy) | 1.0.2 | ISC |
| [zod](https://github.com/colinhacks/zod) | 4.6.5 | MIT |
| [zod-to-json-schema](https://github.com/StefanTerdell/zod-to-json-schema) | 3.25.2 | ISC |

Notes on the licenses that aren't permissive:

- **@breezystack/lamejs** (LGPL-3.0, an MP3 encoder derived from LAME) is used unmodified as a separate npm
  package. Its source and license come with it in `node_modules`. Because this app is open source, you can
  rebuild it with a modified version of the library, as the LGPL allows.
- **dompurify** is dual-licensed (MPL-2.0 or Apache-2.0). It is used under Apache-2.0, unmodified.
- **@anthropic-ai/claude-agent-sdk** and **@anthropic-ai/claude-agent-sdk-win32-x64** (the Claude Code runtime,
  `claude.exe`) are **proprietary**: "© Anthropic PBC. All rights reserved. Use is subject to the Legal
  Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." They are not part of this
  repository and are not covered by its MIT license. `npm ci` downloads them from npm under Anthropic's terms,
  and `npm run dist` puts them into the installer. If you publish installers, make sure Anthropic's terms allow
  you to distribute them. Using them requires your own Claude account or API access.

## 3. Software the app works with (not bundled)

The app starts or talks to these programs when they are installed. It does not ship them, and each is used
under its own terms:

- **Roblox Studio** and its MCP server (`StudioMCP.exe`), © Roblox Corporation, under the
  [Roblox Terms of Use](https://en.help.roblox.com/hc/en-us/articles/115004647846). Roblox's Open Cloud APIs are
  used with your own API key.
- **Claude Code** and the Claude API, © Anthropic, under your own Claude plan or API agreement.
- **Blender** (GPL-2.0-or-later). It runs as a separate program, and the Python scripts in `resources/blender/`
  are loaded into it.
- **Kiln**: a separate 3D-modeling app with its own terms. It is reached through a local API.
- **git** (GPL-2.0), **selene** (MPL-2.0) and **luau-lsp** (MIT), run from your `PATH`. luau-lsp's Roblox type
  definitions are downloaded from its repository at runtime.
- **Openverse** search results (Freesound, Wikimedia Commons and others). The app only imports sounds licensed
  CC0, public domain, CC BY or CC BY-SA, and it writes the required credits into the game's `audio/CREDITS.md`.
- The **Blender MCP** example plugin (`resources/plugin-examples/blender`) runs `uvx blender-mcp`, a third-party
  package that the app does not include.
