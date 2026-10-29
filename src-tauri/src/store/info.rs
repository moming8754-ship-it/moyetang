//! 信息区读写（`info.jsonl`，**每行一条 JSON**）。
//!
//! 为什么"整文件重写"而不是 `OpenOptions::append`：
//! - 追加没有原子性，断电会留下半行，整个文件后面的行都读不出来；
//! - 追加也留不下"上一版"，而用户最在意数据不能丢。
//! 信息条目量级很小，整体重写的开销可以忽略，换来的是每次写入都有 `.bak`。
//!
//! 读的时候**坏行会报错并给出行号**，不会静默跳过：静默跳过后一旦再保存，
//! 那行数据就真的没了。

use crate::models::{now_iso, Info, InfoKind, InfoStatus};
use crate::store::atomic;
use crate::store::Store;
use std::path::{Path, PathBuf};

/// 信息文件名
pub const INFO_FILE: &str = "info.jsonl";

/// `<数据目录>/info.jsonl`
pub fn info_path(store: &Store) -> PathBuf {
    store.data_dir().join(INFO_FILE)
}

/// 按**文件顺序**读全部（不排序；内部用）
pub fn read_all(store: &Store) -> Result<Vec<Info>, String> {
    let path = info_path(store);
    let text = atomic::read_to_string(&path).map_err(|e| e.to_string())?;
    match text {
        Some(text) => parse_lines(&text, &path),
        // 文件还不存在（第一次用）→ 空列表，不是错误
        None => Ok(Vec::new()),
    }
}

/// 逐行解析；空行跳过，坏行报错（带行号）
fn parse_lines(text: &str, path: &Path) -> Result<Vec<Info>, String> {
    let mut items = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let info: Info = serde_json::from_str(line)
            .map_err(|e| format!("{} 第 {} 行解析失败：{e}", path.display(), idx + 1))?;
        items.push(info);
    }
    Ok(items)
}

/// 整体重写（原子写；上一版自动留成 `info.jsonl.bak`）
///
/// ⚠️ `pub(crate)` 而不是私有：M15 的档案库「归档 = 从原位拿走」要借它把某条 info **从
/// `info.jsonl` 里抹掉**（`store/archive.rs`）。除那条路之外别在模块外调用 ——
/// `info.jsonl` 的行格式（一行一条、不 pretty）由这里独家负责，别在别处拼这个字符串。
pub(crate) fn write_all(store: &Store, items: &[Info]) -> Result<(), String> {
    let mut text = String::new();
    for info in items {
        // 一行一条：这里**不能**用 pretty，绝不能带换行
        let line = serde_json::to_string(info).map_err(|e| format!("序列化信息失败：{e}"))?;
        text.push_str(&line);
        text.push('\n');
    }
    atomic::atomic_write_str(&info_path(store), &text).map_err(|e| e.to_string())
}

/// 列表：**新的在前**。
///
/// 按 `createdAt` 倒序；时间完全相同时，文件里靠后的（更晚写入的）排前面，
/// 这样"刚存的那条一定在最上面"，不依赖毫秒是否撞车。
pub fn list(store: &Store) -> Result<Vec<Info>, String> {
    let mut indexed: Vec<(usize, Info)> = read_all(store)?.into_iter().enumerate().collect();
    indexed.sort_by(|(ia, a), (ib, b)| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| ib.cmp(ia))
    });
    Ok(indexed.into_iter().map(|(_, info)| info).collect())
}

/// 按 id 取一条
// M2 的联动（info_link）会先用它确认目标存在
#[allow(dead_code)]
pub fn get(store: &Store, id: &str) -> Result<Option<Info>, String> {
    Ok(read_all(store)?.into_iter().find(|info| info.id == id))
}

/// 新建一条信息（`createdAt` 由后端盖章，前端不用传）
pub fn create(
    store: &Store,
    kind: InfoKind,
    text: String,
    categories: Vec<String>,
    asset_path: Option<String>,
) -> Result<Info, String> {
    let text = text.trim().to_string();
    if kind == InfoKind::Text && text.is_empty() {
        return Err("内容不能为空".to_string());
    }

    let info = Info {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        text,
        asset_path,
        created_at: now_iso(),
        updated_at: now_iso(),
        categories,
        status: InfoStatus::Pending,
        links: Vec::new(),
    };

    let mut items = read_all(store)?;
    items.push(info.clone());
    write_all(store, &items)?;
    Ok(info)
}

/// 更新一条信息（按 id 整条替换；找不到就报错，不要悄悄新增）
pub fn update(store: &Store, info: Info) -> Result<Info, String> {
    if info.id.trim().is_empty() {
        return Err("缺少 id，无法更新".to_string());
    }
    if info.kind == InfoKind::Text && info.text.trim().is_empty() {
        return Err("内容不能为空".to_string());
    }

    let mut items = read_all(store)?;
    let idx = items
        .iter()
        .position(|old| old.id == info.id)
        .ok_or_else(|| format!("要更新的信息不存在：{}", info.id))?;

    let mut merged = info;
    // 创建时间不允许被改掉；前端忘了带就沿用原值
    if merged.created_at.trim().is_empty() {
        merged.created_at = items[idx].created_at.clone();
    }
    merged.updated_at = now_iso();
    items[idx] = merged.clone();
    write_all(store, &items)?;
    Ok(merged)
}

/// 删除一条信息。返回是否真的删到了（`false` = 本来就没有）
///
/// ⚠️ 和待办一样：删之前先把 `info.jsonl` **原样留一份**到 `backups/`。
/// 用户拍板 C2 时定的调子是"其他区不搞回收站，但都得有二次确认" ——
/// 二次确认挡的是"手滑"，挡不了"确认完就后悔"，所以留档这件事不能省。
/// （`.bak` 只留得住上一版，后面随便再写一次就把它盖掉了。）
pub fn delete(store: &Store, id: &str) -> Result<bool, String> {
    let raw = atomic::read_to_string(&info_path(store))
        .map_err(|e| format!("读 info.jsonl 失败：{e}"))?
        .unwrap_or_default();
    let mut items = read_all(store)?;
    let before = items.len();
    items.retain(|info| info.id != id);
    if items.len() == before {
        return Ok(false);
    }
    crate::store::safety::archive(store, "info-删除前", "", &raw)?;
    write_all(store, &items)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!(
            "moyetang-info-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).expect("建测试目录");
        Store::at(dir)
    }

    fn create_text(store: &Store, text: &str) -> Info {
        create(store, InfoKind::Text, text.to_string(), Vec::new(), None).expect("新建")
    }

    #[test]
    fn 新建后能读回来并且新的在前() {
        let store = temp_store();
        create_text(&store, "第一条");
        create_text(&store, "第二条");
        create_text(&store, "第三条");

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].text, "第三条", "新的必须在最前面");
        assert_eq!(items[2].text, "第一条");
        assert_eq!(items[0].status, InfoStatus::Pending);
        assert_eq!(items[0].kind, InfoKind::Text);
        assert!(!items[0].created_at.is_empty(), "createdAt 由后端盖章");
    }

    #[test]
    fn 空内容不许存() {
        let store = temp_store();
        let err = create(&store, InfoKind::Text, "   ".into(), Vec::new(), None).unwrap_err();
        assert!(err.contains("不能为空"), "实际：{err}");
        assert!(list(&store).unwrap().is_empty());
    }

    #[test]
    fn 更新按_id_替换且不动创建时间() {
        let store = temp_store();
        let mut info = create_text(&store, "原文");
        let created = info.created_at.clone();

        info.text = "改过".into();
        info.categories = vec!["主动冒出".into()];
        let updated = update(&store, info).unwrap();
        assert_eq!(updated.created_at, created, "创建时间不能被改");

        let back = get(&store, &updated.id).unwrap().unwrap();
        assert_eq!(back.text, "改过");
        assert_eq!(back.categories, vec!["主动冒出".to_string()]);
        assert_eq!(list(&store).unwrap().len(), 1, "更新不该新增条目");
    }

    #[test]
    fn 更新不存在的_id_报错() {
        let store = temp_store();
        let ghost = Info {
            id: "不存在".into(),
            kind: InfoKind::Text,
            text: "x".into(),
            asset_path: None,
            created_at: String::new(),
            updated_at: String::new(),
            categories: Vec::new(),
            status: InfoStatus::Pending,
            links: Vec::new(),
        };
        assert!(update(&store, ghost).is_err());
    }

    #[test]
    fn 删除只删指定那条并留_bak() {
        let store = temp_store();
        let a = create_text(&store, "要删的");
        let b = create_text(&store, "留下的");

        // 删之前先看一眼上一版（应包含两条）
        assert!(delete(&store, &a.id).unwrap());
        assert!(!delete(&store, &a.id).unwrap(), "重复删返回 false");

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, b.id);

        let bak = atomic::read_to_string(&atomic::bak_path(&info_path(&store)))
            .unwrap()
            .unwrap();
        assert!(bak.contains("要删的"), ".bak 里应留着删除前的版本");
    }

    #[test]
    fn 坏行报错并指出行号() {
        let store = temp_store();
        create_text(&store, "好的");
        let path = info_path(&store);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{这不是合法 JSON\n");
        std::fs::write(&path, raw).unwrap();

        let err = list(&store).unwrap_err();
        assert!(err.contains("第 2 行"), "要指出行号，实际：{err}");
        // 坏文件没被顺手清掉
        assert!(std::fs::read_to_string(&path).unwrap().contains("不是合法"));
    }

    #[test]
    fn 文件不存在时是空列表不是错误() {
        let store = temp_store();
        assert!(list(&store).unwrap().is_empty());
        assert!(get(&store, "随便").unwrap().is_none());
    }
}
