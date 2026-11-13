// liquid-wl-bridge: a small Wayland server that shows every Wayland window as its own X11 window.
//
// LiquidDesktop's session is X11; Waydroid (Android) and other Wayland-only apps need a Wayland display.
// This is that display, the other way round from Xwayland: each window a Wayland app opens becomes an
// ordinary top-level X11 window (one wlroots X11-backend "output" per window, sized to it), so the X11
// window manager frames, moves, resizes and focuses it like any other app.
//
//   liquid-wl-bridge [--socket NAME] [--no-activate] [--crop-to-content]   prints "WAYLAND_DISPLAY=NAME" once ready
//
// The X11 side: window title = the app's title; WM_CLASS = the app's id (Waydroid: waydroid.<package>,
// matching the .desktop files Waydroid writes, so the Dock shows the right icon). Keyboard focus follows the
// window manager's _NET_ACTIVE_WINDOW; the pointer goes to whichever window it's over.
#define _GNU_SOURCE
#include <getopt.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wayland-server-core.h>
#include <wlr/backend.h>
#include <wlr/backend/x11.h>
#include <wlr/render/allocator.h>
#include <wlr/render/wlr_renderer.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_cursor_shape_v1.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_subcompositor.h>
#include <wlr/types/wlr_viewporter.h>
#include <wlr/types/wlr_xdg_decoration_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>
#include <xcb/xcb.h>
#include <xkbcommon/xkbcommon.h>

// every window's content lives in one scene, each far apart, each shown by its own output
#define SLOT_SPACING 20000
#define DEFAULT_W 420
#define DEFAULT_H 760

struct server {
	struct wl_display *display;
	struct wl_event_loop *loop;
	struct wlr_backend *backend;
	struct wlr_renderer *renderer;
	struct wlr_allocator *allocator;
	struct wlr_scene *scene;
	struct wlr_xdg_shell *xdg_shell;
	struct wlr_seat *seat;
	struct wl_list views;      // struct view.link
	struct wl_list keyboards;  // struct keyboard.link
	int next_slot;
	struct view *focused;

	xcb_connection_t *xcb;
	xcb_window_t root;
	xcb_atom_t a_wm_class, a_net_wm_name, a_utf8, a_net_active, a_wm_name;
	struct wl_event_source *xcb_source;

	struct wl_listener new_output, new_input, new_toplevel, new_popup, new_decoration;
	struct wl_listener request_cursor, request_selection, request_shape;
	// the pointer image (the X11 backend hides X's own pointer over its windows): drawn as each window's cursor
	struct wlr_output_layout *layout;
	struct wlr_cursor *cursor;
	struct wlr_xcursor_manager *xcursors;
};

struct view {
	struct wl_list link;
	struct server *server;
	struct wlr_xdg_toplevel *toplevel;
	struct wlr_scene_tree *tree;
	struct wlr_output *output;
	struct wlr_scene_output *scene_output;
	xcb_window_t xwin;
	int slot, w, h;
	bool mapped, closing;
	char *last_log;
	struct wlr_box content;   // --crop-to-content: the part of the window that's shown
	struct wl_listener map, unmap, commit, destroy, set_title, set_app_id;
	struct wl_listener out_frame, out_request_state, out_destroy;
};

struct keyboard {
	struct wl_list link;
	struct server *server;
	struct wlr_keyboard *wlr;
	struct wl_listener key, modifiers, destroy;
};

struct pointer {
	struct server *server;
	struct wlr_pointer *wlr;
	struct wl_listener motion_absolute, button, axis, frame, destroy;
	struct view *over;   // window the pointer is in
};

struct popup {
	struct wlr_xdg_popup *xdg;
	struct wl_listener commit, destroy;
};

struct decoration {
	struct wlr_xdg_toplevel_decoration_v1 *wlr;
	struct wl_listener request_mode, destroy;
};

static struct server server;
static bool verbose_log = false;
// --crop-to-content (Android): Waydroid's multi-window mode makes every window as big as the whole Android
// screen, with the app as sub-surfaces at its place on it. The window shown is just those sub-surfaces;
// and its size is the app's to change (asking Waydroid to resize would resize the whole Android screen).
static bool crop = false;

/* ------------------------------------------------------------------ X11 side (our own connection) */
static xcb_atom_t atom(const char *name) {
	xcb_intern_atom_reply_t *r = xcb_intern_atom_reply(server.xcb, xcb_intern_atom(server.xcb, 0, strlen(name), name), NULL);
	xcb_atom_t a = r ? r->atom : XCB_ATOM_NONE;
	free(r);
	return a;
}

// a window's title (_NET_WM_NAME, which is what wlroots sets, or the old WM_NAME)
static char *window_name(xcb_window_t w) {
	char *s = NULL;
	xcb_atom_t which[2] = { server.a_net_wm_name, server.a_wm_name };
	for (int i = 0; i < 2 && !s; i++) {
		xcb_get_property_reply_t *r = xcb_get_property_reply(server.xcb,
			xcb_get_property(server.xcb, 0, w, which[i], XCB_ATOM_ANY, 0, 256), NULL);
		if (r && xcb_get_property_value_length(r) > 0) s = strndup(xcb_get_property_value(r), xcb_get_property_value_length(r));
		free(r);
	}
	return s;
}

// the X11 window wlroots made for an output: found by the unique title it's given first.
// It may already be inside the window manager's frame, so look a few levels down.
static xcb_window_t find_window(xcb_window_t parent, const char *title, int depth) {
	xcb_query_tree_reply_t *t = xcb_query_tree_reply(server.xcb, xcb_query_tree(server.xcb, parent), NULL);
	if (!t) return 0;
	xcb_window_t found = 0;
	xcb_window_t *kids = xcb_query_tree_children(t);
	int n = xcb_query_tree_children_length(t);
	for (int i = 0; i < n && !found; i++) {
		char *s = window_name(kids[i]);
		if (s && strcmp(s, title) == 0) found = kids[i];
		free(s);
	}
	for (int i = 0; i < n && !found && depth > 0; i++) found = find_window(kids[i], title, depth - 1);
	free(t);
	return found;
}

static void set_x_identity(struct view *v) {
	if (!v->xwin) return;
	const char *id = v->toplevel->app_id && *v->toplevel->app_id ? v->toplevel->app_id : "wayland-app";
	// WM_CLASS is "instance\0class\0"
	size_t n = strlen(id);
	char *cls = malloc(2 * n + 2);
	memcpy(cls, id, n + 1);
	memcpy(cls + n + 1, id, n + 1);
	xcb_change_property(server.xcb, XCB_PROP_MODE_REPLACE, v->xwin, server.a_wm_class, XCB_ATOM_STRING, 8, 2 * n + 2, cls);
	free(cls);
	xcb_flush(server.xcb);
}

// min = max size: the window manager doesn't offer resizing (WM_NORMAL_HINTS, flags PMinSize|PMaxSize)
static void set_fixed_size_hints(struct view *v, int w, int h) {
	if (!v->xwin || w <= 0 || h <= 0) return;
	uint32_t hints[18] = { 0 };
	hints[0] = 16 | 32;
	hints[5] = w; hints[6] = h; hints[7] = w; hints[8] = h;
	xcb_change_property(server.xcb, XCB_PROP_MODE_REPLACE, v->xwin, XCB_ATOM_WM_NORMAL_HINTS, XCB_ATOM_WM_SIZE_HINTS, 32, 18, hints);
	xcb_flush(server.xcb);
}

static void set_title(struct view *v) {
	if (!v->output) return;
	const char *t = v->toplevel->title && *v->toplevel->title ? v->toplevel->title : (v->toplevel->app_id ? v->toplevel->app_id : "Window");
	wlr_x11_output_set_title(v->output, t);
}

// Waydroid re-creates an app's display on every window configure that carries a size (waydroid#2436), which
// wipes the app: so its windows don't get the "activated" state, whose configure would carry one
static bool no_activate = false;   // --no-activate: for all windows (Android uses it)
static bool is_waydroid(struct view *v) { return no_activate || (v->toplevel->app_id && strncmp(v->toplevel->app_id, "waydroid.", 9) == 0); }
static void set_activated(struct view *v, bool on) { if (!is_waydroid(v)) wlr_xdg_toplevel_set_activated(v->toplevel, on); }

static void focus_view(struct view *v) {
	struct server *s = &server;
	if (s->focused == v) return;
	if (s->focused && s->focused->mapped) set_activated(s->focused, false);
	s->focused = v;
	if (!v) { wlr_seat_keyboard_notify_clear_focus(s->seat); return; }
	set_activated(v, true);
	struct wlr_keyboard *kb = wlr_seat_get_keyboard(s->seat);
	if (kb) wlr_seat_keyboard_notify_enter(s->seat, v->toplevel->base->surface, kb->keycodes, kb->num_keycodes, &kb->modifiers);
	else wlr_seat_keyboard_notify_enter(s->seat, v->toplevel->base->surface, NULL, 0, NULL);
}

// the window manager says which window is active: give that one the keyboard
static void check_active(void) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(server.xcb,
		xcb_get_property(server.xcb, 0, server.root, server.a_net_active, XCB_ATOM_WINDOW, 0, 1), NULL);
	xcb_window_t w = 0;
	if (r && xcb_get_property_value_length(r) >= 4) w = *(xcb_window_t *)xcb_get_property_value(r);
	free(r);
	struct view *v, *hit = NULL;
	wl_list_for_each(v, &server.views, link) if (v->xwin && v->xwin == w) hit = v;
	if (hit) focus_view(hit);
	else if (server.focused) focus_view(NULL);
}

static int on_xcb(int fd, uint32_t mask, void *data) {
	xcb_generic_event_t *ev;
	bool active = false;
	while ((ev = xcb_poll_for_event(server.xcb))) {
		if ((ev->response_type & ~0x80) == XCB_PROPERTY_NOTIFY && ((xcb_property_notify_event_t *)ev)->atom == server.a_net_active) active = true;
		free(ev);
	}
	if (active) check_active();
	if (xcb_connection_has_error(server.xcb)) { wl_display_terminate(server.display); return 0; }
	return 0;
}

static bool xcb_setup(void) {
	server.xcb = xcb_connect(NULL, NULL);
	if (xcb_connection_has_error(server.xcb)) return false;
	server.root = xcb_setup_roots_iterator(xcb_get_setup(server.xcb)).data->root;
	server.a_wm_class = XCB_ATOM_WM_CLASS;
	server.a_wm_name = XCB_ATOM_WM_NAME;
	server.a_net_wm_name = atom("_NET_WM_NAME");
	server.a_utf8 = atom("UTF8_STRING");
	server.a_net_active = atom("_NET_ACTIVE_WINDOW");
	uint32_t ev = XCB_EVENT_MASK_PROPERTY_CHANGE;
	xcb_change_window_attributes(server.xcb, server.root, XCB_CW_EVENT_MASK, &ev);
	xcb_flush(server.xcb);
	server.xcb_source = wl_event_loop_add_fd(server.loop, xcb_get_file_descriptor(server.xcb), WL_EVENT_READABLE, on_xcb, NULL);
	return true;
}

/* ------------------------------------------------------------------ one X11 window (output) per Wayland window */
static struct wlr_box shown_box(struct view *v);
static void place(struct view *v);
static void set_fixed_size_hints(struct view *v, int w, int h);

static void resize_output(struct view *v, int w, int h) {
	if (!v->output || w <= 0 || h <= 0 || (w == v->w && h == v->h)) return;
	struct wlr_output_state st;
	wlr_output_state_init(&st);
	wlr_output_state_set_custom_mode(&st, w, h, 0);
	if (wlr_output_commit_state(v->output, &st)) { v->w = w; v->h = h; }
	wlr_output_state_finish(&st);
}

static void out_frame(struct wl_listener *l, void *data) {
	struct view *v = wl_container_of(l, v, out_frame);
	if (!v->scene_output) return;
	if (crop && v->mapped) place(v);
	wlr_scene_output_commit(v->scene_output, NULL);
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	wlr_scene_output_send_frame_done(v->scene_output, &now);
}

// the X11 window was resized (by the window manager / the person): tell the app its new size
static void out_request_state(struct wl_listener *l, void *data) {
	struct view *v = wl_container_of(l, v, out_request_state);
	const struct wlr_output_event_request_state *ev = data;
	wlr_output_commit_state(v->output, ev->state);
	if (crop) {   // the app's size isn't ours to change: back to it
		int w = v->content.width, h = v->content.height;
		v->w = v->output->width; v->h = v->output->height;
		if (w > 0 && h > 0) resize_output(v, w, h);
		return;
	}
	if (v->output->width != v->w || v->output->height != v->h) {
		v->w = v->output->width; v->h = v->output->height;
		wlr_xdg_toplevel_set_size(v->toplevel, v->w, v->h);
	}
}

// the X11 window was closed (its close button): ask the app to close the window
static void out_destroy(struct wl_listener *l, void *data) {
	struct view *v = wl_container_of(l, v, out_destroy);
	wl_list_remove(&v->out_frame.link);
	wl_list_remove(&v->out_request_state.link);
	wl_list_remove(&v->out_destroy.link);
	wlr_output_layout_remove(server.layout, v->output);
	v->output = NULL;
	v->scene_output = NULL;   // the scene output goes with its output
	v->xwin = 0;
	if (server.focused == v) server.focused = NULL;
	if (!v->closing && v->mapped) wlr_xdg_toplevel_send_close(v->toplevel);
}

static void create_window(struct view *v) {
	struct server *s = v->server;
	struct wlr_box b = shown_box(v);
	int w = b.width > 0 ? b.width : DEFAULT_W, h = b.height > 0 ? b.height : DEFAULT_H;
	v->output = wlr_x11_output_create(s->backend);
	if (!v->output) return;
	wlr_output_init_render(v->output, s->allocator, s->renderer);
	// a unique title first, to find the X11 window; then the real one
	char token[64];
	snprintf(token, sizeof token, "liquid-wl-bridge:%d:%d", getpid(), v->slot);
	wlr_x11_output_set_title(v->output, token);
	struct wlr_output_state st;
	wlr_output_state_init(&st);
	wlr_output_state_set_enabled(&st, true);
	wlr_output_state_set_custom_mode(&st, w, h, 0);
	wlr_output_commit_state(v->output, &st);
	wlr_output_state_finish(&st);
	v->w = v->output->width; v->h = v->output->height;
	v->scene_output = wlr_scene_output_create(s->scene, v->output);
	wlr_scene_output_set_position(v->scene_output, v->slot * SLOT_SPACING, 0);
	wlr_output_layout_add(s->layout, v->output, v->slot * SLOT_SPACING, 0);   // where the cursor can be
	v->out_frame.notify = out_frame;
	wl_signal_add(&v->output->events.frame, &v->out_frame);
	v->out_request_state.notify = out_request_state;
	wl_signal_add(&v->output->events.request_state, &v->out_request_state);
	v->out_destroy.notify = out_destroy;
	wl_signal_add(&v->output->events.destroy, &v->out_destroy);
	// wlroots sets the title with its own connection: make sure it's there before looking
	for (int i = 0; i < 20 && !v->xwin; i++) {
		v->xwin = find_window(s->root, token, 3);
		if (!v->xwin) usleep(5000);
	}
	if (getenv("LIQUID_WLBRIDGE_DEBUG")) fprintf(stderr, "window %d: X11 id 0x%x, app id %s\n", v->slot, v->xwin, v->toplevel->app_id ? v->toplevel->app_id : "-");
	set_x_identity(v);
	set_title(v);
}

/* ------------------------------------------------------------------ Wayland windows */
// the part of the window to show, in the toplevel surface's coordinates
static struct wlr_box shown_box(struct view *v) {
	struct wlr_box g = v->toplevel->base->geometry;
	if (!crop) return g;
	struct wlr_surface *srf = v->toplevel->base->surface;
	int x1 = 0, y1 = 0, x2 = 0, y2 = 0;
	bool any = false;
	struct wlr_subsurface *sub;
	struct wl_list *lists[2] = { &srf->current.subsurfaces_above, &srf->current.subsurfaces_below };
	for (int i = 0; i < 2; i++) wl_list_for_each(sub, lists[i], current.link) {
		struct wlr_surface *ss = sub->surface;
		if (!ss->mapped || ss->current.width < 2 || ss->current.height < 2) continue;
		int ax = sub->current.x, ay = sub->current.y, bx = ax + ss->current.width, by = ay + ss->current.height;
		// a layer covering the whole Android screen is a background, not the app
		if (ss->current.width >= g.width && ss->current.height >= g.height) continue;
		if (!any) { x1 = ax; y1 = ay; x2 = bx; y2 = by; any = true; }
		else { if (ax < x1) x1 = ax; if (ay < y1) y1 = ay; if (bx > x2) x2 = bx; if (by > y2) y2 = by; }
	}
	if (!any) return g;
	return (struct wlr_box){ .x = x1, .y = y1, .width = x2 - x1, .height = y2 - y1 };
}

static void place(struct view *v) {
	struct wlr_box b = shown_box(v);
	wlr_scene_node_set_position(&v->tree->node, v->slot * SLOT_SPACING - b.x, -b.y);
	if (crop && v->mapped && v->output && (b.width != v->content.width || b.height != v->content.height || b.x != v->content.x || b.y != v->content.y)) {
		v->content = b;
		resize_output(v, b.width, b.height);
		set_fixed_size_hints(v, b.width, b.height);
	}
}

static void view_map(struct wl_listener *l, void *data) {
	struct view *v = wl_container_of(l, v, map);
	v->mapped = true;
	v->closing = false;
	place(v);
	create_window(v);
	focus_view(v);   // a new window is the active one (the window manager focuses it too)
}

static void view_unmap(struct wl_listener *l, void *data) {
	struct view *v = wl_container_of(l, v, unmap);
	v->mapped = false;
	if (server.focused == v) focus_view(NULL);
	if (v->output) { v->closing = true; wlr_output_destroy(v->output); }
}

static void view_commit(struct wl_listener *l, void *data) {
	struct view *v = wl_container_of(l, v, commit);
	struct wlr_xdg_surface *xs = v->toplevel->base;
	if (xs->initial_commit) {
		// let the app pick its own size; no client-side decorations wanted (the window manager frames it)
		wlr_xdg_toplevel_set_size(v->toplevel, 0, 0);
		return;
	}
	if (!v->mapped) return;
	// --verbose: what the app sends (sizes, sub-surfaces), whenever it changes, to work out how to frame it
	if (verbose_log) {
		struct wlr_surface *srf = xs->surface;
		char line[512];
		int n = snprintf(line, sizeof line, "%s: buffer %dx%d geometry %d,%d %dx%d", v->toplevel->app_id ? v->toplevel->app_id : "?",
			srf->current.width, srf->current.height, xs->geometry.x, xs->geometry.y, xs->geometry.width, xs->geometry.height);
		struct wlr_subsurface *sub;
		wl_list_for_each(sub, &srf->current.subsurfaces_above, current.link)
			if (n < (int)sizeof line - 40) n += snprintf(line + n, sizeof line - n, " | sub %d,%d %dx%d", sub->current.x, sub->current.y, sub->surface->current.width, sub->surface->current.height);
		wl_list_for_each(sub, &srf->current.subsurfaces_below, current.link)
			if (n < (int)sizeof line - 40) n += snprintf(line + n, sizeof line - n, " | below %d,%d %dx%d", sub->current.x, sub->current.y, sub->surface->current.width, sub->surface->current.height);
		if (!v->last_log || strcmp(v->last_log, line) != 0) { fprintf(stderr, "%s\n", line); free(v->last_log); v->last_log = strdup(line); }
	}
	place(v);
	// the app changed its size itself: the X11 window follows
	if (!crop) resize_output(v, xs->geometry.width, xs->geometry.height);
}

static void view_destroy(struct wl_listener *l, void *data) {
	struct view *v = wl_container_of(l, v, destroy);
	if (server.focused == v) server.focused = NULL;
	if (v->output) { v->closing = true; wlr_output_destroy(v->output); }
	wl_list_remove(&v->map.link);
	wl_list_remove(&v->unmap.link);
	wl_list_remove(&v->commit.link);
	wl_list_remove(&v->destroy.link);
	wl_list_remove(&v->set_title.link);
	wl_list_remove(&v->set_app_id.link);
	wl_list_remove(&v->link);
	free(v->last_log);
	free(v);
}

static void view_set_title(struct wl_listener *l, void *data) { struct view *v = wl_container_of(l, v, set_title); set_title(v); }
static void view_set_app_id(struct wl_listener *l, void *data) { struct view *v = wl_container_of(l, v, set_app_id); set_x_identity(v); }

static void new_toplevel(struct wl_listener *l, void *data) {
	struct wlr_xdg_toplevel *t = data;
	struct view *v = calloc(1, sizeof *v);
	v->server = &server;
	v->toplevel = t;
	v->slot = ++server.next_slot;
	v->tree = wlr_scene_xdg_surface_create(&server.scene->tree, t->base);
	v->tree->node.data = v;
	t->base->data = v->tree;
	v->map.notify = view_map;
	wl_signal_add(&t->base->surface->events.map, &v->map);
	v->unmap.notify = view_unmap;
	wl_signal_add(&t->base->surface->events.unmap, &v->unmap);
	v->commit.notify = view_commit;
	wl_signal_add(&t->base->surface->events.commit, &v->commit);
	v->destroy.notify = view_destroy;
	wl_signal_add(&t->events.destroy, &v->destroy);
	v->set_title.notify = view_set_title;
	wl_signal_add(&t->events.set_title, &v->set_title);
	v->set_app_id.notify = view_set_app_id;
	wl_signal_add(&t->events.set_app_id, &v->set_app_id);
	wl_list_insert(&server.views, &v->link);
}

// popups (menus, dropdowns) draw inside their window; kept inside its edges
static void popup_commit(struct wl_listener *l, void *data) {
	struct popup *p = wl_container_of(l, p, commit);
	if (!p->xdg->base->initial_commit) return;
	struct wlr_xdg_surface *top = p->xdg->parent ? wlr_xdg_surface_try_from_wlr_surface(p->xdg->parent) : NULL;
	while (top && top->role == WLR_XDG_SURFACE_ROLE_POPUP && top->popup->parent) top = wlr_xdg_surface_try_from_wlr_surface(top->popup->parent);
	if (top && top->role == WLR_XDG_SURFACE_ROLE_TOPLEVEL) {
		struct wlr_box box = { .x = 0, .y = 0, .width = top->geometry.width, .height = top->geometry.height };
		// the box is in the toplevel's surface coordinates: its window geometry starts at geometry.x/y
		box.x = top->geometry.x; box.y = top->geometry.y;
		wlr_xdg_popup_unconstrain_from_box(p->xdg, &box);
	}
	wlr_xdg_surface_schedule_configure(p->xdg->base);
}
static void popup_destroy(struct wl_listener *l, void *data) {
	struct popup *p = wl_container_of(l, p, destroy);
	wl_list_remove(&p->commit.link);
	wl_list_remove(&p->destroy.link);
	free(p);
}
static void new_popup(struct wl_listener *l, void *data) {
	struct wlr_xdg_popup *xp = data;
	struct wlr_xdg_surface *parent = xp->parent ? wlr_xdg_surface_try_from_wlr_surface(xp->parent) : NULL;
	if (!parent || !parent->data) return;
	struct wlr_scene_tree *tree = wlr_scene_xdg_surface_create(parent->data, xp->base);
	xp->base->data = tree;
	struct popup *p = calloc(1, sizeof *p);
	p->xdg = xp;
	p->commit.notify = popup_commit;
	wl_signal_add(&xp->base->surface->events.commit, &p->commit);
	p->destroy.notify = popup_destroy;
	wl_signal_add(&xp->events.destroy, &p->destroy);
}

// window decorations: always the window manager's (server side), never the app's own
static void deco_set(struct decoration *d) {
	if (d->wlr->toplevel->base->initialized) wlr_xdg_toplevel_decoration_v1_set_mode(d->wlr, WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE);
}
static void deco_request(struct wl_listener *l, void *data) { struct decoration *d = wl_container_of(l, d, request_mode); deco_set(d); }
static void deco_destroy(struct wl_listener *l, void *data) {
	struct decoration *d = wl_container_of(l, d, destroy);
	wl_list_remove(&d->request_mode.link);
	wl_list_remove(&d->destroy.link);
	free(d);
}
static void new_decoration(struct wl_listener *l, void *data) {
	struct decoration *d = calloc(1, sizeof *d);
	d->wlr = data;
	d->request_mode.notify = deco_request;
	wl_signal_add(&d->wlr->events.request_mode, &d->request_mode);
	d->destroy.notify = deco_destroy;
	wl_signal_add(&d->wlr->events.destroy, &d->destroy);
	deco_set(d);
}

/* ------------------------------------------------------------------ input */
static struct view *view_for_output_name(const char *name) {
	struct view *v;
	if (!name) return NULL;
	wl_list_for_each(v, &server.views, link) if (v->output && strcmp(v->output->name, name) == 0) return v;
	return NULL;
}

static void kb_key(struct wl_listener *l, void *data) {
	struct keyboard *k = wl_container_of(l, k, key);
	struct wlr_keyboard_key_event *ev = data;
	wlr_seat_set_keyboard(server.seat, k->wlr);
	if (!server.focused) check_active();
	wlr_seat_keyboard_notify_key(server.seat, ev->time_msec, ev->keycode, ev->state);
}
static void kb_modifiers(struct wl_listener *l, void *data) {
	struct keyboard *k = wl_container_of(l, k, modifiers);
	wlr_seat_set_keyboard(server.seat, k->wlr);
	wlr_seat_keyboard_notify_modifiers(server.seat, &k->wlr->modifiers);
}
static void kb_destroy(struct wl_listener *l, void *data) {
	struct keyboard *k = wl_container_of(l, k, destroy);
	wl_list_remove(&k->key.link);
	wl_list_remove(&k->modifiers.link);
	wl_list_remove(&k->destroy.link);
	wl_list_remove(&k->link);
	free(k);
}

static void ptr_motion(struct wl_listener *l, void *data) {
	struct pointer *p = wl_container_of(l, p, motion_absolute);
	struct wlr_pointer_motion_absolute_event *ev = data;
	struct view *v = view_for_output_name(ev->pointer->output_name);
	p->over = v;
	if (!v || !v->scene_output) { wlr_seat_pointer_notify_clear_focus(server.seat); return; }
	double lx = v->slot * SLOT_SPACING + ev->x * v->w, ly = ev->y * v->h, sx, sy;
	wlr_cursor_warp(server.cursor, NULL, lx, ly);
	struct wlr_scene_node *n = wlr_scene_node_at(&server.scene->tree.node, lx, ly, &sx, &sy);
	struct wlr_surface *surface = NULL;
	if (n && n->type == WLR_SCENE_NODE_BUFFER) {
		struct wlr_scene_surface *ss = wlr_scene_surface_try_from_buffer(wlr_scene_buffer_from_node(n));
		if (ss) surface = ss->surface;
	}
	if (!surface) { wlr_seat_pointer_notify_clear_focus(server.seat); wlr_cursor_set_xcursor(server.cursor, server.xcursors, "default"); return; }
	// entering a surface: the default arrow until the app sets its own
	if (server.seat->pointer_state.focused_surface != surface) wlr_cursor_set_xcursor(server.cursor, server.xcursors, "default");
	wlr_seat_pointer_notify_enter(server.seat, surface, sx, sy);
	wlr_seat_pointer_notify_motion(server.seat, ev->time_msec, sx, sy);
}
static void ptr_button(struct wl_listener *l, void *data) {
	struct pointer *p = wl_container_of(l, p, button);
	struct wlr_pointer_button_event *ev = data;
	// a click in a window makes it the keyboard's too (the window manager activates it as well)
	if (ev->state == WL_POINTER_BUTTON_STATE_PRESSED && p->over && p->over != server.focused) focus_view(p->over);
	wlr_seat_pointer_notify_button(server.seat, ev->time_msec, ev->button, ev->state);
}
static void ptr_axis(struct wl_listener *l, void *data) {
	struct wlr_pointer_axis_event *ev = data;
	wlr_seat_pointer_notify_axis(server.seat, ev->time_msec, ev->orientation, ev->delta, ev->delta_discrete, ev->source, ev->relative_direction);
}
static void ptr_frame(struct wl_listener *l, void *data) { wlr_seat_pointer_notify_frame(server.seat); }
static void ptr_destroy(struct wl_listener *l, void *data) {
	struct pointer *p = wl_container_of(l, p, destroy);
	wl_list_remove(&p->motion_absolute.link);
	wl_list_remove(&p->button.link);
	wl_list_remove(&p->axis.link);
	wl_list_remove(&p->frame.link);
	wl_list_remove(&p->destroy.link);
	free(p);
}

static void new_input(struct wl_listener *l, void *data) {
	struct wlr_input_device *dev = data;
	if (dev->type == WLR_INPUT_DEVICE_KEYBOARD) {
		struct keyboard *k = calloc(1, sizeof *k);
		k->server = &server;
		k->wlr = wlr_keyboard_from_input_device(dev);
		struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
		struct xkb_keymap *km = xkb_keymap_new_from_names(ctx, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);   // XKB_DEFAULT_* env decide the layout
		wlr_keyboard_set_keymap(k->wlr, km);
		xkb_keymap_unref(km);
		xkb_context_unref(ctx);
		wlr_keyboard_set_repeat_info(k->wlr, 30, 400);
		k->key.notify = kb_key;
		wl_signal_add(&k->wlr->events.key, &k->key);
		k->modifiers.notify = kb_modifiers;
		wl_signal_add(&k->wlr->events.modifiers, &k->modifiers);
		k->destroy.notify = kb_destroy;
		wl_signal_add(&dev->events.destroy, &k->destroy);
		wl_list_insert(&server.keyboards, &k->link);
		wlr_seat_set_keyboard(server.seat, k->wlr);
	} else if (dev->type == WLR_INPUT_DEVICE_POINTER) {
		struct pointer *p = calloc(1, sizeof *p);
		p->server = &server;
		p->wlr = wlr_pointer_from_input_device(dev);
		p->motion_absolute.notify = ptr_motion;
		wl_signal_add(&p->wlr->events.motion_absolute, &p->motion_absolute);
		p->button.notify = ptr_button;
		wl_signal_add(&p->wlr->events.button, &p->button);
		p->axis.notify = ptr_axis;
		wl_signal_add(&p->wlr->events.axis, &p->axis);
		p->frame.notify = ptr_frame;
		wl_signal_add(&p->wlr->events.frame, &p->frame);
		p->destroy.notify = ptr_destroy;
		wl_signal_add(&dev->events.destroy, &p->destroy);
	}
	uint32_t caps = WL_SEAT_CAPABILITY_POINTER;
	if (!wl_list_empty(&server.keyboards)) caps |= WL_SEAT_CAPABILITY_KEYBOARD;
	wlr_seat_set_capabilities(server.seat, caps);
}

// an app sets its pointer image: a picture of its own, or (cursor-shape protocol) a named one from the theme
static void request_cursor(struct wl_listener *l, void *data) {
	struct wlr_seat_pointer_request_set_cursor_event *ev = data;
	if (ev->seat_client == server.seat->pointer_state.focused_client) wlr_cursor_set_surface(server.cursor, ev->surface, ev->hotspot_x, ev->hotspot_y);
}
static void request_shape(struct wl_listener *l, void *data) {
	struct wlr_cursor_shape_manager_v1_request_set_shape_event *ev = data;
	if (ev->seat_client == server.seat->pointer_state.focused_client) wlr_cursor_set_xcursor(server.cursor, server.xcursors, wlr_cursor_shape_v1_name(ev->shape));
}

static void request_selection(struct wl_listener *l, void *data) {
	struct wlr_seat_request_set_selection_event *ev = data;
	wlr_seat_set_selection(server.seat, ev->source, ev->serial);
}

/* ------------------------------------------------------------------ the monitor apps see */
// Apps expect at least one monitor before they open a window, but the bridge's real outputs only exist per
// window. So: one virtual wl_output the size of the X screen, always there.
static int screen_w = 1920, screen_h = 1080, screen_mm_w = 0, screen_mm_h = 0;
static void output_release(struct wl_client *c, struct wl_resource *r) { wl_resource_destroy(r); }
static const struct wl_output_interface output_impl = { .release = output_release };
static void bind_output(struct wl_client *client, void *data, uint32_t version, uint32_t id) {
	struct wl_resource *r = wl_resource_create(client, &wl_output_interface, version, id);
	if (!r) { wl_client_post_no_memory(client); return; }
	wl_resource_set_implementation(r, &output_impl, NULL, NULL);
	wl_output_send_geometry(r, 0, 0, screen_mm_w, screen_mm_h, WL_OUTPUT_SUBPIXEL_UNKNOWN, "LiquidDesktop", "X11", WL_OUTPUT_TRANSFORM_NORMAL);
	wl_output_send_mode(r, WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED, screen_w, screen_h, 60000);
	if (version >= WL_OUTPUT_SCALE_SINCE_VERSION) wl_output_send_scale(r, 1);
	if (version >= WL_OUTPUT_NAME_SINCE_VERSION) wl_output_send_name(r, "X11");
	if (version >= WL_OUTPUT_DESCRIPTION_SINCE_VERSION) wl_output_send_description(r, "LiquidDesktop screen");
	if (version >= WL_OUTPUT_DONE_SINCE_VERSION) wl_output_send_done(r);
}

/* ------------------------------------------------------------------ */
static int on_signal_quit(int sig, void *data) { wl_display_terminate(server.display); return 0; }

int main(int argc, char **argv) {
	const char *socket_name = NULL;
	static struct option opts[] = { { "socket", required_argument, 0, 's' }, { "verbose", no_argument, 0, 'v' }, { "no-activate", no_argument, 0, 'n' }, { "crop-to-content", no_argument, 0, 'c' }, { 0, 0, 0, 0 } };
	int c;
	while ((c = getopt_long(argc, argv, "s:vnc", opts, NULL)) != -1) {
		if (c == 's') socket_name = optarg;
		else if (c == 'n') no_activate = true;
		else if (c == 'c') crop = true;
		else if (c == 'v') verbose_log = true;   // wlroots' own debug output: set WLR_DEBUG=1
		else { fprintf(stderr, "usage: %s [--socket NAME] [--no-activate] [--crop-to-content] [--verbose]\n", argv[0]); return 2; }
	}
	wlr_log_init(getenv("WLR_DEBUG") ? WLR_DEBUG : WLR_ERROR, NULL);
	if (!getenv("DISPLAY")) { fprintf(stderr, "liquid-wl-bridge: needs an X11 display ($DISPLAY)\n"); return 1; }

	wl_list_init(&server.views);
	wl_list_init(&server.keyboards);
	server.display = wl_display_create();
	server.loop = wl_display_get_event_loop(server.display);
	// only the X11 backend, and no window until an app opens one
	server.backend = wlr_x11_backend_create(server.loop, NULL);
	if (!server.backend) { fprintf(stderr, "liquid-wl-bridge: couldn't open the X11 display\n"); return 1; }
	server.renderer = wlr_renderer_autocreate(server.backend);
	if (!server.renderer) { fprintf(stderr, "liquid-wl-bridge: no renderer\n"); return 1; }
	wlr_renderer_init_wl_display(server.renderer, server.display);   // wl_shm + linux-dmabuf (GPU buffers)
	server.allocator = wlr_allocator_autocreate(server.backend, server.renderer);

	wlr_compositor_create(server.display, 6, server.renderer);
	wlr_subcompositor_create(server.display);
	wlr_data_device_manager_create(server.display);
	wlr_viewporter_create(server.display);
	server.scene = wlr_scene_create();

	server.xdg_shell = wlr_xdg_shell_create(server.display, 6);
	server.new_toplevel.notify = new_toplevel;
	wl_signal_add(&server.xdg_shell->events.new_toplevel, &server.new_toplevel);
	server.new_popup.notify = new_popup;
	wl_signal_add(&server.xdg_shell->events.new_popup, &server.new_popup);
	struct wlr_xdg_decoration_manager_v1 *deco = wlr_xdg_decoration_manager_v1_create(server.display);
	server.new_decoration.notify = new_decoration;
	wl_signal_add(&deco->events.new_toplevel_decoration, &server.new_decoration);

	server.seat = wlr_seat_create(server.display, "seat0");
	server.request_selection.notify = request_selection;
	wl_signal_add(&server.seat->events.request_set_selection, &server.request_selection);
	server.request_cursor.notify = request_cursor;
	wl_signal_add(&server.seat->events.request_set_cursor, &server.request_cursor);
	struct wlr_cursor_shape_manager_v1 *shapes = wlr_cursor_shape_manager_v1_create(server.display, 1);
	server.request_shape.notify = request_shape;
	wl_signal_add(&shapes->events.request_set_shape, &server.request_shape);
	server.layout = wlr_output_layout_create(server.display);
	server.cursor = wlr_cursor_create();
	wlr_cursor_attach_output_layout(server.cursor, server.layout);
	// the session's cursor theme and size (Settings › Mouse sets them for everything started in the session)
	const char *csize = getenv("XCURSOR_SIZE");
	server.xcursors = wlr_xcursor_manager_create(getenv("XCURSOR_THEME"), csize && atoi(csize) > 0 ? atoi(csize) : 24);
	wlr_xcursor_manager_load(server.xcursors, 1);
	server.new_input.notify = new_input;
	wl_signal_add(&server.backend->events.new_input, &server.new_input);

	if (!xcb_setup()) { fprintf(stderr, "liquid-wl-bridge: couldn't connect to X11\n"); return 1; }
	xcb_screen_t *scr = xcb_setup_roots_iterator(xcb_get_setup(server.xcb)).data;
	screen_w = scr->width_in_pixels; screen_h = scr->height_in_pixels;
	screen_mm_w = scr->width_in_millimeters; screen_mm_h = scr->height_in_millimeters;
	wl_global_create(server.display, &wl_output_interface, 4, NULL, bind_output);

	const char *sock = NULL;
	if (socket_name) { if (wl_display_add_socket(server.display, socket_name) == 0) sock = socket_name; }
	else sock = wl_display_add_socket_auto(server.display);
	if (!sock) { fprintf(stderr, "liquid-wl-bridge: couldn't create the Wayland socket\n"); return 1; }
	if (!wlr_backend_start(server.backend)) { fprintf(stderr, "liquid-wl-bridge: couldn't start\n"); return 1; }

	wl_event_loop_add_signal(server.loop, SIGTERM, on_signal_quit, NULL);
	wl_event_loop_add_signal(server.loop, SIGINT, on_signal_quit, NULL);
	printf("WAYLAND_DISPLAY=%s\n", sock);
	fflush(stdout);
	wl_display_run(server.display);

	// quitting: tell the apps, and leave the rest to the process ending (tearing everything down piece by
	// piece trips wlroots' checks for listeners we'd have to unhook one by one first)
	wl_display_destroy_clients(server.display);
	wl_display_flush_clients(server.display);
	xcb_disconnect(server.xcb);
	return 0;
}
