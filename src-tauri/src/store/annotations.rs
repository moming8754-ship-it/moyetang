//! 批注（M14-B · 2026-09-26）
//!
//! # 这个模块负责什么
//! 读写 `<数据目录>/annotations.json`，**只做原子写**（`store::atomic`）。
//! 命令全是**操作式**的：读盘拿最新 → 只改这一处 → 原子写回 —— 和 `mottos` / `awards` 一个套路。
//!
//! # 锚点为什么长这样（**别改成存行号**）
//! 批注指向的是"正文里的哪一句"。存行号的话，用户在**前面**随便加一行，后面所有批注
//! 一起错位（而且错得看不出错）；存字符偏移也一样，改一个字就整体漂移。
//! 所以这里存三样东西，配合起来定位：
//! - `hash`：**快路径** —— 句子内容没改过就直接命中，不用在正文里找；
//! - `quote`：那句原文的**快照**（照原样存，界面上"引的那一句"就显示它）；
//! - `prefix` / `suffix`：原句前后各 12 字 —— **慢路径**用它在正文里重新找位置
//!   （改了别处的字，这一句多半还得在原处附近）。
//!
//! ⚠️ **锚点是算出来的，不是改出来的**：所以 [`set`] 只改正文，`quote` / `prefix` /
//! `suffix` / `hash` / `noteId` 一个都不许动（前端也没法传）。
//!
//! # 两条要记住的
//! 1. 🔴 **新增数据文件，已经在两处登记**：`store/backup.rs` 的 `ENTRIES`（导出备份要带上）
//!    与 `store/mod.rs` 的 `DATA_ENTRIES`（换数据目录要带上）。**漏一个就出事。**
//! 2. 排序放前端：`list` **原样返回文件顺序**，不在这里排。

use serde::Deserialize;
use std::path::PathBuf;
use uuid::Uuid;

use crate::models::{now_iso, Annotation, AnnotationFile};
use crate::store::{atomic, safety, Store};

/// 改一条批注时要动的字段。
///
/// ⚠️ **只有正文**：锚点（`quote` / `prefix` / `suffix` / `hash`）与 `noteId` 是算出来的，
/// 谁调用都不许改 —— 前端也压根传不进来。`None` = 不传就不动。
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AnnotationPatch {
    pub text: Option<String>,
}

/// `<数据目录>/annotations.json`
fn path(store: &Store) -> PathBuf {
    store.data_dir().join("annotations.json")
}

pub fn load(store: &Store) -> Result<AnnotationFile, String> {
    Ok(atomic::read_json::<AnnotationFile>(&path(store))?.unwrap_or_default())
}

pub fn save(store: &Store, file: &AnnotationFile) -> Result<(), String> {
    atomic::atomic_write_json(&path(store), file)
}

/// 全部批注（**原样按文件顺序** = 加入顺序；怎么摆、按哪篇筛是界面的事）
pub fn list(store: &Store) -> Result<Vec<Annotation>, String> {
    Ok(load(store)?.items)
}

/// 新建一条批注。
///
/// `id` / `createdAt` 由**后端生成**（前端不许自己造，免得闹出重复 id）。
/// `quote`（引的那句原文）与 `text`（批注正文）都**不能是空的** ——
/// 没引文的批注不知道在说哪儿，没正文的批注等于没写。
///
/// ⚠️ `prefix` / `suffix` / `hash` **原样存、不 trim**：它们是锚点的一部分，
/// 首尾那点空白可能就是定位要用的（trim 掉反而找不着位置）。
pub fn create(
    store: &Store,
    note_id: String,
    quote: String,
    prefix: String,
    suffix: String,
    hash: String,
    text: String,
) -> Result<Annotation, String> {
    if quote.trim().is_empty() {
        return Err("批注得先引一句原文".to_string());
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("批注总得写点什么".to_string());
    }
    let mut file = load(store)?;
    let one = Annotation {
        id: Uuid::new_v4().to_string(),
        note_id,
        quote,
        prefix,
        suffix,
        hash,
        text,
        created_at: now_iso(),
    };
    file.items.push(one.clone());
    save(store, &file)?;
    Ok(one)
}

/// 改一条（操作式：只改传进来的字段）。
///
/// ⚠️ **`text` 传空串直接拒绝**：批注不能没有正文 —— 想删就用 [`delete`]，
/// 别留一条空壳在文件里（那正是"看不见的垃圾数据"）。
pub fn set(store: &Store, id: &str, patch: AnnotationPatch) -> Result<Annotation, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的那条批注不存在：{id}"))?;

    if let Some(text) = patch.text {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("批注总得写点什么（要删就删掉这条）".to_string());
        }
        item.text = text;
    }

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
        .ok_or_else(|| format!("要删的那条批注不存在：{id}"))?;
    let gone = file.items[at].clone();
    let raw = serde_json::to_string_pretty(&gone).map_err(|e| format!("序列化失败：{e}"))?;
    safety::archive(store, "批注-删除前", "", &raw)?;
    file.items.remove(at);
    save(store, &file)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    /// 造一条像模像样的批注（引文 / 前后文 / 哈希都齐）
    fn seed(store: &Store, note_id: &str, quote: &str, text: &str) -> Annotation {
        create(
            store,
            note_id.to_string(),
            quote.to_string(),
            "前前前前前前前前前前前前".to_string(),
            "后后后后后后后后后后后后".to_string(),
            "hash-abc".to_string(),
            text.to_string(),
        )
        .unwrap()
    }

    #[test]
    fn 建一条就能读回来_字段齐() {
        let store = temp_store("anno-create");
        assert!(list(&store).unwrap().is_empty(), "没写过就是空的");

        let one = seed(&store, "note-1", "  那句原文  ", "  这里是我的批注  ");
        assert_eq!(one.note_id, "note-1");
        assert_eq!(one.quote, "  那句原文  ", "引文照原样存（前后空白也是锚点的一部分）");
        assert_eq!(one.prefix, "前前前前前前前前前前前前");
        assert_eq!(one.suffix, "后后后后后后后后后后后后");
        assert_eq!(one.hash, "hash-abc");
        assert_eq!(one.text, "这里是我的批注", "正文去首尾空白");

        let back = list(&store).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0], one, "读回来跟建的那条一模一样");

        // 空的不收：没让引原文 / 没写正文
        assert!(
            create(&store, "note-1".into(), "   ".into(), "p".into(), "s".into(), "h".into(), "有正文".into())
                .is_err(),
            "没引原文不收"
        );
        assert!(
            create(&store, "note-1".into(), "某句".into(), "p".into(), "s".into(), "h".into(), "   ".into())
                .is_err(),
            "没正文不收"
        );
        assert_eq!(list(&store).unwrap().len(), 1, "被拒的不许留在文件里");
    }

    #[test]
    fn id_和_created_at_是后端生成的() {
        let store = temp_store("anno-ids");
        let one = seed(&store, "note-1", "甲", "批注甲");
        let two = seed(&store, "note-1", "乙", "批注乙");

        assert!(!one.id.is_empty(), "id 得由后端发");
        assert_ne!(one.id, two.id, "两条批注不能撞 id");
        assert!(Uuid::parse_str(&one.id).is_ok(), "id 该是个 uuid：{}", one.id);
        assert!(!one.created_at.is_empty(), "createdAt 得由后端盖章");
        assert!(one.created_at.contains('T'), "时间是 ISO：{}", one.created_at);
        assert!(Uuid::parse_str(&two.id).is_ok());
        assert!(!two.created_at.is_empty(), "★ 每条都自己盖一次时间，不是共用一个");
    }

    #[test]
    fn set_只改传进来的字段_别的字段一个不动() {
        let store = temp_store("anno-set");
        let one = seed(&store, "note-1", "那句原文", "旧的批注");

        let mut patch = AnnotationPatch::default();
        patch.text = Some("  新的批注  ".into());
        let two = set(&store, &one.id, patch).unwrap();
        assert_eq!(two.text, "新的批注", "正文去首尾空白");
        assert_eq!(two.id, one.id, "★ id 不动");
        assert_eq!(two.note_id, "note-1", "★ noteId 不动（锚点算出来的）");
        assert_eq!(two.quote, "那句原文", "★ 引文不动");
        assert_eq!(two.prefix, one.prefix, "★ 前文不动");
        assert_eq!(two.suffix, one.suffix, "★ 后文不动");
        assert_eq!(two.hash, one.hash, "★ 哈希不动");
        assert_eq!(two.created_at, one.created_at, "★ 建的时间不动");

        // 不传 = 不动（也不报错）
        let same = set(&store, &one.id, AnnotationPatch::default()).unwrap();
        assert_eq!(same, two, "什么都没传就什么都不动");
        assert_eq!(list(&store).unwrap()[0], two, "改动确实落了盘");

        assert!(set(&store, "不存在的 id", AnnotationPatch::default()).is_err());
    }

    #[test]
    fn 删一条_先留档_别的条不动() {
        let store = temp_store("anno-delete");
        let one = seed(&store, "note-1", "要删的那句", "要删的批注");
        let keep = seed(&store, "note-1", "留着的那句", "留着的批注");

        delete(&store, &one.id).unwrap();
        let left = list(&store).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, keep.id, "★ 只删了指定的那条");

        let archives: Vec<String> = std::fs::read_dir(store.data_dir().join("backups"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("批注-删除前"))
            .collect();
        assert_eq!(archives.len(), 1, "真删之前必须留档：{archives:?}");

        // 留档里存的是那条批注的**原文**（想回滚就照它抄回去）
        let raw = std::fs::read_to_string(store.data_dir().join("backups").join(&archives[0])).unwrap();
        assert!(raw.contains("要删的批注"), "留档里得有被删的那条：{raw}");
        assert!(!raw.contains("留着的批注"), "★ 不该把没删的那条也写进去");

        assert!(delete(&store, "不存在的 id").is_err(), "删不存在的要给个明白话");
    }

    #[test]
    fn 旧文件缺字段也能读_正文空串被拒绝() {
        let store = temp_store("anno-legacy");
        // 手写一份"早期版本"：只有 id / noteId / quote / text，没有锚点那几样
        let raw = r#"{"items":[{"id":"old-1","noteId":"n1","quote":"老引文","text":"老批注"}]}"#;
        std::fs::write(path(&store), raw).unwrap();

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].quote, "老引文");
        assert_eq!(items[0].text, "老批注");
        assert!(items[0].prefix.is_empty(), "缺的字段走默认");
        assert!(items[0].suffix.is_empty());
        assert!(items[0].hash.is_empty());
        assert!(items[0].created_at.is_empty());

        // 缺字段的老数据照样能改（只改正文）
        let mut patch = AnnotationPatch::default();
        patch.text = Some("改成新的".into());
        assert_eq!(set(&store, "old-1", patch).unwrap().text, "改成新的");

        // ⚠️ 正文空串**直接拒绝**：批注不能没有正文（要删就 delete）
        for empty in ["", "   ", "\n\t "] {
            let mut patch = AnnotationPatch::default();
            patch.text = Some(empty.to_string());
            assert!(set(&store, "old-1", patch).is_err(), "空正文要拒绝：{empty:?}");
        }
        assert_eq!(list(&store).unwrap()[0].text, "改成新的", "★ 被拒的改动不许落盘");

        // 建的时候也一样
        assert!(
            create(&store, "n1".into(), "某句".into(), String::new(), String::new(), String::new(), String::new())
                .is_err(),
            "建的时候正文也不能空"
        );
    }
}
