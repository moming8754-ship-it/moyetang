//! 格言与原则（M12-C · 2026-09-26）
//!
//! # 这个模块负责什么
//! 读写 `<数据目录>/mottos.json`，**只做原子写**（`store::atomic`）。
//! 命令全是**操作式**的：读盘拿最新 → 只改这一处 → 原子写回 —— 和 `awards` / `todo` / `tree` 一个套路。
//!
//! # 两条要记住的
//! 1. 🔴 **新增数据文件，已经在两处登记**：`store/backup.rs` 的 `ENTRIES`（导出备份要带上）
//!    与 `store/mod.rs` 的 `DATA_ENTRIES`（换数据目录要带上）。**漏一个就出事。**
//! 2. **故意没有"置顶"** —— 用户 2026-09-26 明确说"去掉置顶功能"（格言不该排序）。
//!    排序是界面的事：按加入顺序倒着摆（最新的在最前），`list` 原样返回文件顺序。

use serde::Deserialize;
use std::path::PathBuf;
use uuid::Uuid;

use crate::models::{now_iso, Motto, MottoFile, MottoKind};
use crate::store::{atomic, safety, Store};

/// 改一条时要动的字段。`None` = **不传就不动**；"清空"用**空串**表示。
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MottoPatch {
    pub text: Option<String>,
    pub from: Option<String>,
    pub kind: Option<MottoKind>,
}

/// `<数据目录>/mottos.json`
fn path(store: &Store) -> PathBuf {
    store.data_dir().join("mottos.json")
}

pub fn load(store: &Store) -> Result<MottoFile, String> {
    Ok(atomic::read_json::<MottoFile>(&path(store))?.unwrap_or_default())
}

pub fn save(store: &Store, file: &MottoFile) -> Result<(), String> {
    atomic::atomic_write_json(&path(store), file)
}

/// 全部（**原样按文件顺序** = 加入顺序；怎么摆是界面的事）
pub fn list(store: &Store) -> Result<Vec<Motto>, String> {
    Ok(load(store)?.items)
}

/// 新建一条（**只要那句话**；出处、类别都可以以后再改）
pub fn create(store: &Store, text: String, kind: Option<MottoKind>) -> Result<Motto, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("总得写一句吧".to_string());
    }
    let mut file = load(store)?;
    let motto = Motto {
        id: Uuid::new_v4().to_string(),
        text,
        from: String::new(),
        kind: kind.unwrap_or_default(),
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    file.items.push(motto.clone());
    save(store, &file)?;
    Ok(motto)
}

/// 改一条（操作式：只改传进来的字段）
pub fn set(store: &Store, id: &str, patch: MottoPatch) -> Result<Motto, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的那条不存在：{id}"))?;

    if let Some(text) = patch.text {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("总得写一句吧".to_string());
        }
        item.text = text;
    }
    if let Some(value) = patch.from {
        item.from = value.trim().to_string();
    }
    if let Some(value) = patch.kind {
        item.kind = value;
    }
    item.updated_at = now_iso();

    let done = item.clone();
    save(store, &file)?;
    Ok(done)
}

/// 删一条（**真删**）：照 V1 的规矩**先留档再删**（`safety`），**留档失败就中止**。
pub fn delete(store: &Store, id: &str) -> Result<bool, String> {
    let mut file = load(store)?;
    let at = file
        .items
        .iter()
        .position(|one| one.id == id)
        .ok_or_else(|| format!("要删的那条不存在：{id}"))?;
    let gone = file.items[at].clone();
    let raw = serde_json::to_string_pretty(&gone).map_err(|e| format!("序列化失败：{e}"))?;
    safety::archive(store, "格言-删除前", "", &raw)?;
    file.items.remove(at);
    save(store, &file)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn 写一句就能建_空的不收() {
        let store = temp_store("mottos-create");
        assert!(list(&store).unwrap().is_empty(), "没写过就是空的");

        let one = create(&store, "  慢慢来，比较快。  ".into(), None).unwrap();
        assert_eq!(one.text, "慢慢来，比较快。", "首尾空白要去掉");
        assert_eq!(one.kind, MottoKind::Rule, "不指定就当自己的原则");
        assert!(one.from.is_empty());
        assert!(!one.created_at.is_empty());

        let two = create(&store, "凡是值得做的事，就值得慢慢做。".into(), Some(MottoKind::Motto)).unwrap();
        assert_eq!(two.kind, MottoKind::Motto);

        assert!(create(&store, "   ".into(), None).is_err(), "空句子不收");
        assert_eq!(list(&store).unwrap().len(), 2);
    }

    #[test]
    fn 改一条只动传进来的字段() {
        let store = temp_store("mottos-set");
        let one = create(&store, "先保住数据".into(), None).unwrap();

        let mut patch = MottoPatch::default();
        patch.from = Some("—— 梭罗".into());
        let two = set(&store, &one.id, patch).unwrap();
        assert_eq!(two.from, "—— 梭罗");
        assert_eq!(two.text, "先保住数据", "没传 text 就不许动它");

        // 换类别
        let mut patch = MottoPatch::default();
        patch.kind = Some(MottoKind::Motto);
        assert_eq!(set(&store, &one.id, patch).unwrap().kind, MottoKind::Motto);

        // 改句子
        let mut patch = MottoPatch::default();
        patch.text = Some("  先保住数据，再谈别的  ".into());
        assert_eq!(set(&store, &one.id, patch).unwrap().text, "先保住数据，再谈别的");

        // 清空出处
        let mut patch = MottoPatch::default();
        patch.from = Some("   ".into());
        let cleared = set(&store, &one.id, patch).unwrap();
        assert!(cleared.from.is_empty(), "空串 = 清掉");
        assert_eq!(cleared.text, "先保住数据，再谈别的", "★ 别的字段一个都没动");

        // 空句子不收
        let mut patch = MottoPatch::default();
        patch.text = Some("   ".into());
        assert!(set(&store, &one.id, patch).is_err(), "不许把它改成空的");
    }

    #[test]
    fn 删一条_先留档_别的条不动() {
        let store = temp_store("mottos-delete");
        let one = create(&store, "要删的".into(), None).unwrap();
        let keep = create(&store, "留着的".into(), None).unwrap();

        delete(&store, &one.id).unwrap();
        let left = list(&store).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, keep.id, "★ 只删了指定的那条");

        let archives: Vec<String> = std::fs::read_dir(store.data_dir().join("backups"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("格言-删除前"))
            .collect();
        assert_eq!(archives.len(), 1, "真删之前必须留档：{archives:?}");

        assert!(delete(&store, "不存在的 id").is_err(), "删不存在的要给个明白话");
    }

    #[test]
    fn 旧文件里缺字段也能读() {
        let store = temp_store("mottos-legacy");
        // 手写一份"早期版本"：只有 id / text
        let raw = r#"{"items":[{"id":"old-1","text":"老格言"}]}"#;
        std::fs::write(path(&store), raw).unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "老格言");
        assert!(items[0].from.is_empty(), "缺的字段走默认");
        assert_eq!(items[0].kind, MottoKind::Rule);
    }
}
