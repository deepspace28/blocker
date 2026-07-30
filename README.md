# FocusLock

A personal distraction blocker for your desktop, inspired by Freedom. Block distracting
websites and apps for a set duration, invert it into an allowlist with "Lock the Internet,"
set recurring schedules, and use hard mode when you don't trust yourself with an "off" switch.

## Two pieces

- **The desktop app** (this repo's `src/`) — your control panel: blocklist, allowlist, blocked
  apps, sessions, schedules, stats. No admin/root permission is ever required to run it or use
  it. It also force-closes any native apps you've blocked (e.g. Discord, Steam), which likewise
  needs no elevation.
- **The browser extension** (`extension/`) — actually enforces website blocking, inside whichever
  browser it's installed in. When you try to visit a blocked site, it redirects you to a full-page
  "You are free from your loop" screen instead of the site.

The desktop app runs a tiny localhost-only API on `127.0.0.1:38219` that only your own machine
can reach; the extension keeps a long-poll open against it, so a session starting or stopping
reaches the browser in milliseconds. Neither side needs a password, an admin prompt, or a
hosts-file edit — this is the deliberate replacement for the earlier version, which used a
hosts-file/sudo-prompt approach that popped an OS permission dialog on every session start/stop.

**If the extension isn't installed or the app isn't running, the app says so** — a red
"Extension not detected" pill in the header and a banner with install instructions. Blocking
failing silently was the single most confusing failure mode, so it's now impossible to miss.

**Trade-off worth knowing:** since blocking now happens inside the browser rather than at the OS
network level, it only covers browsers that have the extension installed — not other browsers, not
non-browser apps that hit the network directly. If you want a specific browser blocked, install the
extension there.

## Installing the browser extension

This isn't published to the Chrome Web Store (that requires a developer account and review), so
you load it as an "unpacked" extension — takes under a minute:

1. Open `chrome://extensions` (or `edge://extensions` for Edge, `brave://extensions` for Brave —
   any Chromium-based browser works).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this repo's `extension/` folder.
4. Done. It'll show "FocusLock Blocker" in your extensions list and start polling the desktop app
   automatically.

(Firefox isn't supported yet — its Manifest V3 `declarativeNetRequest` support differs enough
that it'd need a separate build.)

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
  or restart the app. As long as the FocusLock app is running in the background (it minimizes to
  the tray instead of quitting during hard mode), the extension keeps seeing the session as
  active and keeps enforcing it.
- **Recurring schedules** — e.g. "block social media Mon-Fri 9am-5pm" — auto-starts (and can be
  hard-mode, and can be either block or allow mode) whenever FocusLock is running.
- **Stats & history** — sessions completed, total time blocked, and a day streak.

## How blocking works

The extension enforces in two deliberate layers:

1. **`declarativeNetRequest` rules** — the fast, steady-state blocker.
   - *Block mode*: a redirect-to-`blocked.html` rule per blocklist domain.
   - *Allow mode*: a high-priority `allow` rule per allowlist domain, plus a catch-all redirect.
   - Both modes always exempt `127.0.0.1:38219` so FocusLock's own status page stays reachable
     for diagnosis mid-session.
2. **Direct tab redirection** — a safety net driven by cached session state. DNR rules apply
   asynchronously, so a navigation that begins before they land would otherwise slip through.
   This layer also sweeps tabs that were *already open* when the session started, which DNR
   rules never revisit on their own.

Layer 2 exists because of two bugs found by end-to-end testing: the very first navigation after
starting a session used to load the real site, and an already-open tab was never blocked at all.
Both are covered by regression tests now.

If the extension can't reach the status API (e.g. the FocusLock app isn't running), it leaves
whatever rules were already in place rather than clearing them — so a brief app hiccup doesn't
silently lift a block.

**App blocking** periodically lists running processes (`tasklist`/`ps`) and force-kills any whose
executable name matches an entry in your blocked-apps list — checked every few seconds, so a
relaunch gets closed again almost immediately.

**Limitation:** like most lightweight blockers (including Freedom itself), none of this stops
someone with real technical know-how from disabling the extension, using a different browser, or
force-quitting the FocusLock app process via Task Manager/Activity Monitor. The friction is the
point — this is meant to block casual "just checking Twitter for a second," not a determined
adversary.

## Not included (yet)

- Cross-device sync / mobile apps — would need a hosted backend and account system.
- Firefox/Safari extension builds.
- Freedom's "Pace" soft-friction delay screen.

## Running it

```bash
npm install
npm start
```

Then install the browser extension (see above) so blocking actually takes effect.

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
    statusServer.js       localhost-only API: /status, /events long-poll, heartbeat
    appBlocker.js         process listing + force-kill for blocked native apps
    presetBlocklists.js   curated one-click blocklist categories
    sessionEngine.js      session start/stop, schedule matching, restart-persistence
    preload.js            contextBridge API exposed to the renderer
  renderer/     UI (plain HTML/CSS/JS, no framework)
extension/      Chromium browser extension (Manifest V3)
  manifest.json
  background.js          long-polls statusServer; DNR rules + tab-level enforcement
  blocked.html/.js       the "You are free from your loop" block page, with countdown
  popup.html/.js         toolbar popup: session state and connection status
scripts/generate-icons.js   generates the placeholder app/tray/extension icons
```
