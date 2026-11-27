package md.th0rgal.orbvoice

import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Real-time WebSocket STT client for ElevenLabs Scribe v2 Realtime (`scribe_v2_realtime`).
 * Streams 16 kHz mono PCM16 chunks and delivers ~150 ms partials + VAD-committed turns.
 * Automatically marks itself unhealthy on any transport/auth failure so callers can
 * fall back seamlessly to on-device Parakeet NPU.
 */
class ElevenLabsScribeClient(
    private val apiKey: String,
    private val sampleRate: Int = 16000,
    private val vadSilenceThresholdSecs: Double = 1.3,
    private val onPartial: (String) -> Unit,
    private val onCommitted: (String) -> Unit,
    private val onFailure: (String) -> Unit = {}
) {
    companion object {
        private const val TAG = "ElevenLabsScribe"
        private val sharedHttpClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .build()
        }
    }

    private val failed = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    @Volatile
    private var ws: WebSocket? = null

    val isHealthy: Boolean
        get() = ws != null && !failed.get() && !closed.get()

    fun start(): Boolean {
        val cleanKey = apiKey.trim()
        if (cleanKey.isEmpty()) {
            failed.set(true)
            return false
        }
        return try {
            val url = "wss://api.elevenlabs.io/v1/speech-to-text/realtime" +
                "?model_id=scribe_v2_realtime" +
                "&audio_format=pcm_$sampleRate" +
                "&commit_strategy=vad" +
                "&vad_silence_threshold_secs=$vadSilenceThresholdSecs"
            val req = Request.Builder()
                .url(url)
                .header("xi-api-key", cleanKey)
                .build()
            ws = sharedHttpClient.newWebSocket(
                req,
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        Log.i(TAG, "Connected to ElevenLabs Scribe v2 Realtime")
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (closed.get()) return
                        try {
                            val obj = JSONObject(text)
                            val msgType = obj.optString("message_type", "")
                            val transcript = obj.optString("text", "").trim()
                            when (msgType) {
                                "partial_transcript" -> {
                                    if (transcript.isNotEmpty()) onPartial(transcript)
                                }
                                "committed_transcript", "committed_transcript_with_timestamps" -> {
                                    if (transcript.isNotEmpty()) onCommitted(transcript)
                                }
                                "auth_error", "quota_exceeded", "error" -> {
                                    val err = obj.optString("error", msgType)
                                    Log.w(TAG, "Server error: $err")
                                    failed.set(true)
                                    onFailure(err)
                                }
                            }
                        } catch (t: Throwable) {
                            Log.w(TAG, "Parse error: ${t.message}")
                        }
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        if (closed.get()) return
                        val msg = t.message ?: response?.message ?: "WebSocket failure"
                        Log.w(TAG, "Scribe Realtime WS failed: $msg")
                        failed.set(true)
                        onFailure(msg)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        if (!closed.get() && code != 1000) {
                            failed.set(true)
                            onFailure("WS closed ($code): $reason")
                        }
                    }
                }
            )
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Init error: ${t.message}")
            failed.set(true)
            onFailure(t.message ?: "Init error")
            false
        }
    }

    fun sendPcm(shorts: ShortArray, count: Int) {
        val socket = ws ?: return
        if (failed.get() || closed.get() || count <= 0) return
        val bytes = ByteArray(count * 2)
        for (i in 0 until count) {
            val s = shorts[i].toInt()
            bytes[i * 2] = (s and 0xFF).toByte()
            bytes[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val payload = JSONObject().apply {
            put("message_type", "input_audio_chunk")
            put("audio_base_64", b64)
            put("sample_rate", sampleRate)
        }.toString()
        if (!socket.send(payload)) {
            failed.set(true)
            onFailure("WebSocket send queue full or closed")
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            ws?.close(1000, "recording stopped")
        } catch (_: Throwable) {
        }
        ws = null
    }
}
