# Shuriken Studio

AI agents that build Roblox games inside Roblox Studio. Describe a game, and they plan it, build it, playtest it and fix what fails.

[Download](https://shuriken.studio/apps/shuriken-studio) · [Setup guide](docs/SETUP.md)

## You need

- Windows 11, 64-bit
- Roblox Studio, with its MCP server turned on
- Blender 5.2 LTS
- Your own Claude access (a Claude plan or an Anthropic API key). The app uses the Claude Code login already on your PC, or accounts you add in Settings → Claude accounts.

Whole games use a lot of Claude usage.

## Install

1. Install [Blender 5.2 LTS](https://www.blender.org/download/).
2. Download the installer and run it. It also installs Kiln, the 3D modeler. It isn't code-signed, so Windows may warn you: choose **More info → Run anyway** if you trust the release.
3. Open Shuriken Studio, check **Settings → Claude accounts** and **Settings → Roblox & Studio**, then describe a game.

The full walkthrough is in the [setup guide](docs/SETUP.md).

## Build from source

Needs Node.js 24 or newer.

```powershell
npm ci
npm run dev
```

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Shuriken Studio is an independent project, not made or endorsed by Roblox Corporation or Anthropic.
