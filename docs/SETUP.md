# Set up Shuriken Studio

From a fresh Windows PC to your first game, in about 25 minutes (most of it downloads). The same guide is at
https://shuriken.studio/apps/shuriken-studio/setup.

## You need

- A Windows 11 PC (64-bit) with about 4 GB free, plus room for Roblox Studio. A graphics card helps: Kiln renders on it.
- A Roblox account (free).
- A Claude Pro or Max plan, or an Anthropic API key. Whole games use a lot of usage: Max gives a big build room to finish without waiting for limits to reset.

## Steps

### 1. Install Roblox Studio

Download Roblox Studio from create.roblox.com, install it, open it and sign in with your Roblox account.

You don't need to open a place: Shuriken opens Studio on each game by itself.

### 2. Turn on Studio's MCP server

In Roblox Studio, open **Assistant → Manage MCP Servers** and turn on **Enable Studio as MCP server**. It's how Shuriken works inside Studio, and it stays on.

Shuriken also installs a small Studio plugin, Shuriken Link, the first time it connects. It only talks to Shuriken on this PC.

### 3. Install Blender 5.2

Download Blender 5.2 LTS from blender.org and install it with the default options. Kiln, which makes every 3D model in your games, runs it in the background, so you never need to open it.

### 4. Install Shuriken Studio and Kiln

Download the installer from https://shuriken.studio/apps/shuriken-studio (or this repository's Releases) and run it. It installs Shuriken Studio, then Kiln, for your Windows account. Already have Kiln? It's left as it is.

The installer isn't code-signed yet, so Windows may show **Windows protected your PC**: choose **More info**, then **Run anyway**.

Keep the suggested folder or pick another. Both apps get Start menu and Desktop shortcuts.

### 5. Sign in to Claude

Open Shuriken Studio and go to **Settings → Claude accounts**.

If Claude Code is already signed in on this PC, **This PC's Claude login** shows as signed in and you're done.

Otherwise press **Sign in**. Claude Code's own sign-in opens in the window: choose **Claude account with subscription**, finish in the browser that opens, then press **Check sign-in**. Your login stays on your PC; Shuriken never sees your password.

Kiln uses the same login, so there's nothing to sign in to twice.

### 6. Check the Studio connection

Open **Settings → Roblox & Studio**. Studio's MCP server should show as connected. If it doesn't, see the fixes below.

### 7. Build your first game

On the start page, describe a game in a sentence or two, for example: "A round-based obby race for up to 8 players, with checkpoints and a coin shop."

Shuriken opens a new place in Roblox Studio and the team gets to work. You see the plan, each task as it's built and tested, and the game taking shape in Studio. Chat with the director whenever you want to change something.

When the game needs a model, Shuriken starts Kiln in the background by itself and the model comes back into Studio.

Leave Shuriken and Studio open while it builds. If your Claude plan reaches a limit, the work waits and picks up again by itself when the limit resets.

## Optional

- **Uploads to Roblox.** Agents can make their own sounds, meshes and images. To upload them, add a Roblox Open Cloud API key in **Settings → Roblox & Studio** (create.roblox.com → Open Cloud → API Keys, with Assets read and write). Without one, the agents use Creator Store assets.
- **Kiln on its own.** Open Kiln from the Start menu to model anything yourself, in a chat and a live viewer. It's the same Kiln Shuriken uses.
- **Checkpoints.** Install git and each milestone is saved as a checkpoint you can roll back to.

## If something goes wrong

**Windows says "Windows protected your PC"**

The installer isn't code-signed yet. Choose More info, then Run anyway.

**Studio doesn't show as connected**

Check that Enable Studio as MCP server is on (Assistant → Manage MCP Servers), then close Studio and let Shuriken open it again. Studio has to be signed in.

**Shuriken can't find Kiln**

Open Kiln once from the Start menu, then try again. Installed Kiln somewhere else? Set its location in Settings → Agents. Kiln is also on its own page here, to install by itself.

**Kiln says "Blender not found"**

Install Blender 5.2 in its default folder and restart Kiln. Installed somewhere else? See the Kiln setup guide.

**"Not signed in" or a limit reached**

Settings → Claude accounts shows each login and its usage. You can add another account; Shuriken switches to one with room when a limit is hit.

**Where are my games?**

In Documents\Shuriken Studio\Projects. Settings and logs are in %APPDATA%\Shuriken Studio.

**How do updates work?**

When a new version is out, Shuriken Studio asks first: Update, Not now or Never ask. Say yes and it downloads in the background and installs when you restart; your games and settings stay. Changed the app's own code? Choose Never ask and your changes stay.

**How do I uninstall it?**

Windows Settings → Apps → Installed apps: Shuriken Studio and Kiln are uninstalled separately. Your games, projects and settings stay.

Still stuck? Open an issue in this repository.
