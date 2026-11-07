plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Wersja aplikacji niezależna od serwera: versionName widać w aplikacji, versionCode musi rosnąć przy każdym wydaniu,
// inaczej Android odmówi instalacji aktualizacji.
val appVersionName = "0.2.1"
val appVersionCode = 3

// Podpis wydania z sekretów CI (NETPULSE_KEYSTORE = ścieżka do pliku .p12). Bez nich – klucz debug (tylko lokalnie).
val keystorePath: String? = System.getenv("NETPULSE_KEYSTORE")

android {
    namespace = "pl.netpulse.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "pl.netpulse.app"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storeType = "pkcs12"
                storePassword = System.getenv("NETPULSE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("NETPULSE_KEY_ALIAS") ?: "netpulse"
                keyPassword = System.getenv("NETPULSE_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Widget na ekran główny (Glance) i odświeżanie w tle
    implementation("androidx.glance:glance-appwidget:1.1.1")
    implementation("androidx.datastore:datastore-preferences-core:1.1.1")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
}
