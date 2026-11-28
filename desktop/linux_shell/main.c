/*
 * Scribe Desktop — Orb Hybrid Mode Linux Shell (GTK3 + WebKit2GTK 4.1)
 *
 * Uses the exact same GTK3 RGBA visual + WebKit2GTK 4.1 hardware-accelerated
 * pipeline as Orb so Hyprland applies native Kawase blur with zero tile flicker.
 */
#define _POSIX_C_SOURCE 200809L
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <gdk/gdkkeysyms.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    GtkWidget *win;
    GtkWidget *webview;
    char daemon_url[256];
} ScribeShell;

static gboolean on_key_press(GtkWidget *widget, GdkEventKey *ev, gpointer ud) {
    (void)widget;
    ScribeShell *s = (ScribeShell *)ud;
    if (!s->webview) return FALSE;
    gboolean mod = (ev->state & (GDK_CONTROL_MASK | GDK_META_MASK | GDK_SUPER_MASK)) != 0;
    if (!mod) return FALSE;
    const char *js = NULL;
    if (ev->keyval == GDK_KEY_n || ev->keyval == GDK_KEY_N) js = "window.__SCRIBE_NEW_NOTE__&&window.__SCRIBE_NEW_NOTE__();";
    else if (ev->keyval == GDK_KEY_k || ev->keyval == GDK_KEY_K) js = "window.__SCRIBE_FOCUS_SEARCH__&&window.__SCRIBE_FOCUS_SEARCH__();";
    else if (ev->keyval == GDK_KEY_b || ev->keyval == GDK_KEY_B) js = "window.__SCRIBE_TOGGLE_SIDEBAR__&&window.__SCRIBE_TOGGLE_SIDEBAR__();";
    else if (ev->keyval == GDK_KEY_j || ev->keyval == GDK_KEY_J) js = "window.__SCRIBE_TOGGLE_COPILOT__&&window.__SCRIBE_TOGGLE_COPILOT__();";
    else if (ev->keyval == GDK_KEY_slash || ev->keyval == GDK_KEY_KP_Divide) js = "window.__SCRIBE_TOGGLE_MODE__&&window.__SCRIBE_TOGGLE_MODE__();";
    if (js) {
        webkit_web_view_evaluate_javascript(WEBKIT_WEB_VIEW(s->webview), js, -1, NULL, NULL, NULL, NULL, NULL);
        return TRUE;
    }
    return FALSE;
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--self-test") == 0) {
            printf("scribe-linux-shell ok\n");
            return 0;
        }
    }
    gtk_init(&argc, &argv);

    ScribeShell s;
    memset(&s, 0, sizeof(s));
    const char *url = getenv("SCRIBE_UI_URL");
    snprintf(s.daemon_url, sizeof(s.daemon_url), "%s", url ? url : "http://127.0.0.1:47921/");

    s.win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(s.win), "Scribe");
    gtk_window_set_default_size(GTK_WINDOW(s.win), 1180, 780);
    g_signal_connect(s.win, "destroy", G_CALLBACK(gtk_main_quit), NULL);

    /* Exact Orb RGBA visual + transparent window CSS for native Hyprland Kawase blur */
    GdkScreen *scr = gtk_widget_get_screen(s.win);
    GdkVisual *rgba = (scr && gdk_screen_is_composited(scr)) ? gdk_screen_get_rgba_visual(scr) : NULL;
    if (rgba) {
        gtk_widget_set_visual(s.win, rgba);
        gtk_widget_set_app_paintable(s.win, TRUE);
        GtkCssProvider *wc = gtk_css_provider_new();
        gtk_css_provider_load_from_data(wc, "window,window.background{background-color:rgba(0,0,0,0);background-image:none;}", -1, NULL);
        gtk_style_context_add_provider_for_screen(scr, GTK_STYLE_PROVIDER(wc), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
        g_object_unref(wc);
    }

    s.webview = webkit_web_view_new();
    WebKitSettings *wks = webkit_web_view_get_settings(WEBKIT_WEB_VIEW(s.webview));
    webkit_settings_set_hardware_acceleration_policy(wks, WEBKIT_HARDWARE_ACCELERATION_POLICY_ALWAYS);
    const GdkRGBA bg = rgba ? (GdkRGBA){ 0, 0, 0, 0 } : (GdkRGBA){ 0.078, 0.078, 0.078, 1 };
    webkit_web_view_set_background_color(WEBKIT_WEB_VIEW(s.webview), &bg);
    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(s.webview), s.daemon_url);

    gtk_container_add(GTK_CONTAINER(s.win), s.webview);
    g_signal_connect(s.win, "key-press-event", G_CALLBACK(on_key_press), &s);
    gtk_widget_show_all(s.win);
    gtk_main();
    return 0;
}
