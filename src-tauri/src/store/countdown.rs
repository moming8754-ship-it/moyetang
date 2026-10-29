//! 倒计时（2026-10-04 · V2 打磨「倒计时」批）
//!
//! # 这是什么
//! 一个目标日 + 一句话（「期末考 · 2026-11-20」），界面显示「还有 N 天」。
//! 用户脑图第 6 条里叫"日课（未来的倒数计时）"，但他 2026-10-04 定名**「倒计时」**。
//!
//! # 三条规矩
//! 1. 🔴 **新增数据文件在两处登记**：`store/backup.rs` 的 `ENTRIES`（导出备份要带上）+
//!    `store/mod.rs` 的 `DATA_ENTRIES`（换数据目录要带上）。**漏一个就出事**（M11/M12 都踩过）。
//! 2. **只存到"天"**（`YYYY-MM-DD`）：倒计时问的是"离那天还有几天"，
//!    存时刻会长出"还有 0 天但已经过了"这种怪状态。日期在这里**校验**（`NaiveDate`），
//!    校验不过就拒 —— 免得界面拿一个烂日期去算天数。
//! 3. 命令**操作式 + 广播 `data-changed`**：日程页（月视图）和**桌面挂件**是两个窗口，
//!    挂件靠 `data-changed` 才能跟着更新（跟 mottos/awards 那种"只在一个页面显示"的不一样）。

use chrono::NaiveDate;
use serde::Deserialize;
use std::path::PathBuf;
use uuid::Uuid;

use crate::models::{Countdown, CountdownFile};
use crate::store::{atomic, safety, Store};

/// 改一条时要动的字段：`None` = **不传就不动**；要清掉用**空串**。
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CountdownPatch {
    pub title: Option<String>,
    pub date: Option<String>,
    pub note: Option<String>,
    pub on_widget: Option<bool>,
}

/// `<数据目录>/countdowns.json`
fn path(store: &Store) -> PathBuf {
    store.data_dir().join("countdowns.json")
}

pub fn load(store: &Store) -> Result<CountdownFile, String> {
    Ok(atomic::read_json::<CountdownFile>(&path(store))?.unwrap_or_default())
}

pub fn save(store: &Store, file: &CountdownFile) -> Result<(), String> {
    atomic::atomic_write_json(&path(store), file)
}

/// 全部（**原样按文件顺序**；"按日期从近到远"是界面的事）
pub fn list(store: &Store) -> Result<Vec<Countdown>, String> {
    Ok(load(store)?.items)
}

/// 标题：去掉首尾空白、最多 24 字；空的拒收
fn clean_title(raw: &str) -> Result<String, String> {
    let title = raw.trim();
    if title.is_empty() {
        return Err("总得写一件事吧".to_string());
    }
    Ok(title.chars().take(24).collect())
}

/// 目标日：必须是 `YYYY-MM-DD`，而且**得是个真日子**（2 月 30 号这种要拒）
fn clean_date(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .map_err(|_| format!("目标日要写成 2026-11-20 这样：{text}"))?;
    Ok(text.to_string())
}

/// 新建一条
pub fn create(
    store: &Store,
    title: String,
    date: String,
    note: Option<String>,
) -> Result<Countdown, String> {
    let title = clean_title(&title)?;
    let date = clean_date(&date)?;
    let mut file = load(store)?;
    let one = Countdown {
        id: Uuid::new_v4().to_string(),
        title,
        date,
        note: note.unwrap_or_default().trim().to_string(),
        on_widget: true,
        updated_at: crate::models::now_iso(),
    };
    file.items.push(one.clone());
    save(store, &file)?;
    Ok(one)
}

/// 改一条（操作式：只改传进来的字段）
pub fn set(store: &Store, id: &str, patch: CountdownPatch) -> Result<Countdown, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的那条倒计时不存在：{id}"))?;

    if let Some(title) = patch.title {
        item.title = clean_title(&title)?;
    }
    if let Some(date) = patch.date {
        item.date = clean_date(&date)?;
    }
    if let Some(note) = patch.note {
        item.note = note.trim().to_string();
    }
    if let Some(on_widget) = patch.on_widget {
        item.on_widget = on_widget;
    }
    item.updated_at = crate::models::now_iso();

    let done = item.clone();
    save(store, &file)?;
    Ok(done)
}

/// 删一条（**真删**）：照 V1 的规矩**先留档再删**（`safety`），留档失败就中止
pub fn delete(store: &Store, id: &str) -> Result<bool, String> {
    let mut file = load(store)?;
    let at = file
        .items
        .iter()
        .position(|one| one.id == id)
        .ok_or_else(|| format!("要删的那条倒计时不存在：{id}"))?;
    let gone = file.items[at].clone();
    let raw = serde_json::to_string_pretty(&gone).map_err(|e| format!("序列化失败：{e}"))?;
    safety::archive(store, "倒计时-删除前", "", &raw)?;
    file.items.remove(at);
    save(store, &file)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn 建一条倒计时_默认上挂件() {
        let store = temp_store("countdown-create");
        assert!(list(&store).unwrap().is_empty(), "没写过就是空的");

        let one = create(&store, "  期末考  ".into(), "2026-11-20".into(), None).unwrap();
        assert_eq!(one.title, "期末考", "首尾空白要去掉");
        assert_eq!(one.date, "2026-11-20");
        assert!(one.on_widget, "新写的默认要显示在挂件上");
        assert!(one.note.is_empty());
        assert!(!one.id.is_empty());
        assert_eq!(list(&store).unwrap().len(), 1, "真的落盘了");
    }

    #[test]
    fn 空标题和烂日期都要拒() {
        let store = temp_store("countdown-bad");
        assert!(create(&store, "   ".into(), "2026-11-20".into(), None).is_err(), "空标题不收");
        assert!(create(&store, "期末考".into(), "2026/11/20".into(), None).is_err(), "斜杠写法拒收");
        assert!(create(&store, "期末考".into(), "2026-02-30".into(), None).is_err(), "2 月 30 号不是真日子");
        assert!(create(&store, "期末考".into(), "".into(), None).is_err(), "空日期拒收");
        assert!(list(&store).unwrap().is_empty(), "拒掉的一条都没落盘");
    }

    #[test]
    fn 标题最多二十四字() {
        let store = temp_store("countdown-title");
        let long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十".to_string();
        let one = create(&store, long, "2026-11-20".into(), None).unwrap();
        assert_eq!(one.title.chars().count(), 24);
    }

    #[test]
    fn 改一条只动传进来的字段() {
        let store = temp_store("countdown-set");
        let one = create(&store, "期末考".into(), "2026-11-20".into(), Some("十二月那门".into())).unwrap();

        let moved = set(
            &store,
            &one.id,
            CountdownPatch {
                date: Some("2026-11-21".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(moved.date, "2026-11-21", "日期改了");
        assert_eq!(moved.title, "期末考", "标题一个字都没动");
        assert_eq!(moved.note, "十二月那门", "备注也没动");

        let hidden = set(
            &store,
            &one.id,
            CountdownPatch {
                on_widget: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!hidden.on_widget);
    }

    #[test]
    fn 删一条是真删_而且删不存在的要报错() {
        let store = temp_store("countdown-delete");
        let one = create(&store, "期末考".into(), "2026-11-20".into(), None).unwrap();
        assert!(delete(&store, &one.id).unwrap());
        assert!(list(&store).unwrap().is_empty());
        assert!(delete(&store, &one.id).is_err(), "再删一次要报错");
    }

    #[test]
    fn 老文件里缺字段也照读() {
        // 以后加字段时的兜底：缺 `onWidget` 要走 `Default`（= true），别读崩
        let store = temp_store("countdown-old");
        let old = r#"{"items":[{"id":"old-1","title":"老倒计时","date":"2026-12-01"}]}"#;
        crate::store::atomic::atomic_write_str(&path(&store), old).unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "老倒计时");
        assert!(items[0].on_widget, "缺 onWidget 时默认是 true");
        assert!(items[0].note.is_empty());
    }
}
