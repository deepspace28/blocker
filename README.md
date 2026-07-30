# FocusLock

A personal distraction blocker for your desktop, inspired by Freedom. Block distracting
websites for a set duration, set recurring schedules, and use hard mode when you don't
trust yourself with an "off" switch.

## Features

- **Blocklist** — maintain a list of sites (social media, news, etc.) to block during sessions.
- **Focus sessions** — start a timed session (e.g. 25 minutes, 2 hours) that blocks every site
  on your blocklist.
- **Hard mode** — once a hard-mode session starts, it can't be stopped early, even if you quit
  or restart the app. The block is re-applied automatically on launch until the timer runs out.
- **Recurring schedules** — e.g. "block social media Mon-Fri 9am-5pm" — auto-starts (and can be
  hard-mode) whenever FocusLock is running.
- **Stats & history** — sessions completed, total time blocked, and a day streak.

## How blocking works

FocusLock redirects each domain on your blocklist to `127.0.0.1` inside a clearly marked,
managed section of your OS hosts file (`/etc/hosts` on macOS/Linux, `System32\drivers\etc\hosts`
on Windows). Editing the hosts file requires admin privileges, so the app will prompt you for
your password (via Touch ID/Keychain on macOS, UAC on Windows, or polkit on Linux) the first
time you start or stop a session.

**Limitation:** like most lightweight blockers, this doesn't stop someone with admin access and
technical know-how from manually editing the hosts file outside the app, or from using a VPN/DNS
override. The friction is the point — this is meant to block casual "just checking Twitter for a
second," not a determined adversary.

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
    main.js         app lifecycle, window, tray, IPC handlers
    store.js         persisted JSON store (electron-store)
    hostsBlocker.js   hosts-file read/write + elevation
    sessionEngine.js  session start/stop, schedule matching, restart-persistence
    preload.js        contextBridge API exposed to the renderer
  renderer/     UI (plain HTML/CSS/JS, no framework)
scripts/generate-icons.js   generates the placeholder app/tray icons in assets/
```
