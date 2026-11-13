package pl.netpulse.app

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.time.OffsetDateTime
import java.util.Locale
import java.util.concurrent.TimeUnit

/** Błąd API z komunikatem do pokazania; `code` = np. "totp_required" (logowanie dwuskładnikowe). */
class ApiException(val status: Int, message: String, val code: String? = null) : IOException(message)

data class WanLink(
    val id: Int,
    val name: String,
    val deviceId: Int,
    val deviceName: String,
    val interfaceId: Int,
    val interfaceLabel: String,
    val speedMbps: Int?,
    val state: String, // active | standby | down | unknown
    val inBps: Double?,
    val outBps: Double?,
)

data class TrafficPoint(val time: Instant, val inBps: Double?, val outBps: Double?)

/**
 * Klient API serwera NetPulse. Loguje tak samo jak panel (ciasteczko sesji `netpulse_session`, przez HTTP `netpulse_session_http`),
 * więc serwer nie potrzebuje nic dodatkowego. Adres serwera i ciasteczko zostają w pamięci telefonu,
 * hasło – nigdy.
 */
class NetPulseApi(context: Context) {
    private val prefs = context.getSharedPreferences("netpulse", Context.MODE_PRIVATE)
    private val app = context.applicationContext

    var baseUrl: HttpUrl? = prefs.getString(KEY_URL, null)?.toHttpUrlOrNull()
        private set

    val lastUsername: String get() = prefs.getString(KEY_USER, "") ?: ""
    val lastAddress: String get() = prefs.getString(KEY_ADDRESS, "") ?: ""

    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            // Serwer od 0.65.5: przez HTTP `netpulse_session_http`, przez HTTPS `netpulse_session`
            val session = cookies.firstOrNull { it.name in COOKIES } ?: return
            val expired = session.value.isEmpty() || session.expiresAt < System.currentTimeMillis()
            prefs.edit()
                .putString(KEY_COOKIE, if (expired) null else session.value)
                .putString(KEY_COOKIE_NAME, session.name)
                .apply()
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val value = prefs.getString(KEY_COOKIE, null) ?: return emptyList()
            val name = prefs.getString(KEY_COOKIE_NAME, null) ?: COOKIE
            return listOf(Cookie.Builder().name(name).value(value).hostOnlyDomain(url.host).path("/").build())
        }
    }

    // Komunikaty serwera w języku telefonu (od 0.3.0; serwer od 0.75.0 tłumaczy odpowiedzi dla Accept-Language: en)
    private val http = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("Accept-Language", language()).build()) }
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val liveHttp = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()

    val hasSession: Boolean get() = baseUrl != null && prefs.getString(KEY_COOKIE, null) != null

    /** Logowanie; przy koncie z 2FA pierwszy raz bez kodu kończy się ApiException(code = "totp_required"). */
    suspend fun login(address: String, username: String, password: String, code: String?) {
        val url = normalizeAddress(address) ?: throw ApiException(0, app.getString(R.string.error_address))
        val body = JSONObject().put("username", username).put("password", password)
        if (!code.isNullOrBlank()) body.put("code", code.trim())
        baseUrl = url
        call(Request.Builder().url(url.resolve("api/auth/login")!!).post(body.toString().toRequestBody(JSON)).build())
        prefs.edit()
            .putString(KEY_URL, url.toString())
            .putString(KEY_ADDRESS, address.trim())
            .putString(KEY_USER, username)
            .apply()
    }

    /** Czy zapisana sesja jest dalej ważna (serwer mógł ją unieważnić albo wygasła). */
    suspend fun checkSession(): Boolean {
        if (!hasSession) return false
        val json = JSONObject(get("api/auth/status"))
        return json.optBoolean("authenticated")
    }

    suspend fun logout() {
        try {
            call(Request.Builder().url(url("api/auth/logout")).post(ByteArray(0).toRequestBody()).build())
        } catch (_: IOException) {
            // Bez sieci też wylogowujemy lokalnie
        }
        forgetSession()
    }

    fun forgetSession() {
        prefs.edit().remove(KEY_COOKIE).apply()
    }

    suspend fun wanStatus(): List<WanLink> {
        val links = JSONObject(get("api/wan/status")).getJSONArray("links")
        return (0 until links.length()).map { i ->
            val o = links.getJSONObject(i)
            WanLink(
                id = o.getInt("id"),
                name = o.getString("name"),
                deviceId = o.getInt("device_id"),
                deviceName = o.getString("device_name"),
                interfaceId = o.getInt("interface_id"),
                interfaceLabel = o.getString("interface_label"),
                speedMbps = o.optIntOrNull("speed_mbps"),
                state = o.getString("state"),
                inBps = o.optDoubleOrNull("in_bps"),
                outBps = o.optDoubleOrNull("out_bps"),
            )
        }
    }

    /** Ruch WAN (suma wszystkich routerów) – ten sam szereg co wykres ruchu WAN w panelu. */
    suspend fun wanTraffic(minutes: Int): List<TrafficPoint> {
        val points = JSONObject(get("api/dashboard/traffic?minutes=$minutes")).getJSONArray("points")
        return (0 until points.length()).map { i ->
            val p = points.getJSONObject(i)
            val v = p.getJSONObject("values")
            TrafficPoint(OffsetDateTime.parse(p.getString("time")).toInstant(), v.optDoubleOrNull("in_bps"), v.optDoubleOrNull("out_bps"))
        }
    }

    /**
     * Ruch na żywo (co ~1,5 s) – ten sam WebSocket co tryb „Na żywo” w panelu. `onSample` dostaje
     * (interface_id → in_bps, out_bps) dla portów urządzenia.
     */
    fun live(
        deviceId: Int,
        onSample: (WebSocket, Map<Int, Pair<Double?, Double?>>) -> Unit,
        onClosed: (WebSocket) -> Unit,
    ): WebSocket {
        val base = baseUrl ?: throw ApiException(0, app.getString(R.string.error_no_address))
        val request = Request.Builder().url(base.resolve("api/live/device?device=$deviceId")!!).build()
        return liveHttp.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val ports = try {
                    JSONObject(text).optJSONArray("ports") ?: JSONArray()
                } catch (_: Exception) {
                    return
                }
                onSample(webSocket, (0 until ports.length()).associate { i ->
                    val p = ports.getJSONObject(i)
                    p.getInt("id") to (p.optDoubleOrNull("in_bps") to p.optDoubleOrNull("out_bps"))
                })
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onClosed(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onClosed(webSocket)
        })
    }

    private fun url(path: String): HttpUrl =
        baseUrl?.resolve(path) ?: throw ApiException(0, app.getString(R.string.error_no_address))

    private suspend fun get(path: String): String = call(Request.Builder().url(url(path)).build())

    private suspend fun call(request: Request): String = withContext(Dispatchers.IO) {
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw ApiException(0, app.getString(R.string.error_connection, e.message ?: e.javaClass.simpleName))
        }
        response.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) throw errorFrom(it.code, text)
            text
        }
    }

    companion object {
        private const val COOKIE = "netpulse_session"
        private val COOKIES = setOf(COOKIE, "netpulse_session_http")
        private const val KEY_COOKIE_NAME = "session_cookie"
        private const val KEY_URL = "base_url"
        private const val KEY_ADDRESS = "address"
        private const val KEY_USER = "username"
        private const val KEY_COOKIE = "session"
        private const val DEFAULT_PORT = 8000
        private val JSON = "application/json".toMediaType()

        /**
         * „192.168.1.34” → http://192.168.1.34:8000/ (domyślny port instalatora), „netpulse.lan:80” → http://netpulse.lan/,
         * pełny adres (http:// albo https://) zostaje bez zmian.
         */
        fun normalizeAddress(input: String): HttpUrl? {
            val trimmed = input.trim().trimEnd('/')
            if (trimmed.isEmpty()) return null
            val withScheme = when {
                trimmed.contains("://") -> trimmed
                trimmed.substringAfterLast(']').contains(':') -> "http://$trimmed"
                else -> "http://$trimmed:$DEFAULT_PORT"
            }
            return "$withScheme/".toHttpUrlOrNull()
        }

        /** Język komunikatów serwera: polski na telefonie po polsku, w innym języku angielski (jak panel). */
        fun language(): String = if (Locale.getDefault().language == "pl") "pl" else "en"
    }

    /** Komunikat z odpowiedzi FastAPI: `detail` jako tekst, obiekt {code, message} albo lista błędów walidacji. */
    private fun errorFrom(status: Int, body: String): ApiException {
        val detail = try {
            JSONObject(body).opt("detail")
        } catch (_: Exception) {
            null
        }
        val fallback = app.getString(R.string.error_status, status)
        return when (detail) {
            is String -> ApiException(status, detail)
            is JSONObject -> ApiException(status, detail.optString("message", fallback), detail.optString("code").ifEmpty { null })
            is JSONArray -> ApiException(status, detail.optJSONObject(0)?.optString("msg")?.removePrefix("Value error, ") ?: fallback)
            else -> ApiException(status, if (status == 404) app.getString(R.string.error_not_netpulse) else app.getString(R.string.error_server, status))
        }
    }
}

private fun JSONObject.optDoubleOrNull(key: String): Double? = if (isNull(key)) null else optDouble(key).takeUnless { it.isNaN() }

private fun JSONObject.optIntOrNull(key: String): Int? = if (isNull(key)) null else optInt(key)
