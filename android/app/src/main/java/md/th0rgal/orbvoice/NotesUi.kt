package md.th0rgal.orbvoice

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.WbSunny
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import android.webkit.WebView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Apple Notes-inspired, Orb-styled note list for Scribe mobile.
 * Translate is intentionally tucked inside the overflow menu rather than primary chrome.
 */
@Composable
fun ScribeNotesListScreen(
    notes: List<VoiceNote>,
    searchQuery: String,
    onSearchChange: (String) -> Unit,
    onSelectNote: (VoiceNote) -> Unit,
    onNewTextNote: () -> Unit,
    onStartVoiceNote: () -> Unit,
    onOpenTranslateMode: () -> Unit,
    onToggleTheme: () -> Unit,
    isDark: Boolean
) {
    var menuOpen by remember { mutableStateOf(false) }
    val dateFmt = remember { SimpleDateFormat("MMM d, HH:mm", Locale.US) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(OrbBg)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        // Top Header (Apple Notes style)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Notes",
                    color = OrbFgStrong,
                    fontFamily = OrbSansFont,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 28.sp,
                    letterSpacing = (-0.6).sp
                )
                Text(
                    text = "${notes.size} notes · synced to thomas/scribe",
                    color = OrbFgMuted,
                    fontFamily = OrbSansFont,
                    fontSize = 12.sp
                )
            }
            IconButton(onClick = onToggleTheme) {
                Icon(
                    imageVector = if (isDark) Icons.Rounded.WbSunny else Icons.Rounded.DarkMode,
                    contentDescription = "Toggle Theme",
                    tint = OrbFgMuted
                )
            }
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(
                        imageVector = Icons.Rounded.MoreVert,
                        contentDescription = "More",
                        tint = OrbFgMuted
                    )
                }
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false }
                ) {
                    DropdownMenuItem(
                        text = { Text("Live Translate Mode") },
                        onClick = {
                            menuOpen = false
                            onOpenTranslateMode()
                        }
                    )
                }
            }
        }

        // Search pill
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(OrbSurface)
                .border(1.dp, OrbBorder, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Rounded.Search,
                contentDescription = null,
                tint = OrbFgSubtle,
                modifier = Modifier.size(18.dp)
            )
            Spacer(Modifier.width(8.dp))
            BasicTextField(
                value = searchQuery,
                onValueChange = onSearchChange,
                singleLine = true,
                textStyle = TextStyle(
                    color = OrbFgStrong,
                    fontFamily = OrbSansFont,
                    fontSize = 14.sp
                ),
                cursorBrush = SolidColor(OrbBlue),
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    if (searchQuery.isEmpty()) {
                        Text("Search notes...", color = OrbFgSubtle, fontSize = 14.sp)
                    }
                    inner()
                }
            )
        }

        Spacer(Modifier.height(8.dp))

        // Grouped Apple Notes list
        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(notes, key = { it.id }) { note ->
                val preview = note.summary.ifBlank {
                    note.segments.firstOrNull()?.text ?: "Tap to edit..."
                }
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(OrbSurface)
                        .border(1.dp, OrbBorder, RoundedCornerShape(14.dp))
                        .clickable { onSelectNote(note) }
                        .padding(horizontal = 16.dp, vertical = 13.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = note.title.ifBlank { "Untitled Note" },
                            color = OrbFgStrong,
                            fontFamily = OrbSansFont,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 15.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f)
                        )
                        if (note.audioPath.isNotBlank()) {
                            Icon(
                                imageVector = Icons.Rounded.Mic,
                                contentDescription = "Voice Note",
                                tint = OrbBlue,
                                modifier = Modifier.size(15.dp)
                            )
                            Spacer(Modifier.width(6.dp))
                        }
                        if (note.syncedToSpark) {
                            Icon(
                                imageVector = Icons.Rounded.CloudDone,
                                contentDescription = "Synced",
                                tint = OrbGreen,
                                modifier = Modifier.size(15.dp)
                            )
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = preview,
                        color = OrbFgMuted,
                        fontFamily = OrbSansFont,
                        fontSize = 13.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = dateFmt.format(Date(note.createdAtMs)),
                        color = OrbFgSubtle,
                        fontFamily = OrbMonoFont,
                        fontSize = 11.sp
                    )
                }
            }
        }

        // Bottom Apple Notes toolbar
        HorizontalDivider(color = OrbBorder)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(OrbBg)
                .padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                modifier = Modifier
                    .clip(CircleShape)
                    .background(OrbSurface)
                    .border(1.dp, OrbBorder, CircleShape)
                    .clickable { onStartVoiceNote() }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Rounded.Mic, contentDescription = "Voice Note", tint = OrbBlue, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Voice Note", color = OrbFgStrong, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }

            Row(
                modifier = Modifier
                    .clip(CircleShape)
                    .background(OrbBlue)
                    .clickable { onNewTextNote() }
                    .padding(horizontal = 18.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Rounded.Add, contentDescription = "New Note", tint = OrbBg, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("New Note", color = OrbBg, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/**
 * Apple Notes-inspired Markdown & LaTeX note editor/viewer for Scribe mobile.
 */
@Composable
fun ScribeNoteEditorScreen(
    title: String,
    body: String,
    isSynced: Boolean,
    onTitleChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onBack: () -> Unit
) {
    var previewMode by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(OrbSurface)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(OrbBg)
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Rounded.ArrowBack, contentDescription = "Back", tint = OrbBlue)
            }
            Text(
                text = if (isSynced) "● Synced to thomas/scribe" else "○ Auto-syncing...",
                color = if (isSynced) OrbGreen else OrbFgMuted,
                fontFamily = OrbMonoFont,
                fontSize = 11.sp,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = { previewMode = !previewMode }) {
                Icon(
                    imageVector = if (previewMode) Icons.Rounded.Edit else Icons.Rounded.Visibility,
                    contentDescription = "Toggle Preview",
                    tint = OrbFgStrong
                )
            }
        }
        HorizontalDivider(color = OrbBorder)

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 18.dp)
        ) {
            BasicTextField(
                value = title,
                onValueChange = onTitleChange,
                readOnly = previewMode,
                textStyle = TextStyle(
                    color = OrbFgStrong,
                    fontFamily = OrbSansFont,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 24.sp,
                    letterSpacing = (-0.4).sp
                ),
                cursorBrush = SolidColor(OrbBlue),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner ->
                    if (title.isEmpty()) {
                        Text("Title", color = OrbFgSubtle, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
                    }
                    inner()
                }
            )
            Spacer(Modifier.height(14.dp))
            if (previewMode) {
                ScribeKatexPreviewWebView(
                    markdown = body,
                    isDark = LocalOrbPalette.current.isDark,
                    modifier = Modifier.fillMaxWidth().height(540.dp)
                )
            } else {
                BasicTextField(
                    value = body,
                    onValueChange = onBodyChange,
                    textStyle = TextStyle(
                        color = OrbFgStrong,
                        fontFamily = OrbMonoFont,
                        fontSize = 15.sp,
                        lineHeight = 23.sp
                    ),
                    cursorBrush = SolidColor(OrbBlue),
                    modifier = Modifier.fillMaxWidth(),
                    decorationBox = { inner ->
                        if (body.isEmpty()) {
                            Text(
                                "Write in Markdown & LaTeX (\$E = mc^2\$)...",
                                color = OrbFgSubtle,
                                fontSize = 15.sp
                            )
                        }
                        inner()
                    }
                )
            }
        }
    }
}

/**
 * Lightweight local WebView for Markdown + LaTeX preview mode on Android,
 * keeping Edit mode 100% native Jetpack Compose.
 */
@Composable
fun ScribeKatexPreviewWebView(
    markdown: String,
    isDark: Boolean,
    modifier: Modifier = Modifier
) {
    val bg = if (isDark) "#181818" else "#FFFFFF"
    val fg = if (isDark) "#F4F4F5" else "#111318"
    val accent = if (isDark) "#86AEE4" else "#2D6FD1"
    val escaped = markdown
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    val html = """
        <!doctype html><html><head><meta charset="utf-8"/>
        <style>
          body { margin: 0; background: $bg; color: $fg; font-family: sans-serif; font-size: 15px; line-height: 1.65; }
          .math { color: $accent; font-family: monospace; }
        </style></head><body>$escaped</body></html>
    """.trimIndent()

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
            }
        },
        update = { wv ->
            wv.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "utf-8", null)
        }
    )
}
