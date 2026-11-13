package pl.netpulse.app

import android.content.Context
import android.text.format.DateUtils
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider as FixedColor

// Kolory „Błękit” jak w aplikacji: (jasny, ciemny)
private val Background = ColorProvider(Color(0xFFFFFFFF), Color(0xFF151B24))
private val TextMain = ColorProvider(Color(0xFF111827), Color(0xFFE6EDF3))
private val TextMuted = ColorProvider(Color(0xFF5B6575), Color(0xFF9AA6B8))
private val Download = ColorProvider(Color(0xFF1F6FEB), Color(0xFF4C9BFF))
private val Upload = ColorProvider(Color(0xFF6B7585), Color(0xFF9AA6B8))

/** Widget „Ruch WAN” na ekran główny: pobieranie i wysyłanie łącza WAN, stan i czas odczytu. */
class WanWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val stored = currentState<Preferences>()[WidgetData.KEY]
            // Świeżo dodany widget nie ma jeszcze stanu – pokaż ostatni znany odczyt
            Content(if (stored != null) WidgetSnapshot.fromJson(stored) else WidgetData.last(LocalContext.current))
        }
    }

    @Composable
    private fun Content(snapshot: WidgetSnapshot) {
        val size = LocalSize.current
        val compact = size.height < 100.dp
        // Mały widget: łącze aktywne (albo pierwsze); większy: wszystkie łącza
        val links = if (compact) {
            listOfNotNull(snapshot.links.firstOrNull { it.state == "active" } ?: snapshot.links.firstOrNull())
        } else {
            snapshot.links.take(3)
        }
        Column(
            GlanceModifier
                .fillMaxSize()
                .cornerRadius(16.dp)
                .background(Background)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .clickable(actionStartActivity<MainActivity>()),
        ) {
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (compact && links.size == 1) links[0].name else LocalContext.current.getString(R.string.widget_name),
                    style = TextStyle(color = TextMain, fontSize = 13.sp, fontWeight = FontWeight.Medium),
                    maxLines = 1,
                )
                if (compact && links.size == 1) {
                    Spacer(GlanceModifier.width(6.dp))
                    StateDot(links[0].state)
                }
                Spacer(GlanceModifier.defaultWeight())
                Image(
                    provider = ImageProvider(R.drawable.ic_refresh),
                    contentDescription = LocalContext.current.getString(R.string.refresh),
                    colorFilter = ColorFilter.tint(TextMuted),
                    modifier = GlanceModifier.size(20.dp).clickable(actionRunCallback<RefreshAction>()),
                )
            }
            when {
                snapshot.status == "login" && snapshot.links.isEmpty() -> Message(LocalContext.current.getString(R.string.widget_login))
                links.isEmpty() -> Message(LocalContext.current.getString(if (snapshot.updatedAt == 0L) R.string.widget_loading else R.string.widget_empty))
                else -> for (link in links) {
                    if (!compact) {
                        Spacer(GlanceModifier.height(4.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(link.name, style = TextStyle(color = TextMuted, fontSize = 11.sp), maxLines = 1)
                            Spacer(GlanceModifier.width(6.dp))
                            StateDot(link.state)
                        }
                    }
                    Row(GlanceModifier.fillMaxWidth()) {
                        Reading("↓", link.inBps, Download)
                        Spacer(GlanceModifier.width(12.dp))
                        Reading("↑", link.outBps, Upload)
                    }
                }
            }
            Spacer(GlanceModifier.defaultWeight())
            Text(footer(snapshot), style = TextStyle(color = TextMuted, fontSize = 10.sp), maxLines = 1)
        }
    }

    @Composable
    private fun Reading(arrow: String, bps: Double?, color: androidx.glance.unit.ColorProvider) {
        Text("$arrow ${formatBps(bps)}", style = TextStyle(color = color, fontSize = 17.sp, fontWeight = FontWeight.Bold), maxLines = 1)
    }

    @Composable
    private fun Message(text: String) {
        Spacer(GlanceModifier.height(6.dp))
        Text(text, style = TextStyle(color = TextMuted, fontSize = 12.sp), maxLines = 2)
    }

    @Composable
    private fun StateDot(state: String) {
        val color = when (state) {
            "active" -> Color(0xFF1F9D55)
            "standby" -> Color(0xFF8C96A5)
            "down" -> Color(0xFFD1242F)
            else -> Color(0xFFB7791F)
        }
        Box(GlanceModifier.size(8.dp).cornerRadius(4.dp).background(FixedColor(color))) {}
    }

    @Composable
    private fun footer(snapshot: WidgetSnapshot): String {
        if (snapshot.updatedAt == 0L) return ""
        val context = LocalContext.current
        val time = DateUtils.formatDateTime(
            context,
            snapshot.updatedAt,
            DateUtils.FORMAT_SHOW_TIME or if (DateUtils.isToday(snapshot.updatedAt)) 0 else DateUtils.FORMAT_SHOW_DATE,
        )
        return when (snapshot.status) {
            "offline" -> context.getString(R.string.widget_offline, time)
            "login" -> context.getString(R.string.widget_login_footer, time)
            else -> time
        }
    }
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetData.refresh(context)
    }
}

class WanWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = WanWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        WidgetData.schedule(context)
        WidgetData.refreshSoon(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        WidgetData.cancel(context)
    }
}
