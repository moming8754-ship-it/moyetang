//! 全局快捷键（M6）：**Ctrl+Space** 随时唤起快捷小窗。
//!
//! # 为什么放 Rust
//! 前端的 `keydown` 只在窗口聚焦时才收得到；"任意界面一键速记"必须是**全局**热键，
//! 只有操作系统层面能注册（`tauri-plugin-global-shortcut` → 底层 global-hotkey）。
//!
//! # ⚠️ 注册失败是常态，不能静默
//! `Ctrl+Space` 在中日韩输入法里基本被占用（切全角/半角），也可能被别的程序抢走。
//! 所以：
//! - 注册失败要**留痕**（eprintln）并把失败原因交给设置页显示；
//! - 快捷键本身**可以改**（`config.shortcuts.toggleSmallWindow`），改完重注册；
//! - 换键时先把旧的**全部注销**，否则会越注册越多、按一下开好几个窗。

use crate::window;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 默认唤起小窗的快捷键（DEV-PLAN §2.2 / PRD §2.3 指定）
pub const DEFAULT_TOGGLE: &str = "Ctrl+Space";

/// 注册（或按新键重注册）「唤起小窗」的全局快捷键
pub fn register(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return Err("没有配置唤起小窗的快捷键".to_string());
    }

    // 先全撤掉：换键时不撤旧的，会变成"按一下触发好几个动作"
    let _ = app.global_shortcut().unregister_all();

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(accelerator, move |_app, _shortcut, event| {
            // 只认"按下"。不判状态的话松手时又来一次，按住不放会疯狂开关窗。
            if event.state() == ShortcutState::Pressed {
                // 🔴 2026-10-13（用户反馈第 6 条**真正落地**）：原来是 `toggle_small_window`
                //    —— 只碰 1 号窗、开着就收。用户要的是「**按好多次 = 出好多个小窗**」，
                //    而且他补了一句：`Ctrl+Space` 被「花笺」占着、他只能按 F9 →
                //    **快捷键这条路必须能多开**。详见 `window::bring_up_small_window`。
                if let Err(error) = window::bring_up_small_window(&handle) {
                    eprintln!("[东方摩耶堂] 唤起速记窗失败：{error}");
                }
            }
        })
        .map_err(|e| {
            format!("注册全局快捷键「{accelerator}」失败（多半被输入法或别的程序占用了）：{e}")
        })
}

/// 把当前生效的快捷键注销掉（设置里关掉这个功能时用）
pub fn unregister_all(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

/// 这个组合键**现在是不是真的被系统接受了**
///
/// 为什么要单开一条：`Ctrl+Space` 在中日韩输入法里几乎必然被占用（切全角/半角），
/// 而"注册失败"这件事用户是**看不见**的 —— 他只知道自己按了没反应。
/// 所以设置页要能拿它显示"这个键注册不上，换一个"，验收脚本也拿它挑一个能用的键。
pub fn is_registered(app: &AppHandle, accelerator: &str) -> bool {
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return false;
    }
    app.global_shortcut().is_registered(accelerator)
}
