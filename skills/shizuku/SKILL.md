---
name: shizuku
description: See the phone's files and control apps on this Android phone through Shizuku. Use whenever the user asks about phone files, photos, downloads, notifications, or other apps.
---

# Phone access through Shizuku

`shizuku` sends one command to the phone's shell through Shizuku. It prints
stdout and stderr and exits with the command's exit code. Every call runs live,
so Shizuku can show its Allow popup at that moment; nothing leaves the phone.

## Check first

    shizuku status

It exits non-zero when phone access is not usable and prints one plain
sentence. The four cases:

- **Shizuku is not installed**: "Shizuku is not installed on this phone. Install
  it from Google Play https://play.google.com/store/apps/details?id=moe.shizuku.privileged.api
  or GitHub https://github.com/RikkaApps/Shizuku/releases, then open Codex
  ondev, go to Settings, and tap Phone access (Shizuku) to allow it."
- **Shizuku is not running**: "Shizuku is installed but not running. Open
  Shizuku and tap Start. On Android 11 and newer this uses Wireless debugging
  and needs no computer, but it has to be started again after a phone restart."
- **No permission**: "Codex ondev needs phone access. Tap Allow on the Shizuku
  popup." If no popup appears, say to open Settings from the toolbar and tap
  Phone access (Shizuku).
- **Connected**: `shizuku: connected as shell user (uid 2000) via socket` (or
  `via rish`). Then run commands normally. If a command later times out, tell
  the user to disable battery optimization for Codex ondev; do not mention it
  for any other error.

Tell the user the matching sentence in one or two plain sentences, with the
links when they are missing Shizuku. Do not try to start Shizuku yourself and do
not mention paths, sockets, uids, or "this environment".

## Usage

    shizuku "pm list packages | grep my.app"
    shizuku "dumpsys activity activities | head -40"

Commands run through `/system/bin/sh -c`, so pipes, redirects, and quoting work
inside the quoted command.

Commands stream and have no default time limit. For long-running ones such as
logcat, cap them explicitly and the command is stopped at that point:

    shizuku -d 20 "logcat -d | tail -40"
    shizuku --timeout 120 "some long command"

## Recipes

- Packages: `shizuku "pm list packages -3"`
- Launch: `shizuku "am start -a android.intent.action.VIEW -d https://example.com"`
- Tap: `shizuku "input tap 360 640"`
- Type: `shizuku "input text 'hello world'"`
- Key event: `shizuku "input keyevent 3"`
- Screenshot: `shizuku "screencap -p /data/local/tmp/screen.png"` then
  `shizuku "ls -l /data/local/tmp/screen.png"`
- Settings: `shizuku "settings get global airplane_mode_on"`
- Dumpsys: `shizuku "dumpsys battery"`

## Phone files

List and read what is on the phone:

    shizuku "ls -l /sdcard/Download"
    shizuku "ls -l /sdcard/DCIM/Camera | tail -20"
    shizuku "ls -l /sdcard/Documents /sdcard/Pictures"
    shizuku "cat /sdcard/Download/notes.txt"

Copy files byte-exact with the built-in pull and push; both check sha256:

    shizuku pull /sdcard/Download/report.pdf report.pdf
    shizuku pull /sdcard/DCIM/Camera/IMG_0001.jpg photo.jpg
    shizuku push out.txt /sdcard/Download/out.txt

Use pull for any phone file, including images and zips; do not pipe `cat`
through the shell for binary data.

## Safety

Ask the user before uninstalling packages, clearing app data, rebooting, wiping
or deleting user files, or changing settings that can break the device. Never
run those destructive commands without explicit approval.
