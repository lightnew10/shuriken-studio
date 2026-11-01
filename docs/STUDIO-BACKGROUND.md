# Running Roblox Studio in the background for Shuriken

Shuriken's agents work in Roblox Studio through Studio's MCP server: they run Luau, start playtests and
take screenshots that critics and the director look at. Studio does not have to be the window in front,
but it has to keep drawing. This page lists what that takes and how to set up your PC for it.

## What Studio does when it is not in front

| Studio window | Rendering | Effect on Shuriken |
|---|---|---|
| In front | Full frame rate | Everything works |
| Open but unfocused (behind other windows, or on the second monitor) | Throttled to 25% of its max frame rate | Works; playtests and screenshots are slower |
| Minimized | The viewport is not drawn (it shrinks to 1×1) | Screenshots are blank; visual checks fail |
| Display off, locked or asleep | Nothing is drawn | Screenshots are blank or time out |

There is no permission that makes a minimized or hidden Studio render. Keep it open and not minimized;
a second monitor is the simplest place for it.

## Recommended setup

1. **Turn off background power throttling for Studio.** Windows slows unfocused apps to
   save power; this exempts Studio. Run in an administrator terminal, with your own Studio path:

   ```
   powercfg /powerthrottling disable /path "%LOCALAPPDATA%\Roblox\Versions\version-<id>\RobloxStudioBeta.exe"
   ```

   The path contains Studio's version folder, which changes when Studio updates: **run it again after a
   Studio update** with the new path. To find the current path while Studio is running:

   ```
   powershell -NoProfile -Command "(Get-Process RobloxStudioBeta).Path"
   ```

   To see what is exempt: `powercfg /powerthrottling list`. To undo:
   `powercfg /powerthrottling reset /path "<the same path>"`.

2. **Studio's max frame rate at 240**: Studio Settings → Rendering → frame rate. Unfocused Studio runs at
   25% of this value, so 240 keeps it at 60 FPS in the background.
3. **NVIDIA Control Panel** → Manage 3D settings → Program Settings → Roblox Studio → turn off
   "Background Application Max Frame Rate".
4. **Windows graphics preference**: Settings → System → Display → Graphics → add RobloxStudioBeta.exe →
   High performance.
5. **Keep the screen on**: Shuriken's Settings → "Keep the screen on while agents work" (on by default).
   A locked or sleeping display blanks every screenshot.
6. **Studio's MCP server**: Studio → enable "Studio as MCP server" (Shuriken's Settings → Roblox shows
   whether it is connected).

## What Shuriken does about it

- It never needs Studio focused; it talks to Studio over MCP.
- **While you are at the PC** (keyboard or mouse input in the last 3 minutes, or Windows can't tell) it never takes
  your focus and never puts Studio over your windows. Before a screenshot it restores a minimized Studio behind
  your windows without taking focus, retries a blank or timed-out capture once, then says "Studio isn't drawing
  (minimized, the display off, or its screen capture stopped answering)": verification and critics read that as "can't check visually", never
  as a failed task. A save (Ctrl+S through Studio's window) waits while you work in another app; it goes ahead
  when Studio or Shuriken is the window in front.
- **When nobody has touched the PC for 3 minutes** (Windows' `GetLastInputInfo`) it may move Studio where it gets
  drawn, and puts things back:
  - for a screenshot, Studio's window goes above the other windows without being activated (nothing covers its
    viewport), and after the capture it goes back under the window that was above it;
  - if the display fell asleep and "Keep the screen on while agents work" is on, the display is woken first (a
    one-pixel mouse move and back). That wake is not counted as you coming back;
  - for a save, Studio is brought to the foreground, Ctrl+S is sent, the file's time confirms it, and the window
    that was in front is brought back to the front.
  A locked PC can't be helped: Windows shows the lock screen and Studio draws nothing behind it. Captures then
  report "Studio isn't drawing", as before.
- A save whose Ctrl+S changed nothing names the dialog Studio is showing ("Auto-Recovery", for one, after a crash):
  a dialog takes the keys until someone answers it.
- A Studio that closes while agents work (a crash) is reopened on the project's place file by Shuriken itself, up
  to 3 tries, with one status line in the chat; the agents' Studio calls wait meanwhile.
- A regression run takes no pictures during its playtests (nobody looks at them), so a Studio that isn't drawing
  no longer costs it a minute per capture.
- Other agents' playtests and Edit-mode calls wait for each other inside Shuriken (a playtest is stopped after
  3 minutes), so a busy Studio costs time, not failed calls.

## Sources

- Unfocused Studio renders at 25% of the max frame rate; raise the cap to compensate:
  https://devforum.roblox.com/t/how-to-disable-fps-drop-when-window-is-not-focused/4571106
- Studio near 0 FPS when out of focus, graphics-mode workarounds:
  https://devforum.roblox.com/t/roblox-studio-at-0-fps-apparently-when-the-window-is-out-of-focus/3131382
- Windows deprioritizing unfocused windows:
  https://devforum.roblox.com/t/fps-drop-for-all-windows-not-focused-on/3130293
