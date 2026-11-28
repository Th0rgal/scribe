package md.th0rgal.orbvoice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lightweight loopback-only HTTP + SSE server (`127.0.0.1:47922`) so a desktop/agent
 * connected over USB (`adb forward tcp:47922 tcp:47922`) can read, stream, and remote-control
 * Scribe in real time:
 *   - GET /api/live                          -> JSON snapshot
 *   - GET /api/live.txt                      -> Clean Markdown transcript for LLM agents
 *   - GET /api/stream                        -> Server-Sent Events (SSE) live stream
 *   - GET /api/control?action=start|pause|resume|stop -> Remote control recording
 */
class ScribeLocalStreamServer(
    private val appContext: Context,
    private val port: Int = DEFAULT_PORT,
    private val stateProvider: () -> RecorderState
) {
    companion object {
        const val DEFAULT_PORT = 47922
        private const val TAG = "ScribeStreamServer"
        @Volatile
        private var instance: ScribeLocalStreamServer? = null

        fun ensureStarted(context: Context, stateProvider: () -> RecorderState): ScribeLocalStreamServer {
            val existing = instance
            if (existing != null) {
                existing.start()
                return existing
            }
            return synchronized(this) {
                instance ?: ScribeLocalStreamServer(context.applicationContext, DEFAULT_PORT, stateProvider).also {
                    instance = it
                    it.start()
                }
            }
        }
    }

    private val running = AtomicBoolean(false)
    private val pool = Executors.newCachedThreadPool()
    @Volatile
    private var serverSocket: ServerSocket? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        pool.execute {
            try {
                val ss = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
                ss.reuseAddress = true
                serverSocket = ss
                Log.i(TAG, "Listening on 127.0.0.1:$port (use: adb forward tcp:$port tcp:$port)")
                while (running.get()) {
                    val client = try {
                        ss.accept()
                    } catch (_: Throwable) {
                        break
                    }
                    pool.execute { handleClient(client) }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to bind 127.0.0.1:$port: ${t.message}")
                running.set(false)
            }
        }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        try {
            serverSocket?.close()
        } catch (_: Throwable) {
        }
        serverSocket = null
    }

    private fun dispatchControl(actionName: String): Boolean {
        val svcAction = when (actionName.lowercase()) {
            "start" -> VoiceRecorderService.ACTION_START
            "pause" -> VoiceRecorderService.ACTION_PAUSE
            "resume" -> VoiceRecorderService.ACTION_RESUME
            "stop" -> VoiceRecorderService.ACTION_STOP
            else -> return false
        }
        val intent = Intent(appContext, VoiceRecorderService::class.java).apply {
            action = svcAction
        }
        return try {
            if (svcAction == VoiceRecorderService.ACTION_START && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                appContext.startForegroundService(intent)
            } else {
                appContext.startService(intent)
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Control $actionName failed: ${t.message}")
            false
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { sock ->
            try {
                sock.soTimeout = 5000
                val reader = BufferedReader(InputStreamReader(sock.getInputStream(), Charsets.UTF_8))
                val reqLine = reader.readLine() ?: return
                val fullTarget = reqLine.split(" ").getOrNull(1) ?: "/"
                val path = fullTarget.substringBefore("?")
                val query = fullTarget.substringAfter("?", "")
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                }

                val out = sock.getOutputStream()
                when (path) {
                    "/api/control" -> {
                        val actionParam = query.split("&")
                            .mapNotNull { kv -> kv.split("=").takeIf { it.size == 2 }?.let { it[0] to it[1] } }
                            .toMap()["action"]
                            .orEmpty()
                        val ok = dispatchControl(actionParam)
                        val body = JSONObject().apply {
                            put("ok", ok)
                            put("action", actionParam)
                        }.toString().toByteArray(Charsets.UTF_8)
                        writeResponse(out, "application/json; charset=utf-8", body)
                    }
                    "/api/stream" -> {
                        sock.soTimeout = 0
                        val hdr = (
                            "HTTP/1.1 200 OK\r\n" +
                                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                                "Cache-Control: no-cache\r\n" +
                                "Connection: keep-alive\r\n\r\n"
                            ).toByteArray(Charsets.UTF_8)
                        out.write(hdr)
                        out.flush()
                        var lastSig = ""
                        while (running.get() && !sock.isClosed) {
                            val st = stateProvider()
                            val json = buildJson(st)
                            if (json != lastSig) {
                                lastSig = json
                                out.write("data: $json\n\n".toByteArray(Charsets.UTF_8))
                                out.flush()
                            }
                            Thread.sleep(250)
                        }
                    }
                    "/api/live.txt" -> {
                        val body = buildPlainText(stateProvider()).toByteArray(Charsets.UTF_8)
                        writeResponse(out, "text/plain; charset=utf-8", body)
                    }
                    else -> {
                        val body = buildJson(stateProvider()).toByteArray(Charsets.UTF_8)
                        writeResponse(out, "application/json; charset=utf-8", body)
                    }
                }
            } catch (_: Throwable) {
                // client disconnected
            }
        }
    }

    private fun writeResponse(out: java.io.OutputStream, contentType: String, body: ByteArray) {
        val hdr = (
            "HTTP/1.1 200 OK\r\n" +
                "Content-Type: $contentType\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            ).toByteArray(Charsets.UTF_8)
        out.write(hdr)
        out.write(body)
        out.flush()
    }

    private fun buildJson(st: RecorderState): String {
        val segs = JSONArray()
        for (s in st.liveSegments) {
            segs.put(
                JSONObject().apply {
                    put("speaker", st.speakerNames[s.speakerIndex] ?: s.speakerName)
                    put("speaker_index", s.speakerIndex)
                    put("start_ms", s.startMs)
                    put("end_ms", s.endMs)
                    put("text", s.text)
                    put("translated", s.translatedText)
                }
            )
        }
        return JSONObject().apply {
            put("recording", st.isRecording)
            put("paused", st.isPaused)
            put("processing", st.isProcessing)
            put("elapsed_ms", st.elapsedMs)
            put("status", st.statusMessage)
            put("translate_mode", st.isTranslateMode)
            put("partial", st.partialText)
            put("partial_translation", st.partialTranslation)
            put("segments", segs)
        }.toString()
    }

    private fun buildPlainText(st: RecorderState): String {
        val sb = StringBuilder()
        sb.append("# Scribe Live Transcript (")
        sb.append(
            when {
                st.isPaused -> "paused"
                st.isRecording -> "recording · ${VoiceNoteStore.formatTimestamp(st.elapsedMs)}"
                else -> "idle"
            }
        )
        sb.append(")\n\n")
        for (s in st.liveSegments) {
            val spk = st.speakerNames[s.speakerIndex] ?: s.speakerName
            sb.append("[").append(VoiceNoteStore.formatTimestamp(s.startMs)).append("] **").append(spk).append("**: ").append(s.text).append("\n")
            if (s.translatedText.isNotBlank()) {
                sb.append("  → ").append(s.translatedText).append("\n")
            }
        }
        if (st.partialText.isNotBlank()) {
            sb.append("\n[live] ").append(st.partialText).append("\n")
            if (st.partialTranslation.isNotBlank()) {
                sb.append("  → ").append(st.partialTranslation).append("\n")
            }
        }
        return sb.toString()
    }
}
