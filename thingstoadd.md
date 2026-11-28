1. Trackpad gestures. I found no gesture handling at all. Three-finger swipe up for Mission Control, sideways to switch Spaces, pinch for Launchpad, two-finger swipe for back and forward in the Browser and Files. This would do the most to make it feel like macOS. On X11 you can read gestures through libinput (or touchegg); on Wayland they're built in, which is one more reason for your planned Wayland move.
3. Stage Manager, and Split View (full-screen two apps side by side).

8. Disk Utility (format, erase, SMART status, mount images; udisks2 is already a dependency)
12. Font Book
14. Missing Settings panes: Users & Groups (more than your own account), Date & Time (time zone and NTP; the installer sets these once and there's no way to change them later), Firewall, Sharing (SSH and file sharing on or off), Startup Disk / default boot entry, and Storage (what's using space, empty Trash, clear the package cache).
16. Window tabs and Picture in Picture for videos in the Browser.
17. Show OS updates in the DE: let Settings › General › Software Update hand off to Lumen's Software Update when ID=lumen, so there's only one place to update.
18. Text Replacement (Settings › Keyboard) and a system Color Picker (Digital Color Meter).
