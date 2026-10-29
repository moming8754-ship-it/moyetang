// ── M17（2.0.0）：仓库镜像（国内网络访问 plugins.gradle.org / dl.google.com /
//    repo.maven.apache.org 会连接挂死，实测卡过 6 分钟、日志一个字节不写）──
// 阿里云镜像放前面，官方仓库留作兜底（镜像缺某个包时还能回落到官方）。
//
// ⚠️ 别把这三个 maven 收进一个共享变量/函数里再用（Groovy 的 `def x = {...}` 在 **Kotlin DSL**
//    里就是 `Unresolved reference`；而 `val x = {...}` 写在 `buildscript {}` **之前**也取不到 ——
//    Gradle 要求 buildscript 块排在最前面，那个作用域里看不见脚本级声明）。
//    所以这里**两处各自内联**，重复三行换一个"一定编译得过"。
// ⚠️ 只改这个文件：`tauri.settings.gradle` 是 CLI 生成的、且被 .gitignore 忽略，不要动它。
buildscript {
    repositories {
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
