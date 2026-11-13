package pl.netpulse.app

import java.util.Locale

// Liczby w języku telefonu (od 0.3.0): „12,4 Mb/s” po polsku, „12.4 Mb/s” po angielsku
private val PL: Locale get() = Locale.getDefault()

/** Przepływ w bitach na sekundę jak w panelu: „12,4 Mb/s”, „850 kb/s” (separator dziesiętny z języka telefonu). */
fun formatBps(bps: Double?): String {
    if (bps == null) return "—"
    val units = listOf("b/s", "kb/s", "Mb/s", "Gb/s", "Tb/s")
    var value = bps
    var unit = 0
    while (value >= 1000 && unit < units.lastIndex) {
        value /= 1000
        unit++
    }
    val pattern = when {
        unit == 0 || value >= 100 -> "%.0f"
        value >= 10 -> "%.1f"
        else -> "%.2f"
    }
    return "${String.format(PL, pattern, value)} ${units[unit]}"
}

fun formatSpeed(mbps: Int?): String? = when {
    mbps == null || mbps <= 0 -> null
    mbps >= 1000 && mbps % 1000 == 0 -> "${mbps / 1000} Gb/s"
    mbps >= 1000 -> "${String.format(PL, "%.1f", mbps / 1000.0)} Gb/s"
    else -> "$mbps Mb/s"
}
