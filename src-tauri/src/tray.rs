//! M10 · 托盘常驻（**第 7 项技术验证阶段**）
//!
//! 现状（2026-09-22）：
//! - ✅ 已做：托盘图标（跟着白天/夜晚那套图标走）+ tooltip + 右键菜单（显示主窗口 / 新建速记 / 退出）
//!   + 左键唤回主窗口 + **气泡通知探针**
//! - ⏳ 还没做（进度.md 第十一节 3~6 项）：关闭收进托盘 + 设置开关、托盘图标随日夜切换、开机自启
//!
//! 气泡为什么自己调 Win32：grep 过 `tauri 2.11.5` 与 `tray-icon 0.24.2` 的源码，
//! 两边都**没有**气泡/通知 API（tray-icon 的 Win32 实现只用了 NIF_ICON / NIF_MESSAGE /
//! NIF_TIP / NIF_STATE）。所以直接 `Shell_NotifyIconW` + `NIF_INFO`，挂到 tray-icon
//! 自己那个隐藏窗口（窗口类名 `tray_icon_app`）上 —— **不引新依赖**。

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::icon_bytes;

/// 托盘 tooltip / 气泡标题用的名字
const APP_NAME: &str = "东方摩耶堂";

/// 建托盘图标 + 右键菜单。返回的句柄由 Tauri 的 manager 持有，这里丢掉不影响。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "新建速记", true, None::<&str>)?;
    // 2026-10-11（v2.21.0 · 用户反馈第 6 条）：小窗可以同时开好几个 —— 托盘里也给一个门
    let quick_more = MenuItem::with_id(app, "quick-more", "再开一个速记窗", true, None::<&str>)?;
    // 2026-10-13：快捷键语义改成「再给一个」之后，得补一条"一次全收起来"的路
    // （不然按了 5 下想出 5 个窗，想收的时候只能一个个按 Esc）
    let quick_hide_all = MenuItem::with_id(app, "quick-hide-all", "收起所有速记窗", true, None::<&str>)?;
    // E 批（2026-10-03）：桌面挂件也要能从托盘唤出来（挂件收起来之后主窗可能也没开）
    let widget = MenuItem::with_id(app, "widget", "显示/隐藏挂件", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show, &quick, &quick_more, &quick_hide_all, &widget, &separator, &quit],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(icon_bytes(crate::is_daytime()))?)
        .tooltip(APP_NAME)
        // 左键唤回主窗口、右键出菜单（用户习惯）
        .show_menu_on_left_click(false)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            // 小窗命令是 async 的（Tauri 的 async 命令要投到 async runtime 上跑）
            "quick" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::small_window_show(handle).await;
                });
            }
            // 2026-10-11（v2.21.0）：再开一个速记窗（用户反馈第 6 条「小窗无法多开」）
            "quick-more" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::small_window_new(handle).await;
                });
            }
            // 2026-10-13：一次收起所有速记窗（**只收不销毁**，草稿还在）
            "quick-hide-all" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::small_window_hide_all(handle).await;
                });
            }
            // 挂件那条：**开关式**（开着就收、没开就显示）—— 一个菜单项办两件事，
            // 跟"显示主窗口"那种单向的不同；用户不用记两个入口。
            "widget" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if crate::window::widget_visible(&handle) {
                        let _ = crate::commands::widget_close(handle).await;
                    } else {
                        let _ = crate::commands::widget_open(handle).await;
                    }
                });
            }
            "quit" => crate::commands::quit_app(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 换托盘的 tooltip（M13-A：专注中 / 已暂停）。
///
/// `None` = 回到默认的「东方摩耶堂」。
/// ⚠️ 托盘是 `TrayIconBuilder::with_id("main")` 建的，所以这里按 id 取；取不到就记一笔，不 panic。
pub fn set_tooltip(app: &AppHandle, text: Option<&str>) {
    let Some(tray) = app.tray_by_id("main") else {
        eprintln!("[东方摩耶堂] 找不到托盘图标，tooltip 没换");
        return;
    };
    if let Err(error) = tray.set_tooltip(Some(text.unwrap_or(APP_NAME))) {
        eprintln!("[东方摩耶堂] 换托盘 tooltip 失败：{error}");
    }
}

/// 把主窗口唤回来（隐藏 / 最小化 / 在后台都能拉回前台）
pub fn show_main(app: &AppHandle) {    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// M10-5：把托盘图标也切到当前时段那张（白天哥尔赞 / 夜里美尔巴）。
///
/// 复用 `icon_bytes`，和窗口图标是同一套图；窗口那边由 `lib.rs` 的定时器与
/// `icon_refresh` 命令负责，这里顺手把托盘也刷一遍。
pub fn refresh_icon(app: &AppHandle) {
    let daytime = crate::is_daytime();
    let Ok(image) = Image::from_bytes(icon_bytes(daytime)) else {
        eprintln!("[东方摩耶堂] 托盘图标解析失败");
        return;
    };
    match app.tray_by_id("main") {
        Some(tray) => {
            if let Err(e) = tray.set_icon(Some(image)) {
                eprintln!("[东方摩耶堂] 设置托盘图标失败：{e}");
            }
        }
        None => eprintln!("[东方摩耶堂] 没找到托盘图标（id=main），跳过一次刷新"),
    }
}

/// M10-7：冒一条**系统托盘气泡**（45 分钟信息提醒 / 待办到点提醒都走它）。
///
/// 返回 false = 没冒成（托盘不在 / 句柄拿不到 / 系统没收），**绝不 panic**：
/// 提醒本身已经在前端横幅和首页动态区显示过了，气泡只是"应用在托盘里时也能看见"。
pub fn balloon(app: &AppHandle, title: &str, text: &str) -> bool {
    #[cfg(windows)]
    {
        let Some(tray) = app.tray_by_id("main") else {
            return false;
        };
        // ⚠️ `with_inner_tray_icon` 内部是"投递到主线程 + 阻塞等结果"，
        //    所以**只能在非主线程**里调（调度线程可以，setup 里不行）—— M6 那个死锁同一课。
        let hwnd = match tray.with_inner_tray_icon(|inner| inner.window_handle() as isize) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[东方摩耶堂] 拿托盘窗口句柄失败（气泡跳过）：{e}");
                return false;
            }
        };
        if hwnd == 0 {
            return false;
        }
        let Some(uid) = win::probe_uid(hwnd) else {
            eprintln!("[东方摩耶堂] 探不到托盘图标 uID（气泡跳过）");
            return false;
        };
        let ok = win::show_balloon(hwnd, uid, title, text);
        if ok {
            // 成功也留一行：这样"提醒 → 气泡"这条链在日志里查得到（失败另有 eprintln）
            println!("[东方摩耶堂] 托盘气泡已冒：{title}");
        } else {
            eprintln!("[东方摩耶堂] 系统没接收这条托盘气泡");
        }
        ok
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, text);
        false
    }
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{HWND, RECT, S_OK, TRUE};
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconGetRect, Shell_NotifyIconW, NIF_INFO, NIIF_INFO, NIM_MODIFY,
        NOTIFYICONDATAW, NOTIFYICONIDENTIFIER,
    };

    /// 定长 UTF-16 缓冲（NOTIFYICONDATAW 的 szInfo / szInfoTitle 是定长数组）
    fn to_wide<const N: usize>(s: &str) -> [u16; N] {
        let mut buf = [0u16; N];
        for (i, unit) in s.encode_utf16().take(N - 1).enumerate() {
            buf[i] = unit;
        }
        buf
    }

    fn identifier(hwnd: isize, uid: u32) -> NOTIFYICONIDENTIFIER {
        let mut nid: NOTIFYICONIDENTIFIER = unsafe { std::mem::zeroed() };
        nid.cbSize = std::mem::size_of::<NOTIFYICONIDENTIFIER>() as u32;
        nid.hWnd = hwnd as HWND;
        nid.uID = uid;
        nid
    }

    /// tray-icon 的 internal_id 从 1 开始发号，但同一个进程里可能被别的托盘占号，
    /// 所以不猜：拿 `Shell_NotifyIconGetRect` 挨个试，谁返回 S_OK 谁就是它。
    pub fn probe_uid(hwnd: isize) -> Option<u32> {
        for uid in 1..=16u32 {
            if icon_rect(hwnd, uid).is_some() {
                return Some(uid);
            }
        }
        None
    }

    pub fn icon_rect(hwnd: isize, uid: u32) -> Option<(i32, i32, i32, i32)> {
        let nid = identifier(hwnd, uid);
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { Shell_NotifyIconGetRect(&nid, &mut rect) } == S_OK {
            Some((rect.left, rect.top, rect.right, rect.bottom))
        } else {
            None
        }
    }

    /// 真·系统气泡：NIF_INFO。返回 false = 系统没收（图标不在 / 被策略挡了）。
    pub fn show_balloon(hwnd: isize, uid: u32, title: &str, text: &str) -> bool {
        let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd as HWND;
        nid.uID = uid;
        nid.uFlags = NIF_INFO;
        nid.szInfo = to_wide(text);
        nid.szInfoTitle = to_wide(title);
        nid.dwInfoFlags = NIIF_INFO;
        unsafe { Shell_NotifyIconW(NIM_MODIFY, &nid) == TRUE }
    }
}
