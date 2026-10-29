import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    // ⚠️ M17（2.0.0）：Tauri 模板给的是 `compileSdk = 37`。实测三步：
    //    ① 压到 35 **不行**（依赖要求 "compileSdk of at least 36"，Gradle 直接失败）；
    //    ② 装 `platforms;android-36` 后 **36 通过** ✓；
    //    ③ Google 现在只发 37.1 / 37.2 这种带小版本的平台包，没有纯 `android-37`，
    //       所以用 36 这种整数写法最省事，也满足"≥36"。
    //    依据：Gradle 构建日志 + `sdkmanager --list`；细节见 `.spike\m17-android-build.ps1` 与 进度.md。
    compileSdk = 36
    namespace = "com.dongfangmoyetang.notes"
    defaultConfig {
        // 🔴 局域网同步（M22/M23）走的是明文 http，**release 也必须允许** ——
        //    模板默认 false（只有 debug 才是 true），照模板来会让正式包永远同步不了。
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.dongfangmoyetang.notes"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // 自用侧载：release 构建继续使用 Android 工具链的 debug keystore。
            // 这样能覆盖安装且保留 release 优化；不用于应用商店正式签名。
            signingConfig = signingConfigs.getByName("debug")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
