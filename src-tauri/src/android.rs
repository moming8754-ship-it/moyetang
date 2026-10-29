//! 安卓原生出口：把导出的文件写进**用户看得见的**「下载/东方摩耶堂/」—— M27（v2.18.0）
//!
//! # 为什么非要写原生代码
//! 「另存为 / 打开文件」那套在安卓上要靠 SAF（`ACTION_CREATE_DOCUMENT`），而 Tauri 的
//! dialog 插件**根本没实现它** —— `tauri-plugin-dialog-2.7.3` 的
//! `android/src/main/java/DialogPlugin.kt` 里就一行 `// TODO: ACTION_OPEN_DOCUMENT ??`，
//! 所以 `open()` / `save()` 在手机上点了毫无反应（用户 v2.17.0 报的 C1 就是这个根因）。
//! 而安卓 10+ 的分区存储又不许普通应用直接往 `/sdcard/Download` 写文件 ——
//! **唯一干净的路是走 MediaStore 插入**，那只能用 Kotlin/Java 调系统 API。
//!
//! # 分工
//! - Kotlin 侧：`gen/android/app/src/main/java/com/dongfangmoyetang/notes/DownloadSaver.kt`
//!   （`object DownloadSaver` + `@JvmStatic save(...)` → MediaStore，API < 29 时退回直接写文件）
//! - Rust 侧：本模块用 JNI 找到那个类并调它（**没有引入任何第三方插件** —— 免得又撞
//!   Tauri 的版本对齐问题，见进度 §三 2k）。
//!
//! # 两个 JNI 坑（改之前先读）
//! 1. **必须用 Activity 的 ClassLoader 去 `loadClass`**：从 native 线程直接
//!    `FindClass("com/dongfangmoyetang/notes/DownloadSaver")` 找不到类
//!    （那用的是系统 ClassLoader，看不见我们 App 的类）。
//! 2. 命令跑在 Tauri 自己的工作线程上 → 先 `attach_current_thread()`；
//!    Kotlin 那边只碰 `ContentResolver`（系统 API，允许后台线程），不动 UI。
//!
//! 桌面端调用会拿到一句明确的中文错误（不是 panic）—— 手机专属能力，见 lib.rs 的约定。

/// 把一段字节写进手机的「下载/东方摩耶堂/<subdir>/<name>」
///
/// - `subdir`：子目录（导出的图片放 `<笔记名>.assets`），空串 = 直接放根
/// - `name`：文件名（含扩展名）
/// - `mime`：MediaStore 要的 MIME（猜不出就 `application/octet-stream`）
///
/// 返回**给人看的路径**（如 `下载/东方摩耶堂/笔记.md`），前端直接弹提示。
#[cfg(target_os = "android")]
pub fn save_to_downloads(
    subdir: &str,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<String, String> {
    use jni::objects::{JClass, JObject, JString, JValue};

    /// 我们 Kotlin 侧的类（包名必须和 `tauri.conf.json` 的 identifier 一致）
    const SAVER_CLASS: &str = "com.dongfangmoyetang.notes.DownloadSaver";
    /// `save(Context, String subdir, String name, String mime, byte[] bytes): String`
    const SAVER_SIG: &str =
        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;[B)Ljava/lang/String;";

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("拿不到安卓虚拟机：{e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("挂到安卓线程失败：{e}"))?;

    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };

    // ① 用 Activity 自己的 ClassLoader 找类（坑 1）
    let loader = env
        .call_method(&activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|value| value.l())
        .map_err(|e| format!("取 ClassLoader 失败：{e}"))?;
    let class_name = env
        .new_string(SAVER_CLASS)
        .map_err(|e| format!("构造类名失败：{e}"))?;
    let raw_class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&JObject::from(class_name))],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("找不到 {SAVER_CLASS}：{e}"))?;
    // `jni 0.21` 故意**不**给 `&JObject → JClass`（怕把实例误当类传），
    // 但 `JClass` 就是 `repr(transparent)` 包着 `JObject`（它自己的 `GlobalRef` 那条 impl
    // 就是这么转的）→ `loadClass` 的返回值按契约就是 Class，这里照做。
    let class = unsafe { JClass::from_raw(raw_class.into_raw()) };

    // ② 参数：全部先变成 JObject，再按签名一个个传
    let subdir_obj = JObject::from(
        env.new_string(subdir)
            .map_err(|e| format!("构造子目录字符串失败：{e}"))?,
    );
    let name_obj = JObject::from(
        env.new_string(name)
            .map_err(|e| format!("构造文件名字符串失败：{e}"))?,
    );
    let mime_obj = JObject::from(
        env.new_string(mime)
            .map_err(|e| format!("构造 MIME 字符串失败：{e}"))?,
    );
    let bytes_obj = JObject::from(
        env.byte_array_from_slice(bytes)
            .map_err(|e| format!("传字节数组失败：{e}"))?,
    );

    let result = env
        .call_static_method(
            &class,
            "save",
            SAVER_SIG,
            &[
                JValue::Object(&activity),
                JValue::Object(&subdir_obj),
                JValue::Object(&name_obj),
                JValue::Object(&mime_obj),
                JValue::Object(&bytes_obj),
            ],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("调用安卓保存失败：{e}"))?;

    if result.is_null() {
        // Kotlin 抛异常时 JNI 会留下一个挂起的异常 —— 打到 logcat 里方便真机排查，
        // 但**必须 clear**，否则后面所有 JNI 调用都会炸
        let pending = env.exception_check().unwrap_or(false);
        if pending {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
        return Err(format!("安卓侧没保存成功（{name}）—— 详见 logcat 里的 DownloadSaver"));
    }

    let text: String = env
        .get_string(&JString::from(result))
        .map_err(|e| format!("读返回路径失败：{e}"))?
        .into();
    if text.trim().is_empty() {
        return Err(format!("安卓侧返回了空路径（{name}）"));
    }
    Ok(text)
}

/// 取走 Kotlin 侧 `MarkdownImportBridge` 抓到的 Android ACTION_VIEW 文件队列。
///
/// 返回 JSON 数组：`[{ "name": "文件名.md", "dataBase64": "..." }]`。
#[cfg(target_os = "android")]
pub fn take_pending_imports() -> Result<String, String> {
    use jni::objects::{JClass, JObject, JString, JValue};

    const BRIDGE_CLASS: &str = "com.dongfangmoyetang.notes.MarkdownImportBridge";
    const TAKE_SIG: &str = "(Landroid/content/Context;)Ljava/lang/String;";

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("拿不到安卓虚拟机：{e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("挂到安卓线程失败：{e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };

    let loader = env
        .call_method(&activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|value| value.l())
        .map_err(|e| format!("取 ClassLoader 失败：{e}"))?;
    let class_name = env
        .new_string(BRIDGE_CLASS)
        .map_err(|e| format!("构造类名失败：{e}"))?;
    let raw_class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&JObject::from(class_name))],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("找不到 {BRIDGE_CLASS}：{e}"))?;
    let class = unsafe { JClass::from_raw(raw_class.into_raw()) };

    let result = env
        .call_static_method(
            &class,
            "takePending",
            TAKE_SIG,
            &[JValue::Object(&activity)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("读取安卓待导入文件失败：{e}"))?;
    if result.is_null() {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
        return Err("安卓待导入队列读取失败，详见 logcat 里的 MarkdownImportBridge".into());
    }
    let text: String = env
        .get_string(&JString::from(result))
        .map_err(|e| format!("读待导入队列失败：{e}"))?
        .into();
    Ok(text)
}

#[cfg(not(target_os = "android"))]
pub fn take_pending_imports() -> Result<String, String> {
    Err("「从安卓文件管理器打开」只在手机版可用".to_string())
}

/// 桌面端：这个能力只有手机有（前端也只在手机上调它）
#[cfg(not(target_os = "android"))]
pub fn save_to_downloads(
    _subdir: &str,
    _name: &str,
    _mime: &str,
    _bytes: &[u8],
) -> Result<String, String> {
    Err("「保存到手机下载目录」只在手机版可用；电脑端请用「导出…」自己选位置".to_string())
}
