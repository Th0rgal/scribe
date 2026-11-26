package com.th0rgal.orbvoice

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Automatically syncs Scribe text & voice notes into Thomas's Hindsight `thomas` bank
 * under a dedicated `scribe/` folder/namespace so they are backed up and queryable by assistants.
 */
object HindsightSyncClient {
    const val DEFAULT_API_URL = "https://memory.thomas.md"
    const val DEFAULT_BANK = "thomas"
    const val DEFAULT_FOLDER = "scribe"

    data class SyncResult(val ok: Boolean, val documentId: String, val error: String? = null)

    private fun sha256(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun isoNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    suspend fun syncNote(
        noteId: String,
        title: String,
        markdown: String,
        isVoice: Boolean,
        apiToken: String,
        apiUrl: String = DEFAULT_API_URL,
        bankId: String = DEFAULT_BANK,
        folder: String = DEFAULT_FOLDER
    ): SyncResult = withContext(Dispatchers.IO) {
        if (markdown.isBlank()) {
            return@withContext SyncResult(false, "", "Empty note")
        }
        val lower = markdown.lowercase(Locale.US)
        if ("#private" in lower || "#nosync" in lower || "sync: false" in lower) {
            return@withContext SyncResult(false, "", "Private note skipped")
        }
        if (apiToken.isBlank()) {
            return@withContext SyncResult(false, "", "Missing Hindsight token")
        }

        val cleanFolder = folder.trim().trim('/')
        val docId = "$cleanFolder/$noteId.md"
        val tags = JSONArray().apply {
            put("source:scribe")
            put("folder:$cleanFolder")
            if (isVoice) put("type:voice_note")
        }
        val metadata = JSONObject().apply {
            put("title", title)
            put("doc_name", title)
            put("auteur", "thomas")
            put("type_de_source", if (isVoice) "scribe_voice_note" else "scribe_note")
            put("folder_path", cleanFolder)
            put("scribe_rel_path", "$noteId.md")
            put("content_hash", sha256(markdown))
        }
        val payload = JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", 1)
            put("method", "tools/call")
            put("params", JSONObject().apply {
                put("name", "sync_retain")
                put("arguments", JSONObject().apply {
                    put("content", markdown)
                    put("context", "Scribe note ($docId): $title")
                    put("timestamp", isoNow())
                    put("tags", tags)
                    put("document_id", docId)
                    put("metadata", metadata)
                })
            })
        }

        try {
            val endpoint = "${apiUrl.trimEnd('/')}/mcp/$bankId/"
            val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 30_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $apiToken")
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(payload.toString()) }
            val code = conn.responseCode
            conn.disconnect()
            if (code in 200..299) {
                SyncResult(true, docId)
            } else {
                SyncResult(false, docId, "HTTP $code")
            }
        } catch (e: Exception) {
            SyncResult(false, docId, e.message ?: "Sync failed")
        }
    }

    data class RemoteNote(val id: String, val title: String, val markdown: String)

    /**
     * Pulls notes stored under `scribe/` in the `thomas` Hindsight bank so desktop notes
     * are available on mobile (two-way pull sync).
     */
    suspend fun pullNotes(
        apiToken: String,
        apiUrl: String = DEFAULT_API_URL,
        bankId: String = DEFAULT_BANK,
        folder: String = DEFAULT_FOLDER,
        limit: Int = 100
    ): List<RemoteNote> = withContext(Dispatchers.IO) {
        if (apiToken.isBlank()) return@withContext emptyList()
        val prefix = "${folder.trim().trim('/')}/"
        val out = mutableListOf<RemoteNote>()
        try {
            val listUrl = "${apiUrl.trimEnd('/')}/v1/default/banks/$bankId/documents?limit=$limit"
            val conn = (URL(listUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $apiToken")
            }
            if (conn.responseCode !in 200..299) {
                conn.disconnect()
                return@withContext emptyList()
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val root = JSONObject(body)
            val items = root.optJSONArray("items") ?: root.optJSONArray("documents") ?: JSONArray()
            for (i in 0 until items.length()) {
                val item = items.optJSONObject(i) ?: continue
                val docId = item.optString("id").ifBlank { item.optString("document_id") }
                if (!docId.startsWith(prefix)) continue
                val noteId = docId.removePrefix(prefix).removeSuffix(".md")
                val docUrl = "${apiUrl.trimEnd('/')}/v1/default/banks/$bankId/documents/${java.net.URLEncoder.encode(docId, "UTF-8")}"
                val dConn = (URL(docUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 15_000
                    readTimeout = 20_000
                    setRequestProperty("Accept", "application/json")
                    setRequestProperty("Authorization", "Bearer $apiToken")
                }
                if (dConn.responseCode in 200..299) {
                    val dBody = dConn.inputStream.bufferedReader().use { it.readText() }
                    val dObj = JSONObject(dBody)
                    val md = dObj.optString("original_text").ifBlank { dObj.optString("content") }
                    val meta = dObj.optJSONObject("metadata")
                    val title = meta?.optString("title")?.takeIf { it.isNotBlank() } ?: noteId
                    if (md.isNotBlank()) {
                        out.add(RemoteNote(id = noteId, title = title, markdown = md))
                    }
                }
                dConn.disconnect()
            }
        } catch (_: Exception) {
            // Best-effort offline-safe pull
        }
        out
    }
}
