# liquid-wl-bridge: Wayland apps (Android through Waydroid) as ordinary X11 windows in LiquidDesktop's
# X11 session. Build: meson setup build && meson compile -C build
project('liquid-wl-bridge', 'c', version: '0.1.0', default_options: ['c_std=c11', 'warning_level=2', 'buildtype=release'])
add_project_arguments('-DWLR_USE_UNSTABLE', '-D_POSIX_C_SOURCE=200809L', '-Wno-unused-parameter', language: 'c')

wlroots = dependency('wlroots-0.20')
wayland_server = dependency('wayland-server')
wayland_protocols = dependency('wayland-protocols')
xkbcommon = dependency('xkbcommon')
xcb = dependency('xcb')

scanner = find_program(dependency('wayland-scanner', native: true).get_variable('wayland_scanner'))
protocols = wayland_protocols.get_variable('pkgdatadir')
protocol_sources = []
foreach p : [['stable/xdg-shell/xdg-shell.xml', 'xdg-shell-protocol'], ['unstable/xdg-decoration/xdg-decoration-unstable-v1.xml', 'xdg-decoration-unstable-v1-protocol']]
  xml = protocols / p[0]
  protocol_sources += custom_target(p[1] + '.h', input: xml, output: p[1] + '.h', command: [scanner, 'server-header', '@INPUT@', '@OUTPUT@'])
  protocol_sources += custom_target(p[1] + '.c', input: xml, output: p[1] + '.c', command: [scanner, 'private-code', '@INPUT@', '@OUTPUT@'])
endforeach

executable('liquid-wl-bridge', ['main.c', protocol_sources], dependencies: [wlroots, wayland_server, xkbcommon, xcb], install: true)
