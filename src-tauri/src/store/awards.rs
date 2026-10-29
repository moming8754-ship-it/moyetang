//! 奖状 / 证书（M12-A · 2026-09-26）
//!
//! # 这个模块负责什么
//! 读写 `<数据目录>/awards.json`，并且**只做原子写**（`store::atomic`）。
//! 命令全是**操作式**的：读盘拿最新 → 只改这一处 → 原子写回 ——
//! 和 `todo` / `tree` 一个套路，**不做"前端把整份文件发回来覆盖"**（那会抹掉别人刚写进去的东西）。
//!
//! # 两条要记住的
//! 1. 🔴 **新增数据文件，已经在两处登记**：`store/backup.rs` 的 `ENTRIES`（导出备份要带上）
//!    与 `store/mod.rs` 的 `DATA_ENTRIES`（换数据目录要带上）。**漏一个就出事。**
//! 2. 图片不在这里存：走现成的 `assets/`（`asset_import` / `asset_write_image`），
//!    这里只记一个相对路径 `assetPath`。
//!
//! # 排序放前端
//! `list` **原样返回文件顺序**（= 加入顺序），不在这里排 —— "按年份分段 + 置顶最前"
//! 是界面自己的事（`features/skills/awards.ts`），只放在一处做。

use serde::Deserialize;
use std::path::PathBuf;
use uuid::Uuid;

use crate::models::{now_iso, Award, AwardFile};
use crate::store::{atomic, safety, Store};

/// 改一张奖状时要动的字段。
///
/// ⚠️ 和 `todo` 那边的 `TodoPatch` 一个道理：`None` = **不传就不动**；
/// 对这几个字段来说"清空"就用**空串**表示（没有 `Option<Option<T>>` 那种歧义，
/// serde 把 `null` 吃成 `None` 的坑在这儿不存在）。
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AwardPatch {
    pub title: Option<String>,
    pub issuer: Option<String>,
    pub date: Option<String>,
    pub note: Option<String>,
    pub asset_path: Option<String>,
    pub pinned: Option<bool>,
}

/// `<数据目录>/awards.json`
fn path(store: &Store) -> PathBuf {
    store.data_dir().join("awards.json")
}

pub fn load(store: &Store) -> Result<AwardFile, String> {
    Ok(atomic::read_json::<AwardFile>(&path(store))?.unwrap_or_default())
}

pub fn save(store: &Store, file: &AwardFile) -> Result<(), String> {
    atomic::atomic_write_json(&path(store), file)
}

/// 全部奖状（**原样按文件顺序**，排序交给前端）
pub fn list(store: &Store) -> Result<Vec<Award>, String> {
    Ok(load(store)?.items)
}

/// 新建一张（只要一个标题就能建 —— **没图也能建**，这是这块的"轻松上手"）
pub fn create(store: &Store, title: String) -> Result<Award, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("奖状标题不能为空".to_string());
    }
    let mut file = load(store)?;
    let now = now_iso();
    let award = Award {
        id: Uuid::new_v4().to_string(),
        title,
        issuer: String::new(),
        date: String::new(),
        note: String::new(),
        asset_path: None,
        pinned: false,
        updated_at: now.clone(),
        created_at: now,
    };
    file.items.push(award.clone());
    save(store, &file)?;
    Ok(award)
}

/// 改一张（操作式：只改传进来的字段）
pub fn set(store: &Store, id: &str, patch: AwardPatch) -> Result<Award, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的奖状不存在：{id}"))?;

    if let Some(title) = patch.title {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("奖状标题不能为空".to_string());
        }
        item.title = title;
    }
    if let Some(value) = patch.issuer {
        item.issuer = value.trim().to_string();
    }
    if let Some(value) = patch.date {
        item.date = value.trim().to_string();
    }
    if let Some(value) = patch.note {
        // 备注是多行的：只去首尾空白，**中间一个字都不动**（用户写的字，程序不替他改）
        item.note = value.trim().to_string();
    }
    if let Some(value) = patch.asset_path {
        let trimmed = value.trim().to_string();
        item.asset_path = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    if let Some(value) = patch.pinned {
        item.pinned = value;
    }
    // 🔴 2026-10-21：奖状现在**能跨端更新**了 —— 每次改都刷新 `updated_at`（同步靠它判谁新）。
    item.updated_at = now_iso();

    let done = item.clone();
    save(store, &file)?;
    Ok(done)
}

/// 删一张（**真删**）。
///
/// ⚠️ 照 V1 的规矩：**先留档再删**（`store::safety`，每族只留最近 20 份），
/// **留档失败就中止删除** —— 宁可不删也不冒丢东西的险。
/// ⚠️ 图片**不删**：`assets/` 里的原图留着（M4 那条约定：去掉引用 ≠ 删文件），
///    孤儿图由 `tools/cleanup-test-data.ps1` 那种工具另说。
pub fn delete(store: &Store, id: &str) -> Result<bool, String> {
    let mut file = load(store)?;
    let at = file
        .items
        .iter()
        .position(|one| one.id == id)
        .ok_or_else(|| format!("要删的奖状不存在：{id}"))?;
    let gone = file.items[at].clone();
    let raw = serde_json::to_string_pretty(&gone).map_err(|e| format!("序列化奖状失败：{e}"))?;
    safety::archive(store, "奖状-删除前", "", &raw)?;
    file.items.remove(at);
    save(store, &file)?;
    // 🔴 2026-10-21：奖状删除现在**跨端生效** —— 埋墓碑，否则对面下次同步会把它拉回来。
    //    ⚠️ 只在"确实删掉了"之后埋；留档失败上面已经提前返回了。
    if let Err(e) = crate::store::sync::bury(store, id, crate::store::sync_merge::KIND_AWARD) {
        eprintln!("[东方摩耶堂] 奖状删除记录没写成功（{id}）：{e}");
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    fn patch_example() -> AwardPatch {
        AwardPatch::default()
    }

    #[test]
    fn 建一张只要有标题就行() {
        let store = temp_store("awards-create");
        assert!(list(&store).unwrap().is_empty(), "没写过就是空的");

        let one = create(&store, "  蓝桥杯省赛三等奖  ".into()).unwrap();
        assert_eq!(one.title, "蓝桥杯省赛三等奖", "首尾空白要去掉");
        assert!(one.asset_path.is_none(), "★ 没图也能建");
        assert!(!one.pinned);
        assert!(!one.created_at.is_empty());

        assert_eq!(list(&store).unwrap().len(), 1);
        assert!(create(&store, "   ".into()).is_err(), "空标题不收");
    }

    #[test]
    fn 改一张只动传进来的字段() {
        let store = temp_store("awards-set");
        let one = create(&store, "六级".into()).unwrap();
        let id = one.id.clone();

        let mut patch = patch_example();
        patch.issuer = Some("教育部考试中心".into());
        patch.date = Some("2026 年 6 月".into());
        let two = set(&store, &id, patch).unwrap();
        assert_eq!(two.issuer, "教育部考试中心");
        assert_eq!(two.date, "2026 年 6 月", "日期是自由文本，随便写");
        assert_eq!(two.title, "六级", "没传 title 就不许动它");
        assert!(two.note.is_empty());

        // 清空：传空串 = 抹掉这一格；传 None = 不动
        let mut patch = patch_example();
        patch.issuer = Some("   ".into());
        let three = set(&store, &id, patch).unwrap();
        assert!(three.issuer.is_empty(), "空串 = 清掉");
        assert_eq!(three.date, "2026 年 6 月", "★ 别的字段一个都没动");

        // 图片：传路径就挂上，传空串就摘掉（**原图不删**）
        let mut patch = patch_example();
        patch.asset_path = Some("assets/x.png".into());
        assert_eq!(set(&store, &id, patch).unwrap().asset_path.as_deref(), Some("assets/x.png"));
        let mut patch = patch_example();
        patch.asset_path = Some(String::new());
        assert!(set(&store, &id, patch).unwrap().asset_path.is_none(), "空串 = 摘掉图");
    }

    #[test]
    fn 置顶与删除_删之前先留档() {
        let store = temp_store("awards-delete");
        let one = create(&store, "要删的".into()).unwrap();
        let keep = create(&store, "留着的".into()).unwrap();

        let mut patch = patch_example();
        patch.pinned = Some(true);
        assert!(set(&store, &keep.id, patch).unwrap().pinned);

        delete(&store, &one.id).unwrap();
        let left = list(&store).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, keep.id, "★ 只删了指定的那一张");

        // 留档：backups/ 里应该有一份"奖状-删除前"
        let archives: Vec<String> = std::fs::read_dir(store.data_dir().join("backups"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("奖状-删除前"))
            .collect();
        assert_eq!(archives.len(), 1, "真删之前必须留档：{archives:?}");

        assert!(delete(&store, "不存在的 id").is_err(), "删不存在的要给个明白话");
    }

    #[test]
    fn 旧文件里缺字段也能读() {
        let store = temp_store("awards-legacy");
        // 手写一份"早期版本"的文件：只有 id / title / createdAt
        let raw = r#"{"items":[{"id":"old-1","title":"老奖状","createdAt":"2026-01-01T00:00:00.000+08:00"}]}"#;
        std::fs::write(path(&store), raw).unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "老奖状");
        assert_eq!(items[0].issuer, "", "缺的字段走默认");
        assert!(!items[0].pinned);
        assert!(items[0].asset_path.is_none());
    }

    #[test]
    fn 备注里的换行一个字都不许动() {
        let store = temp_store("awards-note");
        let one = create(&store, "有备注的".into()).unwrap();
        let mut patch = patch_example();
        patch.note = Some("  第一行\n第二行\n第三行  ".into());
        let saved = set(&store, &one.id, patch).unwrap();
        assert_eq!(saved.note, "第一行\n第二行\n第三行", "只去首尾空白，中间原样");
        // 读回来也得一样
        let back = list(&store).unwrap().remove(0);
        assert_eq!(back.note, "第一行\n第二行\n第三行");
    }
}

#[cfg(test)]
mod award_sync_tests {
    use super::*;
    use crate::store::sync;
    use crate::store::sync_merge::KIND_AWARD;
    use crate::store::temp_store;

    fn patch() -> AwardPatch {
        AwardPatch { note: Some("新的寄语".into()), ..Default::default() }
    }

    #[test]
    fn 改奖状会刷新_updated_at() {
        let store = temp_store("awards-updated-at");
        let one = create(&store, "同步测试".into()).unwrap();
        assert!(!one.updated_at.is_empty(), "新建就该带上 updated_at");
        let before = one.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let saved = set(&store, &one.id, patch()).unwrap();
        assert!(saved.updated_at > before, "改过之后时间必须往后走");
    }

    #[test]
    fn 删奖状会埋墓碑() {
        let store = temp_store("awards-grave");
        let one = create(&store, "要删的".into()).unwrap();
        assert!(delete(&store, &one.id).unwrap());
        let graves = sync::list(&store).unwrap();
        assert!(graves.iter().any(|g| g.id == one.id && g.kind == KIND_AWARD), "删除必须埋墓碑");
    }
}