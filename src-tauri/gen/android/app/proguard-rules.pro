# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# ── v2.24.3（2026-10-29）R8 会把「只被 Rust 通过 JNI 按名字调用」的方法裁掉 ──
# 真实现象：release 包里 MarkdownImportBridge.takePending 被删 → 手机文件管理器打开 .md，
# 先弹「已接收」（Kotlin 侧 capture 还在），紧接着红条「读取安卓待导入文件失败」。
# ⚠️ 以后任何「Rust 用 call_static_method / 类名反射」调到的 Kotlin 类，都必须加进这里。
-keep class com.dongfangmoyetang.notes.MarkdownImportBridge { *; }
-keep class com.dongfangmoyetang.notes.DownloadSaver { *; }