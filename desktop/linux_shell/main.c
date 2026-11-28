/*
 * Scribe Desktop — Orb Hybrid Mode Linux Shell (GTK4 + WebKitGTK 6.0)
 *
 * Transparent GTK4 window with WebKitGTK 6.0 alpha compositing so the
 * compositor (Hyprland / Wayland) provides native blur/vibrancy, matching Orb.
 * The single unified sidebar and Markdown/LaTeX/Recording UI live in the webview.
 */
#define _POSIX_C_SOURCE 200809L
#include <gtk/gtk.h>
#include <webkit/webkit.h>
#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
    GtkApplication *app;
    GtkWidget *win;
    GtkWidget *webview;
    GtkCssProvider *css;
    char daemon_url[256];
} ScribeShell;

static const char *TRANSPARENT_WIN_CSS =
    "window, window.background { background-color: transparent; background-image: none; }\n";

static gboolean on_key_pressed(
    GtkEventControllerKey *ctrl,
    guint keyval,
    guint keycode,
    GdkModifierType state,
    gpointer ud
) {
    (void)ctrl;
    (void)keycode;
    ScribeShell *s = (ScribeShell *)ud;
    if (!s->webview) return FALSE;

    gboolean mod = (state & (GDK_CONTROL_MASK | GDK_META_MASK | GDK_SUPER_MASK)) != 0;
    if (mod && (keyval == GDK_KEY_n || keyval == GDK_KEY_N)) {
        webkit_web_view_evaluate_javascript(
            WEBKIT_WEB_VIEW(s->webview),
            "window.__SCRIBE_NEW_NOTE__ && window.__SCRIBE_NEW_NOTE__();",
            -1, NULL, NULL, NULL, NULL, NULL
        );
        return TRUE;
    }
    if (mod && (keyval == GDK_KEY_k || keyval == GDK_KEY_K)) {
        webkit_web_view_evaluate_javascript(
            WEBKIT_WEB_VIEW(s->webview),
            "window.__SCRIBE_FOCUS_SEARCH__ && window.__SCRIBE_FOCUS_SEARCH__();",
            -1, NULL, NULL, NULL, NULL, NULL
        );
        return TRUE;
    }
    if (mod && (keyval == GDK_KEY_b || keyval == GDK_KEY_B)) {
        webkit_web_view_evaluate_javascript(
            WEBKIT_WEB_VIEW(s->webview),
            "window.__SCRIBE_TOGGLE_SIDEBAR__ && window.__SCRIBE_TOGGLE_SIDEBAR__();",
            -1, NULL, NULL, NULL, NULL, NULL
        );
        return TRUE;
    }
    if (mod && (keyval == GDK_KEY_j || keyval == GDK_KEY_J)) {
        webkit_web_view_evaluate_javascript(
            WEBKIT_WEB_VIEW(s->webview),
            "window.__SCRIBE_TOGGLE_COPILOT__ && window.__SCRIBE_TOGGLE_COPILOT__();",
            -1, NULL, NULL, NULL, NULL, NULL
        );
        return TRUE;
    }
    if (mod && (keyval == GDK_KEY_slash || keyval == GDK_KEY_KP_Divide)) {
        webkit_web_view_evaluate_javascript(
            WEBKIT_WEB_VIEW(s->webview),
            "window.__SCRIBE_TOGGLE_MODE__ && window.__SCRIBE_TOGGLE_MODE__();",
            -1, NULL, NULL, NULL, NULL, NULL
        );
        return TRUE;
    }
    return FALSE;
}

static void on_activate(GtkApplication *app, gpointer ud) {
    ScribeShell *s = (ScribeShell *)ud;
    s->win = gtk_application_window_new(app);
    gtk_window_set_title(GTK_WINDOW(s->win), "Scribe");
    gtk_window_set_default_size(GTK_WINDOW(s->win), 1180, 780);

    s->css = gtk_css_provider_new();
    gtk_css_provider_load_from_string(s->css, TRANSPARENT_WIN_CSS);
    gtk_style_context_add_provider_for_display(
        gdk_display_get_default(),
        GTK_STYLE_PROVIDER(s->css),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
    );

    /* Single WebKitGTK 6.0 canvas with hardware acceleration + transparent background for compositor blur */
    s->webview = webkit_web_view_new();
    WebKitSettings *wks = webkit_web_view_get_settings(WEBKIT_WEB_VIEW(s->webview));
    webkit_settings_set_hardware_acceleration_policy(wks, WEBKIT_HARDWARE_ACCELERATION_POLICY_ALWAYS);
    const GdkRGBA transparent = { 0.0, 0.0, 0.0, 0.0 };
    webkit_web_view_set_background_color(WEBKIT_WEB_VIEW(s->webview), &transparent);
    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(s->webview), s->daemon_url);

    gtk_window_set_child(GTK_WINDOW(s->win), s->webview);

    GtkEventController *keys = gtk_event_controller_key_new();
    gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_CAPTURE);
    g_signal_connect(keys, "key-pressed", G_CALLBACK(on_key_pressed), s);
    gtk_widget_add_controller(s->win, keys);

    gtk_window_present(GTK_WINDOW(s->win));
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--self-test") == 0) {
            printf("scribe-linux-shell ok\n");
            return 0;
        }
    }
    ScribeShell shell;
    memset(&shell, 0, sizeof(shell));
    const char *url = getenv("SCRIBE_UI_URL");
    snprintf(shell.daemon_url, sizeof(shell.daemon_url), "%s", url ? url : "http://127.0.0.1:47921/");

    shell.app = gtk_application_new("md.thomas.scribe", G_APPLICATION_DEFAULT_FLAGS);
    g_signal_connect(shell.app, "activate", G_CALLBACK(on_activate), &shell);
    int status = g_application_run(G_APPLICATION(shell.app), argc, argv);
    g_object_unref(shell.app);
    return status;
}
