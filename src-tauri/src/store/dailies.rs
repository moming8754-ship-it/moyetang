//! 每日报告 · **用户手写的那部分**（M11-A · 2026-09-26）
//!
//! # 为什么只存"手写的"
//! 日报里的三类内容 —— 「完成了哪些待办 / 设计了哪些待办 / 填写了哪些信息」——
//! **全都能实时从 `todos.json` / `info.jsonl` 算出来**（前端 `features/schedule/aggregate.ts`）。
//! 另存一份等于同一个事实有两个来源，迟早对不上（V1 一路踩出来的教训）。
//! 所以这里**只存用户自己敲的字**：每条"为什么没跟进"的说明、以及当天的小结。
//!
//! # 文件
//! 一天一个：`<数据目录>/dailies/YYYY-MM-DD.json`
//! ```json
//! { "date": "2026-09-26", "updatedAt": "…", "notes": [ { "key": "todo:<id>", "text": "…" } ] }
//! ```
//! ⚠️ **新增数据文件，已经在两处登记**：`store/backup.rs` 的 `ENTRIES`（导出备份要带上）
//! 与 `store/mod.rs` 的 `DATA_ENTRIES`（换数据目录要带上）。
//!
//! # 只留一年（用户定的）
//! [`KEEP_DAYS`] 天之前的那**整天文件**在每次写入时顺手清掉（[`prune`]）。
//! ⚠️ 这是真删，所以照 V1 的规矩**先整批留档到 `backups/`**（`store::safety`，每族只留最近 20 份），
//! **留档失败就中止删除** —— 宁可不删也不冒丢数据的险。

use chrono::{Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::models::now_iso;
use crate::store::{atomic, safety, Store};

/// 日报只留这么久（用户："只保存一年的[当日报告]"）
pub const KEEP_DAYS: i64 = 365;

/// 一天的手写内容
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct DailyReport {
    /// `YYYY-MM-DD`（**本地日期** —— 和界面上的"今天"必须是同一个算法）
    pub date: String,
    pub notes: Vec<DailyNote>,
    pub updated_at: String,
}

/// 一条手写说明。
///
/// `key` 指出"这句话是说谁的"：
/// - `todo:<待办 id>` —— 这条待办当天没做完，写一句为什么；
/// - `info:<信息 id>` —— 针对那天收进来的一条信息；
/// - `day` —— 当天小结（不属于任何一条）。
///
/// ⚠️ 用 id 而不是"第几条"：列表顺序会变，**位置锚点一改就全错位**（和批注栏那个坑同一个道理）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyNote {
    pub key: String,
    pub text: String,
}

/// 数据目录下的 `dailies/`
pub fn dir(store: &Store) -> PathBuf {
    store.data_dir().join("dailies")
}

/// 校验日期：必须是真实的 `YYYY-MM-DD`。
///
/// ⚠️ **这个校验同时是路径穿越的闸门**：`date` 会被拼进文件名，
/// 放过去的话 `../../config` 这种就能写到数据目录外面去。
fn check_date(date: &str) -> Result<NaiveDate, String> {
    let text = date.trim();
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .map_err(|_| format!("日期格式不对（要 YYYY-MM-DD）：{date}"))
}

/// 归一化后的日期串（`2026-9-1` 也收，统一写成 `2026-09-01`）
pub fn normalize_date(date: &str) -> Result<String, String> {
    Ok(check_date(date)?.format("%Y-%m-%d").to_string())
}

/// 某一天的日报文件路径
pub fn path_for(store: &Store, date: &str) -> Result<PathBuf, String> {
    Ok(dir(store).join(format!("{}.json", normalize_date(date)?)))
}

/// 读某一天；没有就返回空壳（前端不用判 `null`）
pub fn load(store: &Store, date: &str) -> Result<DailyReport, String> {
    let key = normalize_date(date)?;
    match atomic::read_json::<DailyReport>(&path_for(store, date)?)? {
        Some(mut report) => {
            report.date = key;
            Ok(report)
        }
        None => Ok(DailyReport {
            date: key,
            notes: Vec::new(),
            updated_at: String::new(),
        }),
    }
}

/// 写 / 改一条说明。`text` 去掉首尾空白后为空 = **把这一条删掉**。
///
/// 新增一条说明时，返回的 `notes` 顺序仍按 `key` 排（同一份文件里顺序稳定，
/// 免得每次刷新界面上的行序都在跳）。
pub fn set_note(store: &Store, date: &str, key: &str, text: &str) -> Result<DailyReport, String> {
    let day = normalize_date(date)?;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("说明总得挂在某一条上（key 不能为空）".to_string());
    }
    let text = text.trim().to_string();

    let mut report = load(store, &day)?;
    match report.notes.iter().position(|one| one.key == key) {
        Some(index) => {
            if text.is_empty() {
                // 用户把输入框清空了 = 这条说明不要了。
                // `.bak` 里还留着上一版，和"清空某个字段"是同一档风险，不再单独留档。
                report.notes.remove(index);
            } else {
                report.notes[index].text = text;
            }
        }
        None => {
            if !text.is_empty() {
                report.notes.push(DailyNote { key, text });
            }
        }
    }
    report.notes.sort_by(|a, b| a.key.cmp(&b.key));
    report.date = day.clone();
    report.updated_at = now_iso();

    std::fs::create_dir_all(dir(store)).map_err(|e| format!("创建 dailies 目录失败：{e}"))?;
    atomic::atomic_write_json(&path_for(store, &day)?, &report)?;

    // 顺手清掉满一年的（**但刚写的这一天不碰** —— 万一他补写一年前的旧账，不能转身就删掉）
    prune_inner(store, Some(day.as_str()))?;
    Ok(report)
}

/// ⚠️ 只给内部用（`set_note` 走它、带上"刚写的那天别删"）——
/// 原来有一个对外的 `pub fn prune` 壳子，但它只有测试在调，`cargo run` 会报 `never used`，已删。
fn prune_inner(store: &Store, keep: Option<&str>) -> Result<usize, String> {
    let root = dir(store);
    if !root.is_dir() {
        return Ok(0);
    }
    let cutoff = Local::now().date_naive() - Duration::days(KEEP_DAYS);

    let mut old: Vec<(PathBuf, String, String)> = Vec::new(); // (路径, 文件名, 原文)
    for entry in std::fs::read_dir(&root).map_err(|e| format!("读 dailies 目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读 dailies 目录项失败：{e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // ⚠️ 先把文件名**取成自己的 String**：`path` 等下要被 move 进 `old`，
        //    还借着一个 `&str` 的话编译器不让过（E0505）。
        let Some(name) = path
            .file_name()
            .and_then(|one| one.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        // 只认 `YYYY-MM-DD.json`；`.bak` 与导出出来的 `.txt` 一律跳过
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        let Ok(date) = NaiveDate::parse_from_str(stem, "%Y-%m-%d") else {
            continue;
        };
        if date >= cutoff {
            continue;
        }
        if keep == Some(stem) {
            continue;
        }
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        old.push((path, name, raw));
    }
    if old.is_empty() {
        return Ok(0);
    }

    // ⚠️ 先留档再删；留档失败会 Err → 调用方直接返回，一个字节都不动
    let files: Vec<(String, String)> = old
        .iter()
        .map(|(_, name, raw)| (name.clone(), raw.clone()))
        .collect();
    let suffix = format!("{}份", files.len());
    safety::archive_many(store, "日报-满一年清理前", &suffix, "日报-满一年清理前", files)?;

    let mut removed = 0;
    for (path, _, _) in &old {
        std::fs::remove_file(path).map_err(|e| format!("删旧日报失败：{e}"))?;
        let bak = atomic::bak_path(path);
        if bak.exists() {
            let _ = std::fs::remove_file(bak);
        }
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn 写完能读回来() {
        let store = temp_store("dailies-roundtrip");
        let empty = load(&store, "2026-09-26").unwrap();
        assert_eq!(empty.date, "2026-09-26");
        assert!(empty.notes.is_empty(), "没写过就是空的，不用报错");

        let saved = set_note(&store, "2026-09-26", "todo:abc", "  今天没空，明天补  ").unwrap();
        assert_eq!(saved.notes.len(), 1);
        assert_eq!(saved.notes[0].text, "今天没空，明天补", "首尾空白要去掉");
        assert!(!saved.updated_at.is_empty());

        let back = load(&store, "2026-09-26").unwrap();
        assert_eq!(back.notes.len(), 1);
        assert_eq!(back.notes[0].key, "todo:abc");
        assert_eq!(back.notes[0].text, "今天没空，明天补");
    }

    #[test]
    fn 改一条不动别人_清空等于删掉那一条() {
        let store = temp_store("dailies-edit");
        set_note(&store, "2026-09-26", "todo:a", "第一条").unwrap();
        set_note(&store, "2026-09-26", "todo:b", "第二条").unwrap();
        let two = set_note(&store, "2026-09-26", "todo:a", "第一条改过").unwrap();
        assert_eq!(two.notes.len(), 2, "改一条不能把另一条冲掉");
        assert_eq!(
            two.notes.iter().find(|one| one.key == "todo:a").unwrap().text,
            "第一条改过"
        );

        let one = set_note(&store, "2026-09-26", "todo:a", "   ").unwrap();
        assert_eq!(one.notes.len(), 1, "空文字 = 删掉这一条");
        assert_eq!(one.notes[0].key, "todo:b");
    }

    #[test]
    fn 日期会被归一化_且非法日期挡得住() {
        let store = temp_store("dailies-date");
        let report = set_note(&store, "2026-9-6", "day", "小结").unwrap();
        assert_eq!(report.date, "2026-09-06", "单位数月份也要写成两位");
        assert!(dir(&store).join("2026-09-06.json").exists());

        // ⚠️ 这几条是**路径穿越的闸门**：过不去就对了
        for bad in ["../../config", "2026-13-01", "2026-02-30", "今天", ""] {
            assert!(
                there_is_no_file(&store, bad),
                "非法日期必须被挡住：{bad:?}"
            );
        }
    }

    fn there_is_no_file(store: &Store, date: &str) -> bool {
        load(store, date).is_err() && set_note(store, date, "day", "x").is_err()
    }

    #[test]
    fn 满一年的会清掉_最近的不动_而且清之前先留档() {
        let store = temp_store("dailies-prune");
        let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let old = "2020-01-01";
        std::fs::create_dir_all(dir(&store)).unwrap();
        for (date, text) in [(old, "很久以前的日报"), (today.as_str(), "今天的日报")] {
            atomic::atomic_write_json(
                &path_for(&store, date).unwrap(),
                &DailyReport {
                    date: date.to_string(),
                    updated_at: now_iso(),
                    notes: vec![DailyNote {
                        key: "day".into(),
                        text: text.into(),
                    }],
                },
            )
            .unwrap();
        }

        // ⚠️ 调的是 `prune_inner`：原来对外暴露了一个 `pub fn prune`，但它**只有测试在用** ——
        //    `cargo test --lib` 看不出来（测试算"用过"），`cargo run` 立刻报 `never used`。
        //    照项目规矩（别用 #[allow(dead_code)] 糊）直接把那个壳删了。
        let removed = prune_inner(&store, None).unwrap();
        assert_eq!(removed, 1, "只该清掉满一年的那一份");
        assert!(!path_for(&store, old).unwrap().exists(), "老的要被清掉");
        assert!(path_for(&store, &today).unwrap().exists(), "今天的不能动");

        let archives: Vec<_> = std::fs::read_dir(store.data_dir().join("backups"))
            .unwrap()
            .filter_map(|one| one.ok())
            .map(|one| one.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("日报-满一年清理前"))
            .collect();
        assert_eq!(archives.len(), 1, "真删之前必须留档：{archives:?}");
    }

    #[test]
    fn 补写旧日期的说明不会被顺手删掉() {
        let store = temp_store("dailies-keep-just-written");
        let long_ago = "2020-05-05";
        let saved = set_note(&store, long_ago, "day", "补写的旧账").unwrap();
        assert_eq!(saved.notes.len(), 1);
        assert!(
            path_for(&store, long_ago).unwrap().exists(),
            "★ 刚写进去的那一天不能被 prune 顺手删掉"
        );
    }
}
