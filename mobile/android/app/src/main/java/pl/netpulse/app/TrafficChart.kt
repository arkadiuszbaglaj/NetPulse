package pl.netpulse.app

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Prosty wykres liniowy ruchu WAN: pobieranie (akcent) i wysyłanie (szary); brak próbki = przerwa w linii. */
@Composable
fun TrafficChart(points: List<TrafficPoint>, inColor: Color, outColor: Color, modifier: Modifier = Modifier) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val grid = MaterialTheme.colorScheme.outline
    if (points.size < 2) {
        Box(modifier.fillMaxWidth().height(180.dp), contentAlignment = Alignment.Center) {
            Text("Brak danych z tego okresu", color = muted, style = MaterialTheme.typography.bodyMedium)
        }
        return
    }
    val maxValue = points.maxOf { maxOf(it.inBps ?: 0.0, it.outBps ?: 0.0) }.coerceAtLeast(1.0)
    val start = points.first().time.toEpochMilli()
    val span = (points.last().time.toEpochMilli() - start).coerceAtLeast(1)
    val timeFormat = DateTimeFormatter.ofPattern(if (span > 86_400_000) "d.MM HH:mm" else "HH:mm").withZone(ZoneId.systemDefault())

    Column(modifier) {
        Text(formatBps(maxValue), style = MaterialTheme.typography.labelSmall, color = muted)
        Canvas(Modifier.fillMaxWidth().height(180.dp)) {
            val dash = PathEffect.dashPathEffect(floatArrayOf(6f, 6f))
            for (i in 0..3) {
                val y = size.height * i / 3
                drawLine(grid, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f, pathEffect = if (i == 3) null else dash)
            }
            fun x(p: TrafficPoint) = (p.time.toEpochMilli() - start).toFloat() / span * size.width
            fun y(v: Double) = (size.height - v / maxValue * size.height).toFloat()
            drawSeries(points.map { p -> p.outBps?.let { Offset(x(p), y(it)) } }, outColor)
            drawSeries(points.map { p -> p.inBps?.let { Offset(x(p), y(it)) } }, inColor)
        }
        Row(Modifier.fillMaxWidth()) {
            Text(timeFormat.format(points.first().time), style = MaterialTheme.typography.labelSmall, color = muted)
            Box(Modifier.weight(1f))
            Text(timeFormat.format(points.last().time), style = MaterialTheme.typography.labelSmall, color = muted)
        }
    }
}

private fun DrawScope.drawSeries(offsets: List<Offset?>, color: Color) {
    val path = Path()
    var penDown = false
    for (o in offsets) {
        if (o == null) {
            penDown = false
            continue
        }
        if (penDown) path.lineTo(o.x, o.y) else path.moveTo(o.x, o.y)
        penDown = true
    }
    drawPath(path, color, style = Stroke(width = 2.dp.toPx()))
}
