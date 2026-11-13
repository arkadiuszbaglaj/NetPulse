package pl.netpulse.app

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.WebSocket

enum class Screen { Starting, Login, Wan }

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val api = NetPulseApi(app)

    var screen by mutableStateOf(Screen.Starting)
        private set

    // --- logowanie ---
    var loginBusy by mutableStateOf(false)
        private set
    var loginError by mutableStateOf<String?>(null)
        private set
    var needsCode by mutableStateOf(false)
        private set

    // --- ruch WAN ---
    var links by mutableStateOf<List<WanLink>>(emptyList())
        private set
    var traffic by mutableStateOf<List<TrafficPoint>>(emptyList())
        private set
    var rangeMinutes by mutableStateOf(60)
        private set
    var loadError by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(false)
        private set

    /** Odczyty na żywo: interface_id → (pobieranie, wysyłanie) w b/s. */
    val live = mutableStateMapOf<Int, Pair<Double?, Double?>>()
    var liveConnected by mutableStateOf(false)
        private set

    private var pollJob: Job? = null
    private val sockets = mutableMapOf<Int, WebSocket>()
    private var visible = false

    init {
        viewModelScope.launch {
            if (WidgetData.hasWidgets(app)) WidgetData.schedule(app)
            screen = try {
                if (api.checkSession()) Screen.Wan else Screen.Login
            } catch (e: ApiException) {
                // Serwer nieosiągalny – pokaż logowanie z błędem, adres i login zostają wpisane
                loginError = e.message
                Screen.Login
            }
            if (screen == Screen.Wan) startWan()
        }
    }

    fun login(address: String, username: String, password: String, code: String) {
        if (loginBusy) return
        loginBusy = true
        loginError = null
        viewModelScope.launch {
            try {
                api.login(address, username, password, code.takeIf { needsCode })
                needsCode = false
                screen = Screen.Wan
                startWan()
            } catch (e: ApiException) {
                if (e.code == "totp_required") needsCode = true
                loginError = e.message
            } finally {
                loginBusy = false
            }
        }
    }

    fun logout() {
        stopWan()
        viewModelScope.launch {
            api.logout()
            WidgetData.publishStatus(getApplication(), "login")
            links = emptyList()
            traffic = emptyList()
            screen = Screen.Login
        }
    }

    fun setRange(minutes: Int) {
        rangeMinutes = minutes
        viewModelScope.launch { refresh() }
    }

    /** Ekran widoczny / schowany (aplikacja w tle nie trzyma połączeń na żywo ani nie odpytuje serwera). */
    fun onVisible(isVisible: Boolean) {
        visible = isVisible
        if (screen != Screen.Wan) return
        if (isVisible) startWan() else stopWan()
    }

    fun refreshNow() {
        viewModelScope.launch { refresh() }
    }

    private fun startWan() {
        if (!visible || pollJob?.isActive == true) return
        pollJob = viewModelScope.launch {
            while (isActive) {
                refresh()
                connectLive()
                delay(POLL_MS)
            }
        }
    }

    private fun stopWan() {
        pollJob?.cancel()
        pollJob = null
        sockets.values.forEach { it.close(1000, null) }
        sockets.clear()
        live.clear()
        liveConnected = false
    }

    private suspend fun refresh() {
        loading = true
        try {
            links = api.wanStatus()
            WidgetData.publish(getApplication(), links)
            traffic = api.wanTraffic(rangeMinutes)
            loadError = null
        } catch (e: ApiException) {
            if (e.status == 401) {
                // Sesja wygasła albo została unieważniona w panelu
                stopWan()
                api.forgetSession()
                loginError = getApplication<Application>().getString(R.string.session_expired)
                screen = Screen.Login
            } else {
                loadError = e.message
            }
        } finally {
            loading = false
        }
    }

    /** Jedno połączenie na żywo na router z łączem WAN; zerwane połączenie odnawia następny cykl odświeżania. */
    private fun connectLive() {
        for (deviceId in links.map { it.deviceId }.toSet()) {
            if (deviceId in sockets) continue
            sockets[deviceId] = api.live(
                deviceId,
                onSample = { ws, ports ->
                    viewModelScope.launch {
                        if (sockets[deviceId] !== ws) return@launch // spóźniona próbka z zamkniętego połączenia
                        live.putAll(ports)
                        liveConnected = true
                    }
                },
                onClosed = { ws ->
                    viewModelScope.launch {
                        if (sockets[deviceId] === ws) sockets.remove(deviceId)
                        liveConnected = sockets.isNotEmpty() && live.isNotEmpty()
                    }
                },
            )
        }
    }

    override fun onCleared() {
        stopWan()
    }

    companion object {
        const val POLL_MS = 30_000L // kolektor zapisuje próbki co 30 s
    }
}
