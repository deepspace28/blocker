# FocusLock

A personal distraction blocker for your desktop, inspired by Freedom. Block distracting
websites and apps for a set duration, invert it into an allowlist with "Lock the Internet,"
set recurring schedules, and use hard mode when you don't trust yourself with an "off" switch.

## Features

- **Blocklist** — maintain a list of sites (social media, news, etc.) to block during sessions,
  with one-click preset categories (Social Media, Video & Streaming, News, Shopping, Gaming,
  Messaging & Forums).
- **Allowlist / "Lock the Internet"** — flip it around: block the *entire* internet except a
  short list of sites you allow (docs, your work tools, etc.).
- **App blocking** — force-close (and keep closed) native apps like Discord, Steam, or a game,
  during any session, regardless of mode.
- **Focus sessions** — start a timed session (e.g. 25 minutes, 2 hours) in either mode.
- **Hard mode** — once a hard-mode session starts, it can't be stopped early, even if you quit
  or restart the app. The block is re-applied automatically on launch until the timer runs out.
- **Recurring schedules** — e.g. "block social media Mon-Fri 9am-5pm" — auto-starts (and can be
  hard-mode, and can be either block or allow mode) whenever FocusLock is running.
- **Stats & history** — sessions completed, total time blocked, and a day streak.

## How blocking works

**Block mode** redirects each domain on your blocklist to `127.0.0.1` inside a clearly marked,
managed section of your OS hosts file (`/etc/hosts` on macOS/Linux, `System32\drivers\etc\hosts`
on Windows). Editing the hosts file requires admin privileges, so the app will prompt you for
your password (via Touch ID/Keychain on macOS, UAC on Windows, or polkit on Linux) the first
time you start or stop a session.

**Allow mode ("Lock the Internet")** works differently, because a hosts file can only redirect
specific names — it can't express "block everything except X." Instead, FocusLock runs a small
local proxy and points your OS's system network proxy at it for the session; the proxy only
forwards traffic to hosts on your allowlist (including HTTPS, via CONNECT tunneling — it only
ever inspects the hostname, never your encrypted traffic) and returns a block page or connection
refusal for everything else. No admin password is needed for this mode (it's a per-user network
setting), but **platform coverage varies**:
- macOS: works via `networksetup` on your active network service.
- Windows: works via the per-user WinINet proxy registry keys.
- Linux: only covers GNOME's system proxy setting (`gsettings`) — other desktop environments, and
  browsers with their own independent proxy setting (e.g. Firefox unless set to "use system
  proxy"), aren't covered.

**App blocking** periodically lists running processes (`tasklist`/`ps`) and force-kills any whose
executable name matches an entry in your blocked-apps list — checked every few seconds, so a
relaunch gets closed again almost immediately.

**Limitation:** like most lightweight blockers (including Freedom itself), none of this stops
someone with admin access and technical know-how from manually editing the hosts file, changing
network settings back, or using a VPN outside the proxy. The friction is the point — this is
meant to block casual "just checking Twitter for a second," not a determined adversary.

## Not included (yet)

- Cross-device sync / mobile apps — would need a hosted backend and account system.
- A browser extension companion.
- Freedom's "Pace" soft-friction delay screen — the current hosts-file/proxy architecture doesn't
  cleanly support showing an interstitial over HTTPS without a MITM proxy with a locally-trusted
  certificate, which is a much bigger trust/security trade-off than the rest of this app.

## Running it

```bash
npm install
npm start
```

## Building installers

```bash
npm run dist
```

Uses `electron-builder`; see `package.json`'s `build` field for per-platform targets.

## Project structure

```
src/
  main/         Electron main process
    main.js             app lifecycle, window, tray, IPC handlers
    store.js             persisted JSON store (electron-store)
    hostsBlocker.js       hosts-file read/write + elevation (block mode)
    proxyBlocker.js       local CONNECT-capable proxy (allow mode / "Lock the Internet")
    systemProxy.js        OS system-proxy toggling per platform
    appBlocker.js         process listing + force-kill for blocked native apps
    presetBlocklists.js   curated one-click blocklist categories
    sessionEngine.js      session start/stop, schedule matching, restart-persistence
    preload.js            contextBridge API exposed to the renderer
  renderer/     UI (plain HTML/CSS/JS, no framework)
scripts/generate-icons.js   generates the placeholder app/tray icons in assets/
```
