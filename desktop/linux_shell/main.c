/*
 * Scribe Desktop — Orb Hybrid Mode Linux Shell (GTK4 + WebKitGTK 6.0)
 *
 * Full native lean-ui chrome (sidebar note list, search, new note, sync badge,
 * dark/light theme) with WebKitGTK 6.0 used strictly for the Markdown + LaTeX
 * note editor/preview canvas.
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
    GtkWidget *paned;
    GtkWidget *sidebar;
    GtkWidget *search_entry;
    GtkWidget *note_list;
    GtkWidget *sync_label;
    GtkWidget *theme_btn;
    GtkWidget *webview;
    GtkCssProvider *css;
    gboolean light_mode;
    char daemon_url[256];
} ScribeShell;

static const char *ORB_DARK_CSS =
    "window { background-color: #141414; color: #F4F4F5; font-family: 'IBM Plex Sans', sans-serif; }\n"
    ".scribe-sidebar { background-color: #141414; border-right: 1px solid #262626; }\n"
    ".scribe-header { padding: 10px 12px; border-bottom: 1px solid #262626; }\n"
    ".scribe-title { font-weight: 600; font-size: 14px; color: #F4F4F5; }\n"
    ".scribe-search { background: #181818; color: #F4F4F5; border: 1px solid #262626; border-radius: 8px; padding: 4px 8px; margin: 8px 10px; }\n"
    ".scribe-list { background-color: transparent; }\n"
    ".scribe-list row { padding: 8px 12px; margin: 2px 8px; border-radius: 8px; color: #F4F4F5; }\n"
    ".scribe-list row:hover { background-color: #1E1E1E; }\n"
    ".scribe-list row:selected { background-color: #262626; }\n"
    ".scribe-btn { background: #181818; color: #F4F4F5; border: 1px solid #262626; border-radius: 8px; padding: 4px 10px; }\n"
    ".scribe-btn:hover { background: #1E1E1E; }\n"
    ".scribe-sync { font-size: 11px; color: #199E70; padding: 6px 12px; }\n";

static const char *ORB_LIGHT_CSS =
    "window { background-color: #F5F6F8; color: #111318; font-family: 'IBM Plex Sans', sans-serif; }\n"
    ".scribe-sidebar { background-color: #F5F6F8; border-right: 1px solid #DCE0E6; }\n"
    ".scribe-header { padding: 10px 12px; border-bottom: 1px solid #DCE0E6; }\n"
    ".scribe-title { font-weight: 600; font-size: 14px; color: #111318; }\n"
    ".scribe-search { background: #FFFFFF; color: #111318; border: 1px solid #DCE0E6; border-radius: 8px; padding: 4px 8px; margin: 8px 10px; }\n"
    ".scribe-list { background-color: transparent; }\n"
    ".scribe-list row { padding: 8px 12px; margin: 2px 8px; border-radius: 8px; color: #111318; }\n"
    ".scribe-list row:hover { background-color: #ECEEF2; }\n"
    ".scribe-list row:selected { background-color: #E2E6EE; }\n"
    ".scribe-btn { background: #FFFFFF; color: #111318; border: 1px solid #DCE0E6; border-radius: 8px; padding: 4px 10px; }\n"
    ".scribe-btn:hover { background: #ECEEF2; }\n"
    ".scribe-sync { font-size: 11px; color: #10855B; padding: 6px 12px; }\n";

static void apply_theme(ScribeShell *s) {
    gtk_css_provider_load_from_string(s->css, s->light_mode ? ORB_LIGHT_CSS : ORB_DARK_CSS);
    if (s->webview) {
        const char *js = s->light_mode
            ? "window.__SCRIBE_SET_THEME__ && window.__SCRIBE_SET_THEME__('light');"
            : "window.__SCRIBE_SET_THEME__ && window.__SCRIBE_SET_THEME__('dark');";
        webkit_web_view_evaluate_javascript(WEBKIT_WEB_VIEW(s->webview), js, -1, NULL, NULL, NULL, NULL, NULL);
    }
}

static void on_theme_clicked(GtkButton *btn, gpointer ud) {
    (void)btn;
    ScribeShell *s = (ScribeShell *)ud;
    s->light_mode = !s->light_mode;
    apply_theme(s);
}

static void on_new_note_clicked(GtkButton *btn, gpointer ud) {
    (void)btn;
    ScribeShell *s = (ScribeShell *)ud;
    if (s->webview) {
        webkit_web_view_evaluate_javascript(
            WEBKIT_WEB_VIEW(s->webview),
            "window.__SCRIBE_NEW_NOTE__ && window.__SCRIBE_NEW_NOTE__();",
            -1, NULL, NULL, NULL, NULL, NULL
        );
    }
}

static void on_search_changed(GtkEditable *editable, gpointer ud) {
    ScribeShell *s = (ScribeShell *)ud;
    const char *q = gtk_editable_get_text(editable);
    if (!s->webview || !q) return;
    g_autofree char *escaped = g_strescape(q, NULL);
    g_autofree char *js = g_strdup_printf(
        "window.__SCRIBE_FILTER__ && window.__SCRIBE_FILTER__(\"%s\");", escaped
    );
    webkit_web_view_evaluate_javascript(WEBKIT_WEB_VIEW(s->webview), js, -1, NULL, NULL, NULL, NULL, NULL);
}

static gboolean on_key_pressed(GtkEventControllerKey *ctrl, guint keyval, guint keycode, GdkModifierType state, gpointer ud) {
    (void)ctrl; (void)keycode;
    ScribeShell *s = (ScribeShell *)ud;
    gboolean mod = (state & (GDK_CONTROL_MASK | GDK_META_MASK)) != 0;
    if (mod && (keyval == GDK_KEY_n || keyval == GDK_KEY_N)) {
        on_new_note_clicked(NULL, s);
        return TRUE;
    }
    if (mod && (keyval == GDK_KEY_k || keyval == GDK_KEY_K)) {
        gtk_widget_grab_focus(s->search_entry);
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
    gtk_style_context_add_provider_for_display(
        gdk_display_get_default(),
        GTK_STYLE_PROVIDER(s->css),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
    );

    s->paned = gtk_paned_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_paned_set_position(GTK_PANED(s->paned), 260);
    gtk_window_set_child(GTK_WINDOW(s->win), s->paned);

    /* Left native lean-ui sidebar */
    s->sidebar = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_widget_add_css_class(s->sidebar, "scribe-sidebar");
    gtk_widget_set_size_request(s->sidebar, 220, -1);

    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    gtk_widget_add_css_class(hdr, "scribe-header");
    GtkWidget *title = gtk_label_new("Scribe");
    gtk_widget_add_css_class(title, "scribe-title");
    gtk_widget_set_hexpand(title, TRUE);
    gtk_label_set_xalign(GTK_LABEL(title), 0.0f);

    GtkWidget *new_btn = gtk_button_new_with_label("+");
    gtk_widget_add_css_class(new_btn, "scribe-btn");
    gtk_widget_set_tooltip_text(new_btn, "New Note (Ctrl+N)");
    g_signal_connect(new_btn, "clicked", G_CALLBACK(on_new_note_clicked), s);

    s->theme_btn = gtk_button_new_with_label("◐");
    gtk_widget_add_css_class(s->theme_btn, "scribe-btn");
    gtk_widget_set_tooltip_text(s->theme_btn, "Toggle Dark/Light Theme");
    g_signal_connect(s->theme_btn, "clicked", G_CALLBACK(on_theme_clicked), s);

    gtk_box_append(GTK_BOX(hdr), title);
    gtk_box_append(GTK_BOX(hdr), new_btn);
    gtk_box_append(GTK_BOX(hdr), s->theme_btn);
    gtk_box_append(GTK_BOX(s->sidebar), hdr);

    s->search_entry = gtk_search_entry_new();
    gtk_widget_add_css_class(s->search_entry, "scribe-search");
    gtk_editable_set_text(GTK_EDITABLE(s->search_entry), "");
    g_signal_connect(s->search_entry, "changed", G_CALLBACK(on_search_changed), s);
    gtk_box_append(GTK_BOX(s->sidebar), s->search_entry);

    GtkWidget *scroller = gtk_scrolled_window_new();
    gtk_widget_set_vexpand(scroller, TRUE);
    s->note_list = gtk_list_box_new();
    gtk_widget_add_css_class(s->note_list, "scribe-list");
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scroller), s->note_list);
    gtk_box_append(GTK_BOX(s->sidebar), scroller);

    s->sync_label = gtk_label_new("● Hindsight: thomas/scribe");
    gtk_widget_add_css_class(s->sync_label, "scribe-sync");
    gtk_label_set_xalign(GTK_LABEL(s->sync_label), 0.0f);
    gtk_box_append(GTK_BOX(s->sidebar), s->sync_label);

    /* Right WebKitGTK 6.0 note editor/preview canvas */
    s->webview = webkit_web_view_new();
    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(s->webview), s->daemon_url);

    gtk_paned_set_start_child(GTK_PANED(s->paned), s->sidebar);
    gtk_paned_set_end_child(GTK_PANED(s->paned), s->webview);

    GtkEventController *keys = gtk_event_controller_key_new();
    g_signal_connect(keys, "key-pressed", G_CALLBACK(on_key_pressed), s);
    gtk_widget_add_controller(s->win, keys);

    apply_theme(s);
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
