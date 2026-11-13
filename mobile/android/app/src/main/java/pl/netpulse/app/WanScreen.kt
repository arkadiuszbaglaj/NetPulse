package pl.netpulse.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

private val RANGES = listOf(60, 360, 1440, 10080)

@Composable
private fun rangeLabel(minutes: Int): String = if (minutes >= 1440 * 7) stringResource(R.string.range_7d) else "${minutes / 60} h"

@Composable
fun WanScreen(model: AppViewModel) {
    val inColor = MaterialTheme.colorScheme.primary
    val outColor = Color(0xFF8C96A5)
    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.wan_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text(
                    model.api.baseUrl?.host ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = model::refreshNow) { Text(stringResource(R.string.refresh)) }
            TextButton(onClick = model::logout) { Text(stringResource(R.string.logout)) }
        }
        Box(Modifier.fillMaxWidth().padding(vertical = 0.dp)) {
            if (model.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        model.loadError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }

        if (model.links.isEmpty() && !model.loading && model.loadError == null) {
            NpCard {
                Text(
                    stringResource(R.string.wan_empty),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        for (link in model.links) {
            val live = model.live[link.interfaceId]
            LinkCard(
                link = link,
                inBps = live?.first ?: link.inBps,
                outBps = live?.second ?: link.outBps,
                isLive = live != null,
                inColor = inColor,
                outColor = outColor,
            )
        }

        NpCard {
            Text(stringResource(R.string.wan_history), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (minutes in RANGES) {
                    FilterChip(
                        selected = model.rangeMinutes == minutes,
                        onClick = { model.setRange(minutes) },
                        label = { Text(rangeLabel(minutes)) },
                    )
                }
            }
            TrafficChart(model.traffic, inColor, outColor)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Legend(stringResource(R.string.download), inColor)
                Legend(stringResource(R.string.upload), outColor)
            }
        }
        Spacer(Modifier.size(8.dp))
    }
}

@Composable
private fun LinkCard(link: WanLink, inBps: Double?, outBps: Double?, isLive: Boolean, inColor: Color, outColor: Color) {
    NpCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(link.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                val speed = formatSpeed(link.speedMbps)?.let { " · $it" } ?: ""
                Text(
                    "${link.deviceName} · ${link.interfaceLabel}$speed",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            StateBadge(link.state)
        }
        Row(Modifier.fillMaxWidth()) {
            Reading(stringResource(R.string.reading_download), inBps, inColor, Modifier.weight(1f))
            Reading(stringResource(R.string.reading_upload), outBps, outColor, Modifier.weight(1f))
        }
        Text(
            stringResource(if (isLive) R.string.live_hint else R.string.last_sample),
            style = MaterialTheme.typography.labelSmall,
            color = if (isLive) Color(0xFF1F9D55) else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Reading(label: String, bps: Double?, color: Color, modifier: Modifier) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(formatBps(bps), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = color)
    }
}

@Composable
private fun StateBadge(state: String) {
    val (labelId, color) = when (state) {
        "active" -> R.string.state_active to Color(0xFF1F9D55)
        "standby" -> R.string.state_standby to Color(0xFF8C96A5)
        "down" -> R.string.state_down to Color(0xFFD1242F)
        else -> R.string.state_unknown to Color(0xFFB7791F)
    }
    val label = stringResource(labelId)
    Row(
        Modifier
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
private fun Legend(label: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(width = 14.dp, height = 3.dp).background(color, RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun NpCard(content: @Composable () -> Unit) {
    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = CardDefaults.outlinedCardBorder(),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
    }
}
