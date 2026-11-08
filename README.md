# LiquidDesktop

A Liquid Glass desktop environment for Linux, written in plain JavaScript and run by Electron.
It borrows the macOS 26 look (translucent menu bar, glass Dock, Control Center, Spotlight, widgets) but every
icon, wallpaper and line of code is its own.

## Run it

```sh
npm install
npm start            # the desktop inside a normal window, for testing
```

| Command | What it does |
|---|---|
| `npm start` | Windowed test mode. Power actions only quit or restart LiquidDesktop, never your computer. |
| `npm run dev` | Same, with DevTools open. |
| `npm run nested` | The real **desktop session** (window manager, compositor, native Linux apps) in a window. Uses rootful Xwayland on Wayland (GPU-accelerated), Xephyr otherwise (software, slow). |
| `npm run web` | Browser preview at http://localhost:5173 (files, terminal and hardware are mocked). |
| `npm run install-session` | Adds “LiquidDesktop” to your login screen (X11). |
| `npm run shots` | Renders the desktop offscreen and saves screenshots to `shots/`. |

> Running from VS Code's terminal? The scripts strip `ELECTRON_RUN_AS_NODE`, which VS Code sets and which
> otherwise stops Electron from starting.

## Install (Arch Linux)

[packaging/arch/PKGBUILD](packaging/arch/PKGBUILD) builds the `liquid-desktop-git` package from a git repo.
It uses Arch's `electron43` and `picom`, and installs the login-screen session.

```sh
# from a checkout of this repo — point LIQUID_REPO at wherever you pushed it
LIQUID_REPO=https://github.com/you/LiquidDesktop.git yay -Bi packaging/arch
# or, without yay
cd packaging/arch && LIQUID_REPO=https://github.com/you/LiquidDesktop.git makepkg -si
```

(Instead of setting `LIQUID_REPO` every time, you can edit `_repo` and `url` at the top of the PKGBUILD.)

Then log out and choose **LiquidDesktop** on your login screen. It also installs:

| Command | |
|---|---|
| `liquid-desktop` | the desktop in a window (also in your app menu as “LiquidDesktop (Window)”) |
| `liquid-desktop-nested` | the full session in a window, for testing |
| `liquid-desktop-session` | what the login screen runs |

Optional extras for Control Center: `networkmanager`, `wireplumber`, `brightnessctl`, `bluez-utils`, `playerctl`.
On other distros, `session/install-session.sh` adds the session entry for a checkout in place.

## What's in it

**Shell**
- Transparent menu bar whose text color follows the wallpaper, with app menus, a system menu, battery, network and clock.
- Dock with magnification, bounce on launch, running dots, minimized windows, a Trash that takes dropped files, drag to reorder, and drag off to remove.
- Control Center: Wi-Fi with a network list and join, Bluetooth, Airplane Mode, Focus, Now Playing (MPRIS via `playerctl`), and brightness and volume sliders that drive the real hardware. Also Night Shift, Dark Mode, screenshots and lock.
- Spotlight with Apps / Files / Actions filters, an inline calculator, settings panes and web search.
- Apps grid (Launchpad) showing the built-in apps plus every installed `.desktop` app, with category filters.
- Notification banners and a Notification Center that holds widgets.
- Desktop widgets (clock, calendar, weather, system stats, quick note, up next) that you can drag, add and remove.
- Lock screen that checks your real account password through `unix_chkpwd`.
- Desktop icons from `~/Desktop`, rubber-band selection, desktop context menu, and drop-to-move.

**Window manager**
- Liquid Glass windows: traffic lights, floating glass sidebars and toolbar capsules.
- Resize from all 8 edges.
- Drag a window to an edge to tile it (halves, quarters, fill). Hovering the green button opens a tile menu, and `Alt+Shift+Arrows` tiles from the keyboard.
- Minimize into the Dock, full screen, and a Show Desktop that pushes windows aside.
- Spaces (multiple desktops) and Mission Control, where you can drag a window onto another desktop.
- Alt+Tab app switcher and hot corners.

**Liquid Glass.** Every glass surface uses backdrop blur and saturation with a specular rim. On top of that, each
surface gets its own SVG displacement lens, generated for its exact size, so the backdrop really bends at the edges
like a lens. Settings › Appearance has Clear/Tinted glass, refraction on/off, Reduce Transparency, accent colors,
and the four macOS 26 icon styles (Default, Dark, Clear, Tinted).

**Apps:** Files, Terminal (a real PTY with xterm.js), Browser (tabs, Chromium webview), Notes, Text Editor, Calculator,
Preview, Calendar, Weather (Open-Meteo), Activity Monitor (live graph, quit and force quit), System Settings, and About.

## Keyboard

Alt stands in for ⌘. Super works too where your compositor passes it through.

| | |
|---|---|
| Alt+Space | Spotlight |
| Alt+Tab | Switch apps |
| F3 / Ctrl+↑ | Mission Control |
| F4 | Apps |
| F11 | Show Desktop |
| Ctrl+← / → | Switch desktop |
| Alt+Shift+← → ↑ ↓ | Tile window |
| Alt+N / W / M / H / Q | New, close, minimize, hide window / quit app |
| Alt+Shift+3 / PrtSc | Screenshot (saved to ~/Pictures/Screenshots) |
| Ctrl+Alt+Q | Lock screen |
| Ctrl+Shift+F | Toggle full screen of the test window |

## How it fits together

```
main/            Electron main process
  main.js        window setup (--windowed / --session)
  system.js      backend: files, .desktop apps, nmcli, wpctl/pactl, brightnessctl, bluetoothctl, playerctl, ps, PTYs
  preload.js     exposes it as window.sys
  ptybridge.py   tiny PTY bridge for the Terminal (no native node modules needed)
renderer/
  css/           design tokens + glass material (base), shell, windows & apps
  js/            wm.js (windows/spaces), dock, menubar, controlcenter, overlays (Spotlight, Apps, switcher),
                 notifications, widgets, desktop, theme (glass lenses, wallpaper), apps/*
session/         X11 session launcher + display-manager entry
tools/           offscreen screenshot harness, browser preview server, nested Xephyr test
```

Built-in apps call `registerApp({ id, name, size, open(win, args), menus })`. Anything an app needs from the
system goes through `api` in `renderer/js/sys.js`.

## Running as your real desktop

`npm run install-session` adds “LiquidDesktop” to your login screen (X11); try it first with `npm run nested`.

In a session, the web UI is still the whole interface. Electron's main process adds a small X11 window
manager written in JavaScript ([main/wm.js](main/wm.js)) that turns the web UI into a real desktop:

- **Layers.** The same web app is loaded as a *desktop* layer (wallpaper, widgets, icons) at the bottom and
  a transparent *shell* layer (menu bar, Dock, popovers) on top. Only the shell's interactive parts take
  clicks; everything else passes through.
- **Every Linux app gets the macOS chrome.** Normal app windows are reparented into a frame whose title
  bar (traffic lights, title, tiling menu) is drawn by [renderer/frame.html](renderer/frame.html). Apps
  that draw their own title bar (GTK header bars) are left unframed.
- **Built-in apps are real windows** (`?layer=app`), stacked, focused and tiled like any other.
- **Blur.** [picom](session/picom.conf) is the compositor. The WM places an invisible, click-through
  window behind each glass surface; picom blurs what's behind those, with matching rounded corners.
  This is a real blur of other apps' windows, done on the GPU. picom also draws window shadows and rounded corners.
- **Window management:** click-to-focus, drag/resize (title bar, edges, or Alt+drag anywhere),
  edge tiling with a preview, maximize/full screen, minimize to the Dock, Spaces, Mission Control with live
  thumbnails, Alt+Tab, and global shortcuts. Standard EWMH/ICCCM hints are supported, so ordinary apps behave.

Known limits (0.2):
- It's an X11 session. On Wayland, use `npm run nested` or the testing window.
- Notifications from Linux apps (D-Bus `org.freedesktop.Notifications`) are not shown yet.
- Edit-menu commands in the menu bar reach built-in apps only; native apps use their own menus/shortcuts.
