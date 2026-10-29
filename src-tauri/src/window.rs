//! 快捷小窗（M6）：Ctrl+Space 随时唤起的**无边框速记窗**（花笺的招牌能力）。
//!
//! # 为什么窗口的创建/显示/隐藏都放 Rust
//! 1. 全局快捷键的回调在 Rust 侧（`shortcuts.rs`），它要能直接开窗；
//! 2. 前端调 `getCurrentWindow().hide()` / `close()` 需要**显式 ACL 权限**
//!    （草笺踩过：漏配 `core:window:allow-close` 就"点了没反应"），
//!    走自己的命令能省掉这一类坑。
//!
//! # 小窗和主窗共用同一份前端产物
//! 都加载 `index.html`，靠**窗口 label** 区分渲染哪个界面 ——
//! 前端用 `getCurrentWindow().label === "small"` 判断，**不依赖 URL 参数**
//! （URL 里带 query 在 Tauri 的 asset 协议下不一定稳，label 是现成的、更可靠）。
//!
//! # 收起 ≠ 销毁
//! `hide()` 只是藏起来，窗口里的内容（没存完的草稿）还在，下次 Ctrl+Space 还能看到。
//! 真要销毁得由用户显式关掉。

use crate::models::{FocusPos, SmallPosition, WindowConfig};
use crate::store::{self, AppState};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 小窗的 label（前端也用它判断"我是小窗"）
pub const SMALL_LABEL: &str = "small";

/// 小窗默认尺寸
const SMALL_W: f64 = 560.0;
const SMALL_H: f64 = 400.0;

/// 小窗是不是开着而且可见
pub fn small_visible(app: &AppHandle) -> bool {
    app.get_webview_window(SMALL_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 读配置里"小窗出现在哪儿"（读不到就用默认值：**绝不因为读配置失败就不弹窗**）
fn small_position_config(app: &AppHandle) -> (SmallPosition, i32) {
    let fallback = WindowConfig::default();
    let loaded = app.try_state::<AppState>().and_then(|state| {
        let store = state.store.lock().ok()?;
        store::config::load(&store).ok()
    });
    match loaded {
        Some(config) => (
            config.window.small_position,
            config.window.small_mouse_offset,
        ),
        None => (fallback.small_position, fallback.small_mouse_offset),
    }
}

/// 把窗口挪到鼠标附近（B4：跟随鼠标）。
///
/// 三条规矩：
/// - 拿不到光标位置 → **什么都不做**（保持原位，别乱跳）；
/// - 窗口**避开屏幕右/下边缘**（要超出去就往回挪），不然会跑到屏幕外面、等于"按了没反应"；
/// - 左上角相对光标留 `offset` 像素，别让窗口正好压在光标底下。
fn move_small_window_to_cursor(window: &WebviewWindow, offset: i32) {
    let Ok(cursor) = window.cursor_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let offset = offset.max(0) as f64;
    let mut x = cursor.x + offset;
    let mut y = cursor.y + offset;

    if let Ok(Some(monitor)) = window.monitor_from_point(cursor.x, cursor.y) {
        let work = monitor.work_area();
        let left = work.position.x as f64;
        let top = work.position.y as f64;
        let right = left + work.size.width as f64;
        let bottom = top + work.size.height as f64;
        let w = size.width as f64;
        let h = size.height as f64;
        if x + w > right {
            x = (right - w).max(left);
        }
        if y + h > bottom {
            y = (bottom - h).max(top);
        }
        x = x.max(left);
        y = y.max(top);
    }
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// 创建小窗；**已经存在就直接复用**（重建会把里面没保存的草稿丢掉）
pub fn ensure_small_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(SMALL_LABEL) {
        return Ok(window);
    }

    let mut builder =
        WebviewWindowBuilder::new(app, SMALL_LABEL, WebviewUrl::App("index.html".into()));
    if let Ok(base) = app.path().app_local_data_dir() {
        builder = builder.data_directory(base.join("webview").join(SMALL_LABEL));
    }
    builder
        .title("东方摩耶堂 · 速记")
        .inner_size(SMALL_W, SMALL_H)
        .min_inner_size(420.0, 280.0)
        // 无边框（PRD 5.5 / DEV-PLAN M6）：外观全靠前端画，标题条自己拖
        .decorations(false)
        // 速记窗要"一按就盖在最上面"，不然切个窗口就找不到了
        .always_on_top(true)
        // 不在任务栏单独占一格：它是主窗的附属
        .skip_taskbar(true)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("创建小窗失败：{e}"))
}

/// 唤出小窗（没有就建，有了就显示并聚焦）
pub fn show_small_window(app: &AppHandle) -> Result<(), String> {
    let window = ensure_small_window(app)?;
    // 出现在哪儿（B4）：
    // - `mouse` → 挪到鼠标附近；
    // - `center` → **每次都摆回屏幕正中**。
    //
    // ⚠️ center 这一支**不能省**：建窗时的 `.center()` 只管第一次。
    //    2026-09-21 真踩到：先用过"跟随鼠标"，再切回"屏幕正中"，
    //    小窗就赖在鼠标那儿不动了（验收脚本量到左上角 211,211 而屏幕中心不是那儿）。
    //    用户选"屏幕正中"的意思就是"每次都正中、位置固定、心里有数"。
    let (position, offset) = small_position_config(app);
    match position {
        SmallPosition::Mouse => move_small_window_to_cursor(&window, offset),
        SmallPosition::Center => {
            if let Err(error) = window.center() {
                // 居中失败不该拦住"把窗弹出来"，记一笔就算了
                eprintln!("[东方摩耶堂] 小窗居中失败：{error}");
            }
        }
    }
    window.show().map_err(|e| format!("显示小窗失败：{e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("聚焦小窗失败：{e}"))?;
    // 通知小窗里的前端："你被唤出来了"（它可以借机把焦点放到输入框）
    let _ = tauri::Emitter::emit(app, "small-window-shown", ());
    Ok(())
}

/// 收起**指定的那一个**速记窗（**不销毁**，草稿留着）。
///
/// 🔴 **2026-10-20 修用户反馈 #4「多开之后关不掉」**：原来这里叫 `hide_small_window`，
/// 函数体写死了 `app.get_webview_window(SMALL_LABEL)` —— **永远只找 1 号窗**。
/// 而小窗自己的 Esc / ✕ 走的正是这条（`SmallWindow.tsx` 的 `close()` → `smallWindowHide()`），
/// 于是：**你在 `small-2` 上按 Esc，收的是隔壁的 `small`**；1 号早收起来了 → 看着像「怎么按都不动」。
/// （用户原话：「多开小窗后，给一个小窗关闭后，无法关闭其他小窗」。）
/// 那个写死的 label 来自 `f82983a`「v0.1.0 源码初始快照」，本来只有 1 个窗时是对的；
/// 2026-10-13 让快捷键真能多开之后，这条路才变得容易踩到。
///
/// # 两条硬规矩
/// 1. **只认速记窗**（[`small_index_of`] 认得出来的 label）：万一哪天有别的窗口误调，
///    也**绝不能把主窗 / 专注窗 / 挂件收起来**；
/// 2. 收之前**只给这个窗**发 `small-window-hide`（`emit_to`，不是广播）—— 让它自己先把
///    没保存的草稿存掉；Rust 不等它，所以是「尽力保存」，不是「存完才收」。
pub fn hide_one_small_window(app: &AppHandle, label: &str) -> Result<(), String> {
    if small_index_of(label).is_none() {
        // **不碰别的窗**：主窗 / 专注窗 / 挂件传进来，就当没这回事（不报错 —— 收不到不是错）。
        return Ok(());
    }
    let Some(window) = app.get_webview_window(label) else {
        return Ok(()); // 已经关掉了（或本来就没有）：什么都不用做
    };
    let _ = tauri::Emitter::emit_to(app, label, "small-window-hide", ());
    window.hide().map_err(|e| format!("收起小窗失败：{e}"))?;
    Ok(())
}

/// 🔴 2026-10-13：**快捷键的语义从「一键来回切」改成「再给一个」** —— 用户反馈第 6 条**这才算真落地**。
///
/// 用户原话（2026-10-13）：「**我可以按好多次 f9，同时也出好多个小窗**」，
/// 并且补了一句关键背景：**`Ctrl+Space` 常年被「花笺」占着、他只能按 F9**
/// ——（他还在用花笺，原因就是这边多开没做出来）。
///
/// # 老语义为什么必须删
/// 原来这里是 `toggle_small_window`：**只碰 1 号窗，开着就收、没开就弹**。
/// v2.21.0 那轮把多开做成了 **⧉ / 托盘菜单两个额外入口**，却把快捷键的老语义**原样留着**
/// （当时的注释还写着「F9 的老语义一个字没改」）→ 用户按 F9 试，看到的仍然是
/// 「再按一次把窗收走」，于是反馈回来还是「**多开依旧失败**」。
/// ⇒ 教训：用户报的是**他用得着的那个入口**，别只在他没提的入口上做功能。
///
/// # 现在的规则（三条入口**共用**这一套，不再分叉）
/// 1. 有「**藏着但还在**」的速记窗 → 先把**号最小**的那个拉出来并聚焦
///    （它是 Esc / 收起按钮藏起来的，**草稿还在** —— 别让用户以为草稿丢了）；
/// 2. 没有藏着的（全可见 / 一个都没有）→ **再开一个新的**（1→[`SMALL_MAX`] 号）；
/// 3. 号满了 → 把**最后一个**拿到最前（不新建，免得开出几十个窗）。
///
/// 收起来的三条路：① 小窗自己的 **Esc**（`SmallWindow` 里监听，会自动存草稿）
/// ② 标题栏那颗收起按钮 ③ 托盘菜单「**收起所有速记窗**」（[`hide_all_small_windows`]）。
pub fn bring_up_small_window(app: &AppHandle) -> Result<String, String> {
    // ① 先捞「藏着但还在」的：从号小的开始
    for (index, window) in small_windows(app) {
        if window.is_visible().unwrap_or(false) {
            continue;
        }
        window.show().map_err(|e| format!("显示小窗失败：{e}"))?;
        let _ = window.set_focus();
        let _ = tauri::Emitter::emit(app, "small-window-shown", ());
        return Ok(small_label(index));
    }
    // ② 全可见（或还没有）→ 再开一个新的
    open_another_small_window(app)
}

/// 把所有速记窗**一次收起**（托盘菜单「收起所有速记窗」用）。
///
/// ⚠️ **只 hide、不销毁**：跟 [`hide_one_small_window`] 一个调子 —— 每篇草稿都还在窗里，
/// 下次 [`bring_up_small_window`] 会把它原样拉回来。
/// 先广播 `small-window-hide` 再收（这次是**真的广播给每个窗**：全都要存草稿）。
pub fn hide_all_small_windows(app: &AppHandle) {
    let _ = tauri::Emitter::emit(app, "small-window-hide", ());
    for (_, window) in small_windows(app) {
        let _ = window.hide();
    }
}

// ─────────────────── 小窗多开（2026-10-11 · 用户反馈第 6 条） ───────────────────

/// 最多能同时开几个速记窗（到顶之后"再开一个"＝把最后一个拿到前面来）
pub const SMALL_MAX: usize = 5;

/// 第 `index` 个速记窗的 label（从 1 数起）。
///
/// ⚠️ **第 1 个仍然叫 `small`**：托盘菜单、全局快捷键、`capabilities/default.json`、
/// m7 那套验收脚本全都认这个 label；多开出来的从 **2 号**开始叫 `small-2` / `small-3`…
pub fn small_label(index: usize) -> String {
    if index <= 1 {
        SMALL_LABEL.to_string()
    } else {
        format!("{SMALL_LABEL}-{index}")
    }
}

/// 一个速记窗的 label 算几号（不是速记窗就返回 `None`）
///
/// ⚠️ 手机版 / 主窗 / 专注窗 / 挂件都返回 `None` —— `main.tsx` 那边按同一套前缀分流。
pub fn small_index_of(label: &str) -> Option<usize> {
    if label == SMALL_LABEL {
        return Some(1);
    }
    let rest = label.strip_prefix(&format!("{SMALL_LABEL}-"))?;
    rest.parse::<usize>().ok()
}

/// 现在开着的速记窗（按号从小到大）
fn small_windows(app: &AppHandle) -> Vec<(usize, WebviewWindow)> {
    let mut found: Vec<(usize, WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| small_index_of(&label).map(|index| (index, window)))
        .collect();
    found.sort_by_key(|(index, _)| *index);
    found
}

/// 按 label 建一个速记窗（号 > 1 时**跟上一个错开一点**，免得叠成一摞看不出来有几个）
fn build_small_window(app: &AppHandle, index: usize) -> Result<WebviewWindow, String> {
    let label = small_label(index);
    let title = if index <= 1 {
        "东方摩耶堂 · 速记".to_string()
    } else {
        format!("东方摩耶堂 · 速记 {index}")
    };
    let mut builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()));
    if let Ok(base) = app.path().app_local_data_dir() {
        builder = builder.data_directory(base.join("webview").join(&label));
    }
    let window = builder
        .title(title)
        .inner_size(SMALL_W, SMALL_H)
        .min_inner_size(420.0, 280.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .build()
        .map_err(|e| format!("创建小窗失败：{e}"))?;

    // 摆哪儿：1 号照老规矩（`mouse` 跟随鼠标 / `center` 屏幕正中），
    // 2 号往后在它的位置上**斜着错开 28px**（一按就能看出开了几个）。
    let (position, offset) = small_position_config(app);
    let step = 28 * (index as i32 - 1);
    match position {
        SmallPosition::Mouse => move_small_window_to_cursor(&window, offset + step),
        SmallPosition::Center => {
            if let Err(error) = window.center() {
                eprintln!("[东方摩耶堂] 小窗居中失败：{error}");
            }
            if index > 1 {
                if let Ok(at) = window.outer_position() {
                    let _ = window.set_position(PhysicalPosition::new(at.x + step, at.y + step));
                }
            }
        }
    }
    Ok(window)
}

/// **再开一个速记窗**（2026-10-11 用户反馈第 6 条：用户原话「电脑版，发现快捷小窗无法多开……
/// 我点按 f9 出来一个小窗，再次点按，居然就把这小窗给删了」＋（问他时）「**想同时开好几个**」）。
///
/// 语义定死（写在这儿防返工）：
/// - **1 号窗还是 `small`**（托盘 / `m7` 那套验收 / `capabilities` 都认这个 label）；
///   多开出来的从 **2 号**开始叫 `small-2` / `small-3`…
/// - **只建窗、不做"先拉出藏着的"那一步** —— 那一步在 [`bring_up_small_window`] 里；
///   想"用户按一下就该有个能写的窗"就走它，别直接调这个。
/// - 号满（[`SMALL_MAX`]）了就把**最后一个**拿到前面来，不再新建（免得开出几十个窗）。
/// - 返回新窗（或拿到前面的那个窗）的 label（前端拿它做提示 / 验收脚本认人）。
pub fn open_another_small_window(app: &AppHandle) -> Result<String, String> {
    for index in 1..=SMALL_MAX {
        if app.get_webview_window(&small_label(index)).is_none() {
            let window = build_small_window(app, index)?;
            window.show().map_err(|e| format!("显示小窗失败：{e}"))?;
            let _ = window.set_focus();
            // 新窗里的前端也收一下"你被唤出来了"（跟 show_small_window 一个待遇：
            // 把光标放到输入框，抬手就能写）
            let _ = tauri::Emitter::emit(app, "small-window-shown", ());
            return Ok(small_label(index));
        }
    }
    // 满了：把最后一个（号最大的）拿到前面来
    let last = small_windows(app).pop().map(|(_, window)| window);
    match last {
        Some(window) => {
            let label = window.label().to_string();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = tauri::Emitter::emit(app, "small-window-shown", ());
            Ok(label)
        }
        None => {
            let window = build_small_window(app, 1)?;
            let _ = window.show();
            let _ = window.set_focus();
            Ok(SMALL_LABEL.to_string())
        }
    }
}

// ─────────────────────── 专注小窗（M13-A） ───────────────────────
//
// 和上面的"速记小窗"是**两个不同的窗**，别混：
// - `small`（M6）：Ctrl+Space 唤出的**临时速记**，居中 / 跟随鼠标，有草稿；
// - `focus`（M13-A）：待办点「开始」后**长期挂着**的"这件事正在进行中"，右下角、常驻、可拖。
//
// 🔴 三条和 `small` 一样的硬规矩：
// 1. **建窗的命令必须是 `async fn`**（同步命令跑在主线程，`build()` 要投递到主线程再等 → 互相等死，M6 踩过）；
// 2. `capabilities/default.json` 的 `windows` 列表里要写上 `focus`（运行时创建的窗口也按 label 匹配）；
// 3. 前端靠**窗口 label** 分流（`main.tsx`），不靠 URL 参数。

/// 专注小窗的 label（前端也用它判断"我是专注窗"）
pub const FOCUS_LABEL: &str = "focus";

/// 专注小窗的尺寸（小、常驻、不挡事）
const FOCUS_W: f64 = 300.0;
const FOCUS_H: f64 = 168.0;

/// 专注小窗是不是开着而且可见
pub fn focus_visible(app: &AppHandle) -> bool {
    app.get_webview_window(FOCUS_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 读配置里"专注小窗最后停在哪儿"（读不到就当没摆过 → 放右下角）
fn focus_pos_config(app: &AppHandle) -> Option<FocusPos> {
    let state = app.try_state::<AppState>()?;
    let store = state.store.lock().ok()?;
    let config = store::config::load(&store).ok()?;
    config.window.focus_pos
}

/// 把当前位置记进 config（**只在收起时记一次**：一边拖一边写盘太频繁，
/// 而且拖到一半的位置也不值得存）
fn save_focus_pos(app: &AppHandle, window: &WebviewWindow) {
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(store) = state.store.lock() else {
        return;
    };
    let Ok(mut config) = store::config::load(&store) else {
        return;
    };
    config.window.focus_pos = Some(FocusPos { x: pos.x, y: pos.y });
    if let Err(error) = store::config::save(&store, &config) {
        eprintln!("[东方摩耶堂] 记专注小窗位置失败：{error}");
    }
}

/// 第一次出现时放右下角。
/// ⚠️ **全程用物理像素**（monitor 给的是物理像素、屏幕是 150% 缩放）：
/// 混着逻辑像素算会把窗口摆到屏幕外面去（M4 那条"物理像素要除 devicePixelRatio"的近亲）。
fn place_focus_bottom_right(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let size = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let width = (FOCUS_W * scale).round() as i32;
    let height = (FOCUS_H * scale).round() as i32;
    let margin = (24.0 * scale).round() as i32;
    // 底下多留一截给任务栏
    let bottom = (64.0 * scale).round() as i32;
    let x = origin.x + size.width as i32 - width - margin;
    let y = origin.y + size.height as i32 - height - bottom;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// 创建专注小窗；**已经存在就直接复用**（重建会让正在显示的计时闪一下）
pub fn ensure_focus_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(FOCUS_LABEL) {
        return Ok(window);
    }
    let mut builder =
        WebviewWindowBuilder::new(app, FOCUS_LABEL, WebviewUrl::App("index.html".into()));
    if let Ok(base) = app.path().app_local_data_dir() {
        builder = builder.data_directory(base.join("webview").join(FOCUS_LABEL));
    }
    builder
        .title("东方摩耶堂 · 专注中")
        .inner_size(FOCUS_W, FOCUS_H)
        // 无边框：外观全靠前端画，标题条自己拖
        .decorations(false)
        // ★ 要的就是"一直在最上面"：切到别的窗口也能看见"这件事还在进行"
        .always_on_top(true)
        // 不在任务栏单独占一格：它是主窗的附属
        .skip_taskbar(true)
        .resizable(false)
        // ★ **别抢焦点**：用户还要接着干活，弹出来就抢焦点等于打断他
        .focused(false)
        .build()
        .map_err(|e| format!("创建专注小窗失败：{e}"))
}

/// 显示专注小窗（右下角常驻；拖过就回到上次停的地方）
pub fn show_focus_window(app: &AppHandle) -> Result<(), String> {
    let window = ensure_focus_window(app)?;
    match focus_pos_config(app) {
        Some(pos) => {
            let _ = window.set_position(PhysicalPosition::new(pos.x, pos.y));
        }
        None => place_focus_bottom_right(&window),
    }
    window
        .show()
        .map_err(|e| format!("显示专注小窗失败：{e}"))?;
    // ⚠️ **有意不调 `set_focus()`** —— 理由见上面 `.focused(false)` 那条注释
    Ok(())
}

/// 收起专注小窗（不销毁），并把位置记下来
pub fn hide_focus_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(FOCUS_LABEL) {
        save_focus_pos(app, &window);
        window
            .hide()
            .map_err(|e| format!("收起专注小窗失败：{e}"))?;
    }
    Ok(())
}

// ─────────────────────────── E 批：桌面挂件（2026-10-03） ───────────────────────────

/// 桌面挂件的 label（前端也用它判断"我是挂件窗"）
pub const WIDGET_LABEL: &str = "widget";

/// 挂件三档尺寸（**逻辑像素**；实际摆放时按显示器缩放换算成物理像素）
const WIDGET_SMALL: (f64, f64) = (200.0, 96.0);
const WIDGET_MID: (f64, f64) = (272.0, 232.0);
const WIDGET_BIG: (f64, f64) = (312.0, 320.0);

/// 按配置里的尺寸字符串取宽高（认不出来的按中号 —— 配置写坏了也不该开不出窗口）
pub fn widget_size_of(size: &str) -> (f64, f64) {
    match size {
        "small" => WIDGET_SMALL,
        "big" => WIDGET_BIG,
        _ => WIDGET_MID,
    }
}

/// 挂件是不是开着而且可见
pub fn widget_visible(app: &AppHandle) -> bool {
    app.get_webview_window(WIDGET_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 读挂件配置（读不到就给默认值 —— 别让"配置读不出来"变成"窗口开不出来"）
fn widget_config(app: &AppHandle) -> crate::models::WidgetConfig {
    app.try_state::<AppState>()
        .and_then(|state| {
            let store = state.store.lock().ok()?;
            store::config::load(&store).ok()
        })
        .map(|config| config.widget)
        .unwrap_or_default()
}

/// 把挂件当前位置记进 config（**只在收起时记一次**，理由同专注小窗）
pub fn save_widget_pos(app: &AppHandle, window: &WebviewWindow) {
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(store) = state.store.lock() else {
        return;
    };
    let Ok(mut config) = store::config::load(&store) else {
        return;
    };
    config.widget.pos = Some(FocusPos { x: pos.x, y: pos.y });
    if let Err(error) = store::config::save(&store, &config) {
        eprintln!("[东方摩耶堂] 记挂件位置失败：{error}");
    }
}

/// 第一次出现时放**右上角**（挂件不像专注小窗那样要避开任务栏右下角）
/// ⚠️ 全程物理像素，理由同 `place_focus_bottom_right`
fn place_widget_top_right(window: &WebviewWindow, size: (f64, f64)) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let msize = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let width = (size.0 * scale).round() as i32;
    let height = (size.1 * scale).round() as i32;
    let margin = (24.0 * scale).round() as i32;
    let top = (24.0 * scale).round() as i32;
    let x = origin.x + msize.width as i32 - width - margin;
    let y = origin.y + top;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
}

/// 把保存的位置夹进工作区。
///
/// 位置是物理像素；多显示器下 left/top 可以是负数。
fn clamp_widget_position(
    position: (i32, i32),
    size: (u32, u32),
    work_area: (i32, i32, u32, u32),
) -> (i32, i32) {
    let (left, top, width, height) = work_area;
    let right = left.saturating_add(width as i32);
    let bottom = top.saturating_add(height as i32);
    let max_x = right.saturating_sub(size.0 as i32).max(left);
    let max_y = bottom.saturating_sub(size.1 as i32).max(top);
    (position.0.clamp(left, max_x), position.1.clamp(top, max_y))
}

/// 创建挂件窗；**已经存在就复用**（重建会让挂件闪一下）
pub fn ensure_widget_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        return Ok(window);
    }
    let config = widget_config(app);
    let size = widget_size_of(&config.size);
    let mut builder =
        WebviewWindowBuilder::new(app, WIDGET_LABEL, WebviewUrl::App("index.html".into()));
    if let Ok(base) = app.path().app_local_data_dir() {
        builder = builder.data_directory(base.join("webview").join(WIDGET_LABEL));
    }
    builder
        .title("东方摩耶堂 · 挂件")
        // 无边框：外观全靠前端画，标题条自己拖
        .decorations(false)
        // 统一按置顶浮窗运行；「真桌面层」已由用户明确不做。
        .always_on_top(true)
        // 不在任务栏单独占一格（它是主窗的附属；托盘菜单能唤回来）
        .skip_taskbar(true)
        .resizable(false)
        // ★ **别抢焦点**：挂件是"看一眼"的东西，弹出来抢焦点等于打断他
        .focused(false)
        .inner_size(size.0, size.1)
        .build()
        .map_err(|e| format!("创建桌面挂件失败：{e}"))
}

/// 显示挂件（拖过就回到上次停的地方）
pub fn show_widget_window(app: &AppHandle) -> Result<(), String> {
    let window = ensure_widget_window(app)?;
    let config = widget_config(app);
    let size = widget_size_of(&config.size);
    match config.pos {
        Some(pos) => {
            // 换了显示器 / 分辨率后，旧坐标可能已经落在屏幕外。点不在任何显示器上时
            // 回右上角；只压住了一部分时夹回当前工作区。否则窗口创建成功但用户看不见。
            if let Ok(Some(monitor)) = window.monitor_from_point(pos.x as f64, pos.y as f64) {
                let work = monitor.work_area();
                let scale = monitor.scale_factor();
                let pixel_size = (
                    (size.0 * scale).round().max(1.0) as u32,
                    (size.1 * scale).round().max(1.0) as u32,
                );
                let (x, y) = clamp_widget_position(
                    (pos.x, pos.y),
                    pixel_size,
                    (
                        work.position.x,
                        work.position.y,
                        work.size.width,
                        work.size.height,
                    ),
                );
                let _ = window.set_position(PhysicalPosition::new(x, y));
                let _ = window.set_size(tauri::PhysicalSize::new(pixel_size.0, pixel_size.1));
            } else {
                place_widget_top_right(&window, size);
            }
        }
        None => place_widget_top_right(&window, size),
    }
    // 「真桌面层」不做；旧配置里的 layer=desktop 也按普通置顶浮窗运行。
    let _ = window.set_always_on_top(true);
    window.show().map_err(|e| format!("显示挂件失败：{e}"))?;
    Ok(())
}

/// 收起挂件（不销毁），并把位置记下来
pub fn hide_widget_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        save_widget_pos(app, &window);
        window.hide().map_err(|e| format!("收起挂件失败：{e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::clamp_widget_position;

    #[test]
    fn 屏幕外坐标会夹回工作区() {
        assert_eq!(
            clamp_widget_position((2956, 636), (312, 320), (0, 0, 1707, 1067)),
            (1395, 636)
        );
    }

    #[test]
    fn 多显示器负坐标也能夹回工作区() {
        assert_eq!(
            clamp_widget_position((-2500, 1200), (312, 320), (-1920, 0, 1920, 1080)),
            (-1920, 760)
        );
    }

    #[test]
    fn 窗口比工作区还大时贴住左上角() {
        assert_eq!(
            clamp_widget_position((100, 100), (2000, 1200), (0, 0, 1707, 1067)),
            (0, 0)
        );
    }
}
