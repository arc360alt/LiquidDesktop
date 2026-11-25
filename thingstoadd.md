Trackpad gestures. I found no gesture handling at all. Three-finger swipe up for Mission Control, sideways to switch Spaces, pinch for Launchpad, two-finger swipe for back and forward in the Browser and Files. This would do the most to make it feel like macOS. On X11 you can read gestures through libinput (or touchegg); on Wayland they're built in, which is one more reason for your planned Wayland move.
Time Machine–style Backups in Settings or as an app: hourly Btrfs snapshots of /home (or restic to an external drive), a timeline, and "Restore this file". It pairs with OS item 1.
Stage Manager, and Split View (full-screen two apps side by side).
Accessibility pane: a screen reader (Orca), zoom/magnifier, reduce motion, a bigger cursor, high contrast, sticky keys. Right now there's only a single mention of accessibility in the code.
AirDrop-style sharing over KDE Connect (you already run its daemon): "Share › Nearby devices" in Files and in right-click menus.
Universal Clipboard: sync the clipboard with your phone through KDE Connect, connected to the clipboard history you already have.
Live Text: select text in images in Preview and in screenshots with tesseract.
Missing built-in apps:
Disk Utility (format, erase, SMART status, mount images; udisks2 is already a dependency)
Archive Utility (double-click a .zip or .tar to extract)
Photos and Music
Clock (world clock, alarms, timers)
Font Book
Console (journal viewer), which would also help users send you bug reports
Missing Settings panes: Users & Groups (more than your own account), Date & Time (time zone and NTP; the installer sets these once and there's no way to change them later), Firewall, Sharing (SSH and file sharing on or off), Startup Disk / default boot entry, and Storage (what's using space, empty Trash, clear the package cache).
Finder extras: coloured tags, Smart Folders (saved searches), tabs in Files, and Spotlight searching file contents through an index such as localsearch or recoll.
Window tabs and Picture in Picture for videos in the Browser.
Show OS updates in the DE: let Settings › General › Software Update hand off to Lumen's Software Update when ID=lumen, so there's only one place to update.
Text Replacement (Settings › Keyboard) and a system Color Picker (Digital Color Meter).
