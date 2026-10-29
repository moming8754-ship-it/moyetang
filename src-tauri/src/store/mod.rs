//! Store：定位数据目录、建立子目录。
//!
//! 约定（不要改）：默认数据目录是 `D:\东方摩耶堂\`，用户可在设置里改；
//! 改后的值记录在**默认目录**下 `config.json` 的 `dataDir` 字段里，下次启动据此定位。
//! M0 只做「定位 + 建目录 + 让前端能拿到路径」，真正的读写/原子写在 M1 落地。

pub mod assets;
pub mod atomic;
/// M14-B：批注（`annotations.json`）
pub mod annotations;
/// M15：隐藏档案库（`archive.json` + `notes/_archive/`）
pub mod archive;
pub mod awards;
/// 备份导出 / 导入（M7）
pub mod backup;
pub mod config;
pub mod countdown;
pub mod dailies;
/// M27（v2.18.0）：笔记导出 / 导入（人可读的 md / txt，图片连带走）
pub mod export;
pub mod info;
pub mod mottos;
pub mod note;
pub mod reminder;
/// 真删之前的留档（`backups/` 里那份原文，比 `.bak` 活得久）
pub mod safety;
/// M21（v2.11.0）：同步的数据层地基（删除记录 / 设备状态 / 两条纯判定）
pub mod sync;
pub mod sync_merge;
pub mod sync_apply;
pub mod sync_proto;
#[cfg(test)]
pub mod sync_e2e;
pub mod sync_server;
pub mod todo;
pub mod tree;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 默认数据目录（写入约定）
///
/// - **电脑版（Windows）**：写死的老路径 —— V1/V2 的用户数据就在那儿，**一个字都不改**
/// - **手机版（Android）**：scoped storage 下"用户自己指定数据目录"不成立，只能用
///   **应用私有目录**。它由启动代码注入（见 [`set_default_dir`]）——`Store` 自己拿不到
///   AppHandle，所以由 `lib.rs` 的 setup 把 `app_data_dir()` 递进来。
#[cfg(windows)]
pub fn default_data_dir() -> std::path::PathBuf {
    use std::path::PathBuf;
    // ① 环境变量优先（开源版 / 多开测试用）
    if let Some(dir) = std::env::var_os("MOYETANG_DATA_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    // ② 作者机器上的老路径：存在就继续用（升级不搬家）
    let legacy = PathBuf::from(r"D:\东方摩耶堂");
    if legacy.exists() {
        return legacy;
    }
    // ③ 新用户：%USERPROFILE%\Documents\东方摩耶堂
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(profile).join("Documents").join("东方摩耶堂");
    }
    PathBuf::from("东方摩耶堂")
}
/// 非 Windows 平台没有"写死的老路径"这回事（手机版靠 [`set_default_dir`] 注入）
#[cfg(not(windows))]
pub fn default_data_dir() -> std::path::PathBuf { std::path::PathBuf::from("") }
/// 设置文件名
pub const CONFIG_FILE: &str = "config.json";

/// 手机（Android）在启动时注入的默认数据目录（**只注入一次**）
///
/// 用途：M17（2.0.0）手机版数据落"应用私有目录"。放 `OnceLock` 而不是加参数，
/// 是为了让 `Store::locate()` 的签名一个字不改 —— 电脑端那条路保持原样。
static DEFAULT_DIR_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 注入默认数据目录（**手机版专用**：`lib.rs` 的 setup 里用 `app_data_dir()` 调它）
///
/// ⚠️ 电脑版永远不会调它（电脑走写死的老路径）→ 用 `cfg_attr` 精确放行 dead_code，
/// 而不是无脑 `allow`（电脑端该报的警告还是要报）。
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn set_default_dir(dir: impl Into<PathBuf>) {
    let _ = DEFAULT_DIR_OVERRIDE.set(dir.into());
}

/// 真正的默认目录：注入过就用注入的（手机），否则用写死的（电脑）
fn effective_default_dir() -> PathBuf {
    match DEFAULT_DIR_OVERRIDE.get() {
        Some(dir) => dir.clone(),
        None => default_data_dir(),
    }
}

/// 数据目录下的子目录（M0 需要先建好，后续各模块直接用）
pub const SUB_DIRS: [&str; 5] = ["assets", "backups", "notes", "dailies", "sync"];

/// config.json 里目前只关心 `dataDir`。
///
/// ⚠️ 教训：这里只做「解析」，**绝不要**把已经序列化好的字符串再交给序列化函数，
/// 否则会写出"套娃 JSON"导致文件读不回来（草笺项目踩过）。
#[derive(Debug, Default, serde::Deserialize)]
struct ConfigDataDir {
    #[serde(default, rename = "dataDir")]
    data_dir: Option<String>,
}

/// 全局状态：持有 Store（数据目录将来可在设置里改，所以要能换，故用 Mutex）
pub struct AppState {
    pub store: Mutex<Store>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store: Mutex::new(store),
        }
    }
}

/// Store：数据目录的唯一入口
#[derive(Debug, Clone)]
pub struct Store {
    data_dir: PathBuf,
}

impl Store {
    /// 定位数据目录：默认目录下 config.json 里写了 `dataDir` 就用它，否则用默认值。
    ///
    /// ⚠️ 手机版的"默认值"是应用私有目录（启动时 [`set_default_dir`] 注入的）。
    pub fn locate() -> Self {
        let default_dir = effective_default_dir();
        let data_dir = configured_data_dir(&default_dir).unwrap_or(default_dir);
        Self { data_dir }
    }

    /// 直接指定数据目录。
    ///
    /// 用途：单元测试（不碰真实数据目录）；以后"恢复到别的目录/切目录"也会用。
    /// 注意：它**不读** config.json，调用方要自己负责把 `dataDir` 记下来。
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: dir.into(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        self.data_dir.as_path()
    }

    /// 建立数据目录与子目录（`assets/`、`backups/`、`notes/`）
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.data_dir)?;
        for sub in SUB_DIRS {
            fs::create_dir_all(self.data_dir.join(sub))?;
        }
        Ok(())
    }

    /// 把数据**复制**到另一个目录（切换数据目录时用）。
    ///
    /// 两条安全规则：
    /// 1. 目标已存在的文件/目录**一律不覆盖** —— 那边可能有用户自己的数据；
    /// 2. 只读源目录、只写目标目录，出错也不会动到原目录（所以调用方可以"失败了就不切")。
    ///
    /// 不复制 `backups/`：备份是"某个目录的历史快照"，搬过去只会白占空间。
    pub fn copy_data_to(&self, target: &Path) -> std::io::Result<()> {
        fs::create_dir_all(target)?;
        for entry in DATA_ENTRIES {
            let from = self.data_dir.join(entry);
            if !from.exists() {
                continue;
            }
            let to = target.join(entry);
            if to.exists() {
                continue;
            }
            copy_recursive(&from, &to)?;
        }
        for sub in SUB_DIRS {
            fs::create_dir_all(target.join(sub))?;
        }
        Ok(())
    }
}

/// 切换数据目录时需要跟着走的条目（`backups/` 故意不在列表里）
pub(crate) const DATA_ENTRIES: [&str; 13] = [
    "info.jsonl",
    "config.json",
    "todos.json",
    "reminders.json",
    "notes",
    "assets",
    // M11-A：每日报告（用户手写的那部分）—— 换目录必须带着走
    "dailies",
    // M12-A：奖状 / 证书
    "awards.json",
    // M12-C：格言与原则
    "mottos.json",
    // M14-B：批注
    "annotations.json",
    // M15：档案库
    // ⚠️ **只要 `archive.json` 这一条**：被收纳的笔记文件在 `notes/_archive/` 里，
    //    而 `notes` 整棵目录本来就在列表里（连子目录一起递归复制），再列一次只会白跑一趟。
    "archive.json",
    // 2026-10-04：倒计时（目标日 + 一句话）—— 换目录也必须带着走
    "countdowns.json",
    // M21（v2.11.0）：同步用的删除记录 + 设备状态（**换目录必须带着走**，否则那台设备的
    // 身份和"删过什么"就断了，两边会开始互相复活已删的东西）
    "sync",
];

/// 递归复制文件/目录（目标已存在时由调用方保证不进来）
pub(crate) fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::metadata(from)?.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from, to)?;
    }
    Ok(())
}

/// 读取配置里指定的数据目录（不存在/读不动/为空 → None，回退默认值）
fn configured_data_dir(default_dir: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(default_dir.join(CONFIG_FILE)).ok()?;
    let cfg: ConfigDataDir = serde_json::from_str(&raw).ok()?;
    let dir = cfg.data_dir?;
    let dir = dir.trim();
    if dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    }
}

/// 单元测试用的临时数据目录（每个测试一个独立空目录，不碰真实数据）
#[cfg(test)]
pub fn temp_store(tag: &str) -> Store {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);

    let dir = std::env::temp_dir().join(format!(
        "moyetang-{tag}-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&dir).expect("建测试目录");
    Store::at(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "moyetang-store-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("建测试目录");
        dir
    }

    #[test]
    fn 建目录时会建齐子目录() {
        let dir = temp_dir("ensure");
        let store = Store::at(&dir);
        store.ensure_dirs().unwrap();
        for sub in SUB_DIRS {
            assert!(dir.join(sub).is_dir(), "{sub} 应存在");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 复制数据不覆盖目标已有文件() {
        let src = temp_dir("copy-src");
        let dst = temp_dir("copy-dst");

        let store = Store::at(&src);
        store.ensure_dirs().unwrap();
        fs::write(src.join("info.jsonl"), "源里的信息\n").unwrap();
        fs::write(src.join("notes").join("a.json"), "{}").unwrap();
        // 目标已有一份自己的信息 → 必须保留
        fs::write(dst.join("info.jsonl"), "目标自己的信息\n").unwrap();

        store.copy_data_to(&dst).unwrap();

        assert_eq!(
            fs::read_to_string(dst.join("info.jsonl")).unwrap(),
            "目标自己的信息\n",
            "目标已有文件不能被覆盖"
        );
        assert!(dst.join("notes").join("a.json").exists(), "缺失的文件要复制过去");
        assert!(dst.join("assets").is_dir(), "子目录要建齐");

        // 原目录原样不动
        assert_eq!(
            fs::read_to_string(src.join("info.jsonl")).unwrap(),
            "源里的信息\n"
        );

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }
}
