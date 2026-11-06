package pl.netpulse.app

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Łącze na widgecie: tylko to, co widget pokazuje. */
data class WidgetLink(val name: String, val state: String, val inBps: Double?, val outBps: Double?)

/**
 * Stan widgetu WAN. `status`: ok | offline (serwer nieosiągalny – zostają ostatnie odczyty) | login (brak sesji).
 * `updatedAt` = chwila ostatniego udanego odczytu.
 */
data class WidgetSnapshot(val links: List<WidgetLink>, val updatedAt: Long, val status: String) {
    fun toJson(): String = JSONObject()
        .put("updated_at", updatedAt)
        .put("status", status)
        .put("links", JSONArray(links.map {
            JSONObject().put("name", it.name).put("state", it.state).put("in", it.inBps ?: JSONObject.NULL).put("out", it.outBps ?: JSONObject.NULL)
        }))
        .toString()

    companion object {
        val EMPTY = WidgetSnapshot(emptyList(), 0, "ok")

        fun fromJson(json: String?): WidgetSnapshot {
            if (json.isNullOrEmpty()) return EMPTY
            return try {
                val o = JSONObject(json)
                val links = o.getJSONArray("links")
                WidgetSnapshot(
                    links = (0 until links.length()).map { i ->
                        val l = links.getJSONObject(i)
                        WidgetLink(
                            l.getString("name"),
                            l.getString("state"),
                            if (l.isNull("in")) null else l.getDouble("in"),
                            if (l.isNull("out")) null else l.getDouble("out"),
                        )
                    },
                    updatedAt = o.optLong("updated_at"),
                    status = o.optString("status", "ok"),
                )
            } catch (_: Exception) {
                EMPTY
            }
        }
    }
}

/**
 * Dane widgetu: odczyt z serwera, zapis i rozesłanie do wszystkich widgetów na ekranie.
 * Widget odświeża się co 15 min (najkrócej, jak pozwala Android w tle), po stuknięciu ikony odświeżania
 * i przy każdym odświeżeniu ekranu WAN w aplikacji.
 */
object WidgetData {
    val KEY = stringPreferencesKey("wan")
    private const val PREFS = "netpulse_widget"
    private const val WORK = "wan-widget"

    fun last(context: Context): WidgetSnapshot =
        WidgetSnapshot.fromJson(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("wan", null))

    suspend fun publish(context: Context, links: List<WanLink>) =
        push(context, WidgetSnapshot(links.map { WidgetLink(it.name, it.state, it.inBps, it.outBps) }, System.currentTimeMillis(), "ok"))

    suspend fun publishStatus(context: Context, status: String) = push(context, last(context).copy(status = status))

    /** Odczyt z serwera (z workera i z przycisku na widgecie). */
    suspend fun refresh(context: Context) {
        val api = NetPulseApi(context)
        if (!api.hasSession) return publishStatus(context, "login")
        try {
            publish(context, api.wanStatus())
        } catch (e: ApiException) {
            publishStatus(context, if (e.status == 401) "login" else "offline")
        }
    }

    private suspend fun push(context: Context, snapshot: WidgetSnapshot) {
        val json = snapshot.toJson()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("wan", json).apply()
        val manager = GlanceAppWidgetManager(context)
        for (id in manager.getGlanceIds(WanWidget::class.java)) {
            updateAppWidgetState(context, id) { it[KEY] = json }
            WanWidget().update(context, id)
        }
    }

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<WidgetWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun refreshSoon(context: Context) {
        WorkManager.getInstance(context)
            .enqueueUniqueWork("$WORK-now", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<WidgetWorker>().build())
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
    }

    suspend fun hasWidgets(context: Context): Boolean =
        GlanceAppWidgetManager(context).getGlanceIds(WanWidget::class.java).isNotEmpty()
}

class WidgetWorker(context: Context, params: androidx.work.WorkerParameters) : androidx.work.CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        WidgetData.refresh(applicationContext)
        return Result.success()
    }
}
