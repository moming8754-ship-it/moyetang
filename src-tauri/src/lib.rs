//! 东方摩耶堂 · Tauri 入口
//!
//! M0 职责：注册插件（single-instance 必须第一个）、建立数据目录、按时间给窗口/任务栏图标、
//! 暴露数据目录相关命令。
//!
//! # M17（2.0.0）· 手机版（Android）
//!
//! 手机上没有托盘、没有全局快捷键、没有开机自启、没有单实例锁 —— 这些模块和插件在
//! 安卓目标上**根本不存在**（`tauri::tray` / `tauri::menu` 都没有）。所以：
//!
//! | 层面 | 怎么门控 |
//! |---|---|
//! | 依赖 | `Cargo.toml` 的「桌面专属依赖」段（`cfg(not(any(android, ios)))`） |
//! | 模块 | `tray` / `shortcuts` / `window` 三个模块级 `#[cfg(desktop)]` |
//! | 命令 | **函数保留、体内分平台** —— 手机上调到桌面专属命令会拿到一句明确中文错误，
//!   而不是"命令不存在"（前端不会因为这些命令缺失整页崩掉） |
//! | 图标 | 白天/夜晚换图标是桌面玩法，手机上不做（`icon_*` 全家族都门控了） |
//!
//! ⚠️ 用 `desktop`/`mobile` 这两个 cfg 是 `tauri-build` 注入的（见 `build.rs`）。
//! 电脑端走的还是原来那条路，**一行行为都没改**（回归 19 套要证明这一点）。

mod android;
mod commands;
mod file_open;
mod focus;
mod marker;
mod models;
mod scheduler;
mod store;
/// 全局快捷键（**桌面专属**：手机上没有这个概念）
#[cfg(desktop)]
mod shortcuts;
/// 托盘常驻（**桌面专属**：手机上没有托盘）
#[cfg(desktop)]
mod tray;
/// 小窗 / 专注小窗 / 桌面挂件（**桌面专属**：手机上窗口由系统管，不建这些浮动窗）
#[cfg(desktop)]
mod window;

use store::{AppState, Store};
use tauri::Manager;
// `Emitter`（`.emit()`）只在桌面专属那段用（托盘/小窗相关）→ 跟着门控，
// 否则安卓目标上会变成 unused import（项目要求 `cargo check` 零警告）
#[cfg(desktop)]
use tauri::Emitter;
// 白天/夜晚换图标 + 定时边界都是桌面玩法（手机版不做）→ 这两条跟着门控
#[cfg(desktop)]
use chrono::{Local, Timelike};
#[cfg(desktop)]
use tauri::image::Image;

/// 白天图标（6:00–18:00）：哥尔赞。内嵌进二进制，打包后不依赖外部文件。
#[cfg(desktop)]
const ICON_DAY: &[u8] = include_bytes!("../icons/runtime/day.png");
/// 夜晚图标：美尔巴
#[cfg(desktop)]
const ICON_NIGHT: &[u8] = include_bytes!("../icons/runtime/night.png");

/// 白天 = 本地时间 6:00 起、18:00 前（约定：图标方案）
#[cfg(desktop)]
pub fn is_daytime() -> bool {
    let hour = Local::now().hour();
    (6..18).contains(&hour)
}

#[cfg(desktop)]
fn icon_bytes(daytime: bool) -> &'static [u8] {
    if daytime {
        ICON_DAY
    } else {
        ICON_NIGHT
    }
}

/// 把窗口+任务栏图标切到当前时段对应的那张，返回是否白天。
///
/// ⚠️ 手机版**保留这个命令但直接报错**：前端（设置页/首页）会调它，
/// 让它"命令不存在"会让整块界面报红；给一句明确中文更好排查。
#[tauri::command]
fn icon_refresh(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        let daytime = is_daytime();
        let image = Image::from_bytes(icon_bytes(daytime)).map_err(|e| format!("图标解析失败：{e}"))?;
        if let Some(window) = app.get_webview_window("main") {
            window
                .set_icon(image)
                .map_err(|e| format!("设置窗口图标失败：{e}"))?;
        }
        // M10-5：托盘图标跟着一起换（同一套图，别让托盘还停在上一时段）
        tray::refresh_icon(&app);
        Ok(daytime)
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("手机版不做白天/夜晚换图标".into())
    }
}

/// 距离下一个 6:00 / 18:00 边界的毫秒数（多给 1 秒缓冲，别在边界前一瞬间就换）
#[cfg(desktop)]
fn ms_until_next_icon_boundary() -> u64 {
    use chrono::{Duration as ChronoDuration, Local, TimeZone};

    let now = Local::now();
    let today = now.date_naive();
    let candidates = [
        today.and_hms_opt(6, 0, 0),
        today.and_hms_opt(18, 0, 0),
        (today + ChronoDuration::days(1)).and_hms_opt(6, 0, 0),
        (today + ChronoDuration::days(1)).and_hms_opt(18, 0, 0),
    ];
    for naive in candidates.into_iter().flatten() {
        if let Some(boundary) = Local.from_local_datetime(&naive).single() {
            if boundary > now {
                let ms = (boundary - now).num_milliseconds().max(0) as u64;
                return ms + 1000;
            }
        }
    }
    // 理论上到不了这里（明天一定还有边界）；兜底睡 1 小时再来
    3_600_000
}

/// 跨 6:00 / 18:00 边界时自动换图标。
///
/// 前端只在"白天/夜晚状态变化后"才通知 Rust，跨边界那一瞬间未必立刻触发
/// （前端每 30s 轮询一次），所以这里用线程睡到下一个边界再主动切。
/// 每轮都重新算时长：电脑休眠/待机后醒来也能正确落到下一个边界。
#[cfg(desktop)]
fn spawn_icon_timer(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let wait = ms_until_next_icon_boundary();
        std::thread::sleep(std::time::Duration::from_millis(wait));

        let daytime = is_daytime();
        match Image::from_bytes(icon_bytes(daytime)) {
            Ok(image) => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_icon(image) {
                        eprintln!("[东方摩耶堂] 定时切换图标失败：{e}");
                    }
                }
            }
            Err(e) => eprintln!("[东方摩耶堂] 定时切换图标：图标解析失败：{e}"),
        }
        // 通知前端：界面 logo 也一起换（前端只是多一个更快的触发点）
        if let Err(e) = app.emit("icon-changed", daytime) {
            eprintln!("[东方摩耶堂] 广播 icon-changed 失败：{e}");
        }
        // M10-5：托盘图标也一起切
        tray::refresh_icon(&app);
    });
}

/// M10-3：关主窗口时该"收进托盘"吗？（读设置；缺字段 / 读不出来都当"收进托盘"）
///
/// ⚠️ 手机版没有托盘，所以这个函数只给桌面用（手机版关窗口就是关窗口）。
#[cfg(desktop)]
fn close_to_tray(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    let Ok(store) = state.store.lock() else {
        return true;
    };
    match store::config::load(&store) {
        Ok(cfg) => cfg.window.close_to_tray,
        Err(e) => {
            eprintln!("[东方摩耶堂] 读设置失败（关窗口按「收进托盘」处理）：{e}");
            true
        }
    }
}

/// 启动诊断日志（v2.24.3 排查「双击打不开」用）。
///
/// 为什么需要它：release 版是 GUI 子系统、`panic = "abort"`，**崩了屏幕上什么都不留**，
/// 只能靠事件日志猜。这里把关键步骤同时写进 stderr 和一个固定文件，
/// 用户双击失败后把 `startup.log` 发过来就能定位。
///
/// 位置：`%LOCALAPPDATA%\com.dongfangmoyetang.notes\startup.log`（写不进去就只写 stderr）。
#[cfg(desktop)]
fn startup_log(msg: &str) {
    use std::io::Write;
    eprintln!("[东方摩耶堂][启动] {msg}");
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let dir = std::path::PathBuf::from(local).join("com.dongfangmoyetang.notes");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("startup.log"))
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{stamp} {msg}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v2.24.3 诊断：GUI 版崩了屏幕上什么都没，先装 panic 钩子 + 记一条启动现场。
    #[cfg(desktop)]
    {
        std::panic::set_hook(Box::new(|info| {
            startup_log(&format!("PANIC: {info}"));
        }));
        startup_log(&format!(
            "启动：exe={:?} cwd={:?} env_profile={:?} local={:?}",
            std::env::current_exe().ok(),
            std::env::current_dir().ok(),
            std::env::var_os("WEBVIEW2_USER_DATA_FOLDER"),
            std::env::var_os("LOCALAPPDATA")
        ));
    }    // 旧版默认 EBWebView 缓存可能损坏或被残留 WebView2 进程锁住。
    // 桌面版改用独立 profile，避免升级后继续复用坏缓存；用户显式设置的环境变量优先。
    //
    // 🔴 v2.24.3（2026-10-29）：**启动自愈**。踩过的坑：profile 一旦坏掉（创建 webview 报
    //    0x800700AA「请求的资源在使用中」），release 是 `panic = "abort"` → 进程直接
    //    0xc0000409 退出，而那个坏目录没人清理 → **之后每次启动都失败**（用户报「启动器打不开」）。
    //    做法：启动前写一个「正在启动」标记，setup 完整跑完（主窗真建出来了）才删；
    //    下次启动如果发现标记还在，说明上次**死在建窗口阶段** → 把 profile 目录改名（**不删**）后重建，
    //    一次就活。标记放在 LOCALAPPDATA 下、profile 目录**外面** —— profile 被整个改名也不会把标记带走。
    #[cfg(desktop)]
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = std::path::PathBuf::from(local).join("com.dongfangmoyetang.notes");
            let marker = base.join(".webview-starting");
            if marker.exists() {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                for name in ["EBWebView-Desktop-v2", "webview"] {
                    let dir = base.join(name);
                    if dir.exists() {
                        let dst = base.join(format!("{name}.autoheal-{stamp}"));
                        match std::fs::rename(&dir, &dst) {
                            Ok(()) => eprintln!(
                                "[东方摩耶堂] 上次启动没走完，已把 {} 改名后重建 profile",
                                dir.display()
                            ),
                            Err(e) => eprintln!("[东方摩耶堂] 自愈改名失败（{}）：{e}", dir.display()),
                        }
                    }
                }
                let _ = std::fs::remove_file(&marker);
            }
            let _ = std::fs::create_dir_all(&base);
            match std::fs::write(&marker, b"starting") {
                Ok(()) => startup_log(&format!("已写启动标记 {}", marker.display())),
                Err(e) => startup_log(&format!("写启动标记失败（{}）：{e}", marker.display())),
            }
            let profile = base.join("EBWebView-Desktop-v2");
            startup_log(&format!("profile 定为 {}", profile.display()));
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &profile);
        }
    }
    let builder = tauri::Builder::default();
    // ⚠️ single-instance 必须是第一个注册的插件：防止多开导致数据互相覆盖
    //    手机上没有"多开"这回事（一个应用一个进程），这个插件在安卓上也不存在 → 门控
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let paths = file_open::note_paths_from_args(&argv, std::path::Path::new(&cwd));
        if !paths.is_empty() {
            let state = app.state::<AppState>();
            if let Err(error) = commands::notes_import_files(app.clone(), state, paths) {
                eprintln!("[东方摩耶堂] 单实例转交的 Markdown 导入失败：{error}");
            }
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        // M7：导出/导入备份时要选路径（**手机版也要**：安卓走系统文件选择器）
        .plugin(tauri_plugin_dialog::init())
        // B3（2026-10-07，用户反馈）：信息区「45 分钟没联动」那种提醒，**在 App 之外
        // （系统通知栏）也要看得见** —— 用户原话「我今天体验过一次信息区转认知区了，
        // 但最好还是可以在 app 之外看见这个通知」。手机端就是系统通知；桌面端这个插件
        // 走的是系统通知中心，无害。
        .plugin(tauri_plugin_notification::init());
    // M6：全局快捷键（Ctrl+Space 唤起小窗）。⚠️ 必须在 setup 里真正注册之前 init
    //    手机上没有全局快捷键 → 门控
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    // M10-6：开机自启。启动项里带上 `--autostart`，setup 据此直接收进托盘。
    //    手机上没有"开机自启"这个概念（系统自己管）→ 门控
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--autostart"]),
    ));
    let builder = builder
        .setup(|app| {
            #[cfg(desktop)]
            startup_log("setup 开始（准备建主窗/托盘）");
            // M17（2.0.0）：手机版的默认数据目录 = **应用私有目录**。
            // 安卓 scoped storage 下"用户自己指定数据目录"不成立（V1 那套"数据即文件、
            // 目录随便放"在手机上只有应用私有目录可写）。
            // ⚠️ 电脑端（Windows）走的是写死的老路径，这段在桌面上编译时就不存在 ——
            //    老数据一个字节都不受影响。
            #[cfg(mobile)]
            {
                match app.path().app_data_dir() {
                    Ok(dir) => {
                        println!("[东方摩耶堂] 手机版数据目录（应用私有目录）：{}", dir.display());
                        store::set_default_dir(dir);
                    }
                    Err(e) => eprintln!("[东方摩耶堂] 拿应用私有目录失败：{e}"),
                }
            }
            let store = Store::locate();
            match store.ensure_dirs() {
                Ok(()) => println!("[东方摩耶堂] 数据目录：{}", store.data_dir().display()),
                Err(e) => eprintln!("[东方摩耶堂] 建立数据目录失败：{e}"),
            }
            app.manage(AppState::new(store.clone()));
            {
                let state = app.state::<AppState>();
                let store = state.store.lock().map_err(|_| "数据锁异常")?;
                match store::archive::repair_missing_note_files(&store) {
                    Ok(0) => {}
                    Ok(count) => println!("[东方摩耶堂] 已从档案快照补回 {count} 个缺失文件"),
                    Err(e) => eprintln!("[东方摩耶堂] 检查档案笔记文件失败：{e}"),
                }
            }

            #[cfg(desktop)]
            {
                if let Err(error) = file_open::register_open_with() {
                    eprintln!("[东方摩耶堂] 注册 Markdown「打开方式」失败：{error}");
                }
                let args: Vec<String> = std::env::args().collect();
                let cwd = std::env::current_dir().unwrap_or_default();
                let paths = file_open::note_paths_from_args(&args, &cwd);
                if !paths.is_empty() {
                    let state = app.state::<AppState>();
                    if let Err(error) = commands::notes_import_files(app.handle().clone(), state, paths) {
                        eprintln!("[东方摩耶堂] 启动参数里的 Markdown 导入失败：{error}");
                    }
                }
            }

            // 🔴 2026-10-20（用户反馈「正文延迟」）：**同步落地后也让界面重拉一次**。
            // 别的写操作都是命令层直接 `emit_data_changed`，只有同步是在**服务端后台线程**里落地的
            // （`store/sync_server.rs` 的 `/data` 那一段），那一层不认识 Tauri ——
            // 所以在这儿注册一个回调，落地成功时广播 `data-changed`。
            // 不这么做的话：手机同步上来的笔记**躺在 notes/ 里、主窗看不见**，得手动刷新才出现。
            {
                let handle = app.handle().clone();
                crate::store::sync_server::set_applied_hook(Box::new(move || {
                    let _ = tauri::Emitter::emit(&handle, "data-changed", ());
                }));
            }

            // 让前端能直接显示数据目录里的图片：只放行**数据目录**这一棵树
            // （不开 "**"，免得 asset 协议变成任意文件读取通道）
            if let Err(e) = app.asset_protocol_scope().allow_directory(store.data_dir(), true) {
                eprintln!("[东方摩耶堂] 放行数据目录给 asset 协议失败：{e}");
            }

            // 启动即按时间给出白天哥尔赞 / 夜晚美尔巴（**桌面专属**：手机上图标由系统管）
            #[cfg(desktop)]
            {
                let daytime = is_daytime();
                if let Some(window) = app.get_webview_window("main") {
                    match Image::from_bytes(icon_bytes(daytime)) {
                        Ok(image) => {
                            let _ = window.set_icon(image);
                        }
                        Err(e) => eprintln!("[东方摩耶堂] 设置启动图标失败：{e}"),
                    }
                }

                // 跨 6:00 / 18:00 边界时自动换图标（不依赖前端轮询）
                spawn_icon_timer(app.handle().clone());

                // M10 · 托盘常驻：托盘图标 + 右键菜单（气泡由 scheduler 在提醒到点时调）。
                match tray::init(app.handle()) {
                    Ok(()) => {}
                    Err(e) => eprintln!("[东方摩耶堂] 建托盘图标失败：{e}"),
                }

                // M10-6：开机自启拉起来的这一次**直接收进托盘**（自启的意义就是常驻，
                // 不该开机就弹一个窗口在脸上）。用户在界面上手动打开的不带这个参数，照常显示。
                if std::env::args().any(|a| a == "--autostart") {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                        println!("[东方摩耶堂] 本次是开机自启：已收进托盘");
                    }
                }
            }

            // 后台调度：45 分钟信息提醒（M2）—— 跨平台，手机版也要
            scheduler::spawn(app.handle().clone());

            // M13-B：专注「意外中断」判定 —— 每秒采一次样（键鼠空闲 / 是否锁屏）
            // 并往主窗广播 `focus-tick`。跟托盘放一起起：都是"常驻的小后台"。
            // ⚠️ 手机上这两样探针都返回"刚动过、没锁屏"（见 focus.rs 的非 Windows 兜底），
            //    计时照走，只是不判"疑似离开"。
            focus::spawn_monitor(app.handle().clone());

            // E 批（2026-10-03）：桌面挂件 —— 配置里开着就**开机就摆出来**。
            // ⚠️ 投到 async runtime 上跑：建窗那两条命令是 `async fn`（同步会跟主线程互相等死）。
            // 手机版没有"桌面挂件"这种浮动窗 → 门控。
            #[cfg(desktop)]
            if store::config::load(&store)
                .map(|cfg| cfg.widget.enabled)
                .unwrap_or(false)
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::window::show_widget_window(&handle) {
                        eprintln!("[东方摩耶堂] 开机摆挂件失败：{error}");
                    }
                });
            }

            // 全局快捷键：Ctrl+Space 唤起小窗（M6，**桌面专属**）
            // 配置读不出来就用默认键；注册失败**不能静默**（Ctrl+Space 常被输入法占用，
            // 用户按半天没反应会以为程序坏了），留痕并让设置页能改键。
            #[cfg(desktop)]
            {
                let accelerator = store::config::load(&store)
                    .map(|cfg| cfg.shortcuts.toggle_small_window)
                    .unwrap_or_else(|_| shortcuts::DEFAULT_TOGGLE.to_string());
                let accelerator = if accelerator.trim().is_empty() {
                    shortcuts::DEFAULT_TOGGLE.to_string()
                } else {
                    accelerator
                };
                match shortcuts::register(app.handle(), &accelerator) {
                    Ok(()) => println!("[东方摩耶堂] 唤起小窗的快捷键：{accelerator}"),
                    Err(error) => eprintln!("[东方摩耶堂] {error}"),
                }
            }

            // v2.24.3：走到这里说明本次启动**没有死在建 webview 上** → 摘掉「正在启动」标记。
            // （见 run() 开头那段启动自愈；标记留着 = 下次启动会把坏 profile 改名重建。）
            #[cfg(desktop)]
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let marker = std::path::PathBuf::from(local)
                    .join("com.dongfangmoyetang.notes")
                    .join(".webview-starting");
                match std::fs::remove_file(&marker) {
                    Ok(()) => startup_log("setup 完成：摘掉启动标记（本次启动成功）"),
                    Err(e) => startup_log(&format!("摘启动标记失败：{e}")),
                }
            }

            Ok(())
        });
    // M10-3：关闭主窗口 = **收进托盘**（默认；设置里可改成"直接退出"）。
    // ⚠️ 真正的退出走 `quit_app` → `app.exit(0)`（界面左下角 quit / 托盘菜单「退出」），
    //    那条路**不经过 CloseRequested**，所以"收进托盘"不会把"退不出去"变成新 bug。
    // ⚠️ 只拦 `main`：小窗（label "small"）本来就只 hide 不 close，别抢它。
    // ⚠️ 手机版没有托盘 → 整段门控（手机版关窗口就是关窗口，由系统管）
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if window.label() != "main" {
            return;
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if close_to_tray(window.app_handle()) {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    });
    builder
        .invoke_handler(tauri::generate_handler![
            commands::data_dir_get,
            commands::data_dir_open,
            commands::config_get,
            commands::config_save,
            commands::asset_import,
            commands::asset_abs_path,
            commands::info_list,
            commands::info_create,
            commands::info_update,
            commands::info_delete,
            commands::info_link_note,
            commands::info_link_todo,
            commands::note_list,
            commands::note_create,
            commands::note_get,
            commands::note_delete,
            commands::note_save,
            commands::note_set_text,
            commands::note_tree_append_text,
            commands::note_marker_toggle,
            commands::note_tree_add_child,
            commands::note_tree_add_sibling,
            commands::note_tree_remove,
            commands::note_tree_move,
            commands::note_tree_set_text,
            commands::note_tree_set_collapsed,
            commands::note_tree_set_image,
            commands::note_tree_ensure_root,
            commands::note_tree_insert,
            commands::note_title_set,
            commands::note_set_group,
            commands::note_groups,
            commands::asset_write_image,
            commands::todo_list,
            commands::todo_create,
            commands::todo_set_done,
            commands::todo_set_title,
            // M13-C：专注小窗的「须知」（跟待办走的长期备注）
            commands::todo_set_focus_note,
            // v1.15.0：这条待办自己的番茄时长（没设就跟随设置里的全局值）
            commands::todo_set_custom_minutes,
            commands::todo_set_planned,
            commands::todo_set_due,
            commands::todo_subtask_add,
            commands::todo_subtask_toggle,
            commands::todo_subtask_remove,
            commands::todo_set_quadrant,
            // D 批（2026-10-04）：待办分组（照认知区那套 `note_set_group` / `note_groups`）
            commands::todo_set_group,
            commands::todo_groups,
            commands::todo_set_repeat,
            commands::todo_reorder,
            commands::todo_delete,
            commands::todo_add_pomodoro,
            commands::todo_schedule_remind,
            commands::todo_purge_removed,
            commands::reminder_list,
            commands::reminder_dismiss,
            commands::reminder_snooze,
            // C 批（2026-10-02）：多条待办提醒要能一条一条删 / 一条一条列
            commands::reminder_delete,
            commands::reminder_for_todo,
            // E 批（2026-10-03）：桌面挂件（显示 / 收起 / 是否可见 / 按配置重摆）
            commands::widget_open,
            commands::main_show,
            commands::widget_close,
            commands::widget_visible,
            commands::widget_apply,
            commands::small_window_show,
            commands::small_window_hide,
            // 🔴 2026-10-13：`small_window_toggle` 已删（它只碰 1 号窗，开着就收 —— 用户按 F9
            //    想多开时看到的就是它，正是「多开依旧失败」的根源）。
            //    现在：`small_window_new` ＝ 用户按一下就给一个能写的窗（先捞藏着的、没有才新开）；
            //    `small_window_hide_all` ＝ 托盘菜单「收起所有速记窗」。
            commands::small_window_new,
            commands::small_window_hide_all,
            commands::small_window_visible,
            commands::shortcut_status,
            commands::backup_export,
            commands::backup_import,
            // M27（v2.18.0）：笔记导出 / 导入（电脑端按路径 · 手机端走「下载/东方摩耶堂/」）
            commands::note_export_file,
            commands::notes_export_dir,
            commands::notes_import_files,
            commands::notes_import_android_pending,
            commands::note_export_downloads,
            commands::backup_export_downloads,
            commands::backup_import_bytes,
            commands::trash_purge,
            commands::app_info,
            commands::autostart_get,
            commands::autostart_set,
            // M11-A：每日报告（手写部分）
            commands::daily_get,
            commands::daily_note_set,
            commands::daily_export,
            // M12-A：奖状 / 证书
            commands::award_list,
            commands::award_create,
            commands::award_set,
            commands::award_delete,
            // M12-C：格言与原则
            commands::motto_list,
            commands::motto_create,
            commands::motto_set,
            commands::motto_delete,
            // 2026-10-04：倒计时（日程月视图里加/改/删，桌面挂件上显示「还有 N 天」）
            commands::countdown_list,
            commands::countdown_create,
            commands::countdown_update,
            commands::countdown_delete,
            // M21（v2.11.0）：同步数据层 —— 设备状态 / 删除记录（墓碑）
            commands::sync_state_get,
            commands::sync_graves_list,
            commands::sync_graves_purge,
            commands::sync_client_now,
            commands::sync_server_start,
            commands::sync_server_status,
            commands::sync_server_cancel,
            // M14-B：批注（锚点 + 正文；「启用档案区」开关在 config.archive）
            commands::anno_list,
            commands::anno_create,
            commands::anno_set,
            commands::anno_delete,
            // M15：隐藏档案库（收纳 / 取出 / 就地改 / 删；入口在设置里的「启用档案区」）
            commands::archive_list,
            commands::archive_put,
            commands::archive_create,
            commands::archive_restore,
            commands::archive_set,
            commands::archive_patch,
            commands::archive_note_save,
            commands::archive_delete,
            // M13-A：专注小窗
            commands::focus_window_open,
            commands::focus_window_close,
            commands::focus_window_visible,
            commands::focus_tray_set,
            // M13-B：专注「意外中断」判定（会话开关 + 只读状态）
            commands::focus_monitor_start,
            commands::focus_monitor_stop,
            commands::focus_monitor_state,
            commands::quit_app,
            icon_refresh,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
