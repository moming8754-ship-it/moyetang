//! 后台调度：45 分钟信息提醒（M2）。
//!
//! 为什么放后端：关掉页面/切到别的区也要照常计时，而且提醒是"数据变化"，
//! 前端只该被动收事件（`reminder-fired` / `data-changed`），不该各自轮询。
//!
//! 节奏：每 30 秒扫一趟。这个频率对"45 分钟"这个量级足够，也不会吵到磁盘。

use crate::models::now_iso;
use crate::store::{config, reminder, AppState};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 扫描间隔
const TICK: Duration = Duration::from_secs(30);

/// 起一个后台线程开始扫描（自本进程启动即生效）
pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        if let Err(error) = tick(&app) {
            // 调度出问题不能把线程弄死，留痕后继续下一趟
            eprintln!("[东方摩耶堂] 提醒扫描失败：{error}");
        }
    });
}

/// 扫一趟：到点的提醒 → 广播给前端
///
/// ⚠️ 这里**不能**因为"45 分钟提醒被关掉"就整个 return（M2 就是这么写的，M5 修掉）：
/// `scan` 同时负责待办提醒（⚙ 里的「再次设定时间提醒」），
/// 把 `info_stale_enabled` 提到外面当总闸，会让待办提醒永远不响。
/// 这个开关只作用于"信息放久了"那一类（见 `reminder::scan` 的注释）。
fn tick(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let store = state
        .store
        .lock()
        .map_err(|e| format!("数据目录状态锁异常：{e}"))?;

    // 配置文件坏了也别让调度停摆：退回默认值（默认就是开启、45 分钟）
    let cfg = config::load(&store).unwrap_or_default();
    let minutes = cfg.reminders.info_stale_minutes.max(1);
    let fired = reminder::scan(
        &store,
        minutes,
        cfg.reminders.info_stale_enabled,
        &now_iso(),
    )?;
    drop(store);

    if fired.is_empty() {
        return Ok(());
    }

    println!("[东方摩耶堂] 弹出 {} 条提醒", fired.len());
    if let Err(e) = app.emit("reminder-fired", &fired) {
        eprintln!("[东方摩耶堂] 广播 reminder-fired 失败：{e}");
    }
    // M10-7：同时冒一条**系统托盘气泡** —— 应用收进托盘时（窗口没开着）也能看见提醒。
    // ⚠️ 只在非主线程调（这里是调度线程，✅）；失败不影响上面的应用内提醒。
    // ⚠️ M17（2.0.0）：托盘是**桌面专属** —— 手机版没有托盘气泡，提醒走应用内横幅
    //    （`reminder-fired` 已经在上面广播过了），所以这段在安卓上编译时就不存在。
    #[cfg(desktop)]
    for item in &fired {
        let (title, body) = balloon_text(item);
        crate::tray::balloon(app, &title, &body);
    }
    if let Err(e) = app.emit("data-changed", ()) {
        eprintln!("[东方摩耶堂] 广播 data-changed 失败：{e}");
    }
    Ok(())
}

/// M10-7：把一条提醒翻成"气泡上写什么"（标题 + 正文）。
///
/// 两类提醒分开写：信息放久了提醒它是"该处理一下了"，待办提醒是"到点了"。
/// 正文尽量短（气泡就巴掌大，`szInfo` 是 256 个 UTF-16 的定长缓冲，
/// 交给 `tray::win::to_wide` 去截断，这里先自己砍到不啰嗦的长度）。
///
/// ⚠️ M17（2.0.0）：手机版不冒托盘气泡，所以这个函数在安卓上是"没人调"的 ——
/// 用 `cfg_attr` 精确放行，**不用**无脑 `allow(dead_code)`（桌面端该报的还是要报）。
#[cfg_attr(mobile, allow(dead_code))]
fn balloon_text(item: &crate::models::Reminder) -> (String, String) {
    use crate::models::ReminderKind;
    let text: String = item.payload.text.chars().take(80).collect();
    let title = match item.kind {
        ReminderKind::InfoStale => "东方摩耶堂 · 有信息放久了",
        ReminderKind::TodoRemind => "东方摩耶堂 · 待办到点了",
    };
    let body = if text.trim().is_empty() {
        "打开应用看看".to_string()
    } else {
        text
    };
    (title.to_string(), body)
}

#[cfg(test)]
mod tests {
    use super::balloon_text;
    use crate::models::{now_iso, Reminder, ReminderKind, ReminderPayload};
    use crate::store::reminder;
    use crate::store::temp_store;

    /// 调度本身很薄，真正要保证的是"扫描逻辑能独立跑"（不依赖 Tauri 运行时）
    #[test]
    fn 扫描逻辑可以脱离界面单独跑() {
        let store = temp_store("scheduler-scan");
        let fired = reminder::scan(&store, 45, true, &now_iso()).unwrap();
        assert!(fired.is_empty(), "空数据目录扫不出提醒");
    }

    /// M10-7：气泡文案（两类提醒的标题不一样；空正文别变成一条空气泡）
    #[test]
    fn 气泡文案两类提醒分得开_空正文有兜底() {
        let make = |kind: ReminderKind, text: &str| Reminder {
            id: "r1".into(),
            kind,
            ref_id: "t1".into(),
            fire_at: now_iso(),
            status: Default::default(),
            payload: ReminderPayload {
                text: text.to_string(),
                category_text: String::new(),
                note: String::new(),
            },
            snoozed_until: None,
            key: String::new(),
        };

        let (title, body) = balloon_text(&make(ReminderKind::TodoRemind, "买牛奶"));
        assert!(title.contains("待办"), "标题该说明是待办：{title}");
        assert_eq!(body, "买牛奶");

        let (title, body) = balloon_text(&make(ReminderKind::InfoStale, "   "));
        assert!(title.contains("信息"), "标题该说明是信息：{title}");
        assert_eq!(body, "打开应用看看", "空正文要有兜底，不能冒一条空气泡");
    }
}
