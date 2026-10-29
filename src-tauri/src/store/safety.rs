//! 真删之前的"留后路"：把**即将被删掉的东西原文**存进 `<数据目录>/backups/`。
//!
//! # 为什么不能只靠 `.bak`
//! `store::atomic` 每次写都会把上一版留成 `.bak` —— 但**只有上一版**：
//! 用户接着点两下别的操作，`.bak` 就被新的内容盖掉了，被删的东西再也找不回来。
//! 这不是假想：2026-09-20 真丢过两条用户手工建的待办（`我一定要学会做饭`、`买牛奶`），
//! 逐条排查了 7 个代码路径都找不出是谁删的，最后只能从 4.3 MB 的整包备份 zip 里捞回来。
//!
//! # 留什么
//! **原文，一个字节都不动**（连 BOM 都照抄）—— 事后想回滚就是原样复制回去，
//! 不用管反序列化会不会丢字段、也不用管模型改了没有。
//!
//! # 留多少
//! 每个"族"（`prefix`）只留最近 [`ARCHIVE_KEEP`] 份，免得反复操作把 `backups/` 撑爆。
//!
//! # 谁会用到
//! - `todo::purge_removed`（清理"来源已移除"）→ `todos-清理前-<时间>-N条.json`
//! - `todo::delete`（删单条待办）→ `todos-删除前-<时间>.json`
//! - `info::delete`（删一条信息）→ `info-删除前-<时间>.json`
//! - `note::purge_trash`（清空回收站）→ `回收站-清空前-<时间>-N个文件.json`
//!
//! 笔记的**普通删除不算**真删（挪进 `notes/_trash/`，本身就是留后路）。

use crate::store::atomic;
use crate::store::Store;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 每个族最多留几份留档
pub const ARCHIVE_KEEP: usize = 20;

/// 一份留档长什么样（写成一个 JSON 文件，人也能直接读）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    /// 留档时间（ISO）
    pub at: String,
    /// 干什么之前留的（给人看的一句话）
    pub label: String,
    /// 文件名 → 原文
    pub files: BTreeMap<String, String>,
}

/// `<数据目录>/backups`（没有就建）
pub fn backups_dir(store: &Store) -> Result<PathBuf, String> {
    let dir = store.data_dir().join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 backups 目录失败：{e}"))?;
    Ok(dir)
}

/// 留一份档（单文件版）。
///
/// `prefix` = 族名（决定文件名前缀，也是清理旧档的依据），
/// `suffix` = 文件名尾巴上那点给人看的提示（比如 `2条`；不想要就传空串），
/// `raw`    = 即将被删掉的那份文件的**原文**。
///
/// 返回留档文件路径；**留档失败会返回 Err，调用方应当因此中止删除**
/// （宁可不删也不冒丢数据的险，和 `backup::import` 一个调子）。
pub fn archive(store: &Store, prefix: &str, suffix: &str, raw: &str) -> Result<PathBuf, String> {
    let mut files = BTreeMap::new();
    files.insert(format!("{prefix}.txt"), raw.to_string());
    write_archive(store, prefix, suffix, prefix, files)
}

/// 留一份档（多文件版，给"清空回收站"这种一次删一堆的用）
pub fn archive_many(
    store: &Store,
    prefix: &str,
    suffix: &str,
    label: &str,
    files: Vec<(String, String)>,
) -> Result<PathBuf, String> {
    let mut map = BTreeMap::new();
    for (name, text) in files {
        map.insert(name, text);
    }
    write_archive(store, prefix, suffix, label, map)
}

fn write_archive(
    store: &Store,
    prefix: &str,
    suffix: &str,
    label: &str,
    files: BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    let dir = backups_dir(store)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S");
    let tail = if suffix.is_empty() {
        String::new()
    } else {
        format!("-{suffix}")
    };
    let dest = dir.join(format!("{prefix}-{stamp}{tail}.json"));
    let payload = Archive {
        at: crate::models::now_iso(),
        label: label.to_string(),
        files,
    };
    atomic::atomic_write_json(&dest, &payload).map_err(|e| format!("留档失败：{e}"))?;
    prune(&dir, prefix);
    Ok(dest)
}

/// 只留最近 [`ARCHIVE_KEEP`] 份同族的留档（按文件名排序 = 按时间排序）
pub fn prune(dir: &Path, prefix: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let head = format!("{prefix}-");
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(&head) && name.ends_with(".json") && !name.ends_with(".json.bak"))
        .collect();
    names.sort();
    let drop_count = names.len().saturating_sub(ARCHIVE_KEEP);
    for name in names.into_iter().take(drop_count) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// 同步前快照最多留几份（2026-10-13 加）。
///
/// 为什么是 10：同步前快照是**每一轮同步**都会留一份的自动产物，本意只是"这一轮之前的样子"。
/// 留最近 10 轮足够回滚，再多就只是白占盘 —— 实测曾经一路堆到 **41 个目录 / 105.75 MB**
/// （`backups/` 第二大的一块，仅次于导入前 zip）。
pub const SYNC_SNAPSHOT_KEEP: usize = 10;

/// 只留最近 `keep` 个「名字以 `prefix` 开头」的**目录**（按名字排序 ＝ 按时间排序）。
///
/// # 谁在用（2026-10-13）
/// 同步前快照有**两族名字**，都得管，否则照样只进不出：
/// - `backups/sync-pre/<时间戳>/` —— 电脑端当服务端、接收同步前留的（`sync_server.rs`），
///   传 `prefix = ""`（那个目录是专用的，里面只有快照）；
/// - `backups/sync-pre-<时间戳>/` —— 手机/客户端侧同步前留的（`sync_apply.rs`），
///   传 `prefix = "sync-pre-"`。
///
/// ⚠️ **只删目录、只认前缀**：`backups/` 根下还躺着整包 zip、`safety.rs` 那些
/// 「XX-删除前.json」、`.bak` 和用户自己放的东西 —— 一个都不许碰。
/// ⚠️ 删失败只记一行日志，**不往上抛**：留档已经成功了，清理失败不该让同步失败。
pub fn prune_dirs(dir: &Path, prefix: &str, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(prefix))
        .collect();
    names.sort();
    let drop_count = names.len().saturating_sub(keep);
    for name in names.into_iter().take(drop_count) {
        if let Err(error) = std::fs::remove_dir_all(dir.join(&name)) {
            eprintln!("[东方摩耶堂] 清理旧同步快照 {name} 失败（不影响同步）：{error}");
        }
    }
}

/// 读一份留档（**只有单测用**，所以标了 `#[cfg(test)]` —— 免得报 dead_code 警告）。
/// 人要是想手工恢复：留档里 `files` 的值就是**原文**，直接拿它覆盖回去即可，
/// 不需要经过这个函数、也不需要经过任何解析（这正是留档"存原文"的意义）。
#[cfg(test)]
fn read_archive(path: &Path) -> Result<Archive, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读留档失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("留档内容读不动：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn 留档写的是原文并且读得回来() {
        let store = temp_store("safety-archive");
        let raw = "{\"items\":[{\"id\":\"t1\",\"title\":\"要删的\"}]}";
        let path = archive(&store, "todos-删除前", "", raw).unwrap();

        assert!(path.is_file(), "留档文件该真的落盘：{}", path.display());
        let back = read_archive(&path).unwrap();
        let kept = back.files.values().next().unwrap();
        assert_eq!(kept, raw, "★ 留的必须是**原文**，一个字节都不能变");
        assert!(back.at.contains('T'), "得记下留档时间：{}", back.at);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.starts_with('\u{feff}'), "别写 BOM（serde 会读不动）");
    }

    #[test]
    fn 多文件留档一次装下() {
        let store = temp_store("safety-archive-many");
        let path = archive_many(
            &store,
            "回收站-清空前",
            "2个文件",
            "清空回收站",
            vec![
                ("a.json".to_string(), "{\"title\":\"甲\"}".to_string()),
                ("b.json".to_string(), "{\"title\":\"乙\"}".to_string()),
            ],
        )
        .unwrap();
        let back = read_archive(&path).unwrap();
        assert_eq!(back.files.len(), 2);
        assert_eq!(back.files["a.json"], "{\"title\":\"甲\"}");
        assert!(path.file_name().unwrap().to_string_lossy().contains("2个文件"));
    }

    #[test]
    fn 每族只留最近二十份_别的族和bak都不动() {
        let store = temp_store("safety-archive-prune");
        let dir = backups_dir(&store).unwrap();
        for index in 0..25 {
            std::fs::write(dir.join(format!("todos-删除前-2026-09-21-{:06}.json", index)), b"{}")
                .unwrap();
        }
        // 不该被它删的：别的族、整包备份、以及 .bak
        std::fs::write(dir.join("info-删除前-2026-09-21-000000.json"), b"{}").unwrap();
        std::fs::write(dir.join("笔记备份-导入前-2026-09-21-000000.zip"), b"ZIP").unwrap();
        std::fs::write(dir.join("todos-删除前-2026-09-21-000000.json.bak"), b"{}").unwrap();

        prune(&dir, "todos-删除前");

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        let kept = names
            .iter()
            .filter(|name| name.starts_with("todos-删除前-") && name.ends_with(".json"))
            .count();
        assert_eq!(kept, ARCHIVE_KEEP, "只留最近 20 份：{names:?}");
        assert!(names.iter().any(|name| name.starts_with("info-删除前-")), "别动别的族");
        assert!(names.iter().any(|name| name.ends_with(".zip")), "别动整包备份");
        assert!(names.iter().any(|name| name.ends_with(".json.bak")), "别动 .bak");
        assert!(!names.contains(&"todos-删除前-2026-09-21-000000.json".to_string()));
        assert!(names.contains(&"todos-删除前-2026-09-21-000024.json".to_string()));
    }

    /// 🔴 2026-10-13：同步前快照原来**没有任何清理**（实测堆到 41 个目录 / 105.75 MB）。
    /// 这条钉住两族名字都管、而且**只碰目录、只认前缀**。
    #[test]
    fn 同步快照只留最近十份_别的目录和文件一个不碰() {
        let store = temp_store("safety-prune-dirs");
        let dir = backups_dir(&store).unwrap();
        // 两族快照各造 13 份：`backups/sync-pre-<时间戳>/` 与 `backups/sync-pre/<时间戳>/`
        for index in 0..13 {
            std::fs::create_dir_all(dir.join(format!("sync-pre-2026-10-13-0000{index:02}"))).unwrap();
        }
        let inner = dir.join("sync-pre");
        for index in 0..13 {
            std::fs::create_dir_all(inner.join(format!("2026-10-13-0000{index:02}"))).unwrap();
        }
        // 不许碰的三样：整包 zip、别族留档、用户自己塞进来的东西
        std::fs::write(dir.join("笔记备份-2026-10-13.zip"), b"ZIP").unwrap();
        std::fs::write(dir.join("todos-删除前-2026-10-13-000000.json"), b"{}").unwrap();
        std::fs::write(dir.join("我自己放的东西.txt"), b"hi").unwrap();

        prune_dirs(&dir, "sync-pre-", SYNC_SNAPSHOT_KEEP);
        prune_dirs(&inner, "", SYNC_SNAPSHOT_KEEP);

        let dirs_named = |path: &Path, head: &str| {
            std::fs::read_dir(path)
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_type().unwrap().is_dir())
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(head))
                .count()
        };
        assert_eq!(
            dirs_named(&dir, "sync-pre-"),
            SYNC_SNAPSHOT_KEEP,
            "backups 根下那族只留 10 个"
        );
        assert_eq!(
            dirs_named(&inner, ""),
            SYNC_SNAPSHOT_KEEP,
            "sync-pre/ 里面只留 10 个"
        );
        assert!(dir.join("笔记备份-2026-10-13.zip").is_file(), "整包 zip 不许碰");
        assert!(
            dir.join("todos-删除前-2026-10-13-000000.json").is_file(),
            "别族留档不许碰"
        );
        assert!(
            dir.join("我自己放的东西.txt").is_file(),
            "用户自己放的东西不许碰"
        );
    }
}
