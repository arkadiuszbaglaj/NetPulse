package pl.netpulse.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.LifecycleResumeEffect

class MainActivity : ComponentActivity() {
    private val model: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            NetPulseTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    LifecycleResumeEffect(Unit) {
                        model.onVisible(true)
                        onPauseOrDispose { model.onVisible(false) }
                    }
                    when (model.screen) {
                        Screen.Starting -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                        Screen.Login -> LoginScreen(model)
                        Screen.Wan -> WanScreen(model)
                    }
                }
            }
        }
    }
}

// Kolory wyglądu „Błękit” z panelu (0.58.0): akcent #1f6feb / #4c9bff, chłodne tła
private val Light = lightColorScheme(
    primary = Color(0xFF1F6FEB),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE6EFFD),
    onPrimaryContainer = Color(0xFF0B3A82),
    background = Color(0xFFF5F7FB),
    surface = Color.White,
    surfaceVariant = Color(0xFFEEF2F8),
    onSurfaceVariant = Color(0xFF5B6575),
    outline = Color(0xFFD5DCE6),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF4C9BFF),
    onPrimary = Color(0xFF0B1220),
    primaryContainer = Color(0xFF15305A),
    onPrimaryContainer = Color(0xFFD6E6FF),
    background = Color(0xFF0D1117),
    surface = Color(0xFF151B24),
    surfaceVariant = Color(0xFF1C2430),
    onSurfaceVariant = Color(0xFF9AA6B8),
    outline = Color(0xFF2B3544),
)

@Composable
fun NetPulseTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
