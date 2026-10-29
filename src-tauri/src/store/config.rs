//! 设置读写（`config.json`）。
//!
//! 两条约定：
//! 1. 全量配置写在**当前数据目录**的 `config.json`；
//! 2. `dataDir` 额外记一份到**默认目录** `D:\东方摩耶堂\config.json`，
//!    下次启动靠它定位数据目录（`store::Store::locate`）。改目录后两处都要写。
//!
//! 读写一律走 [`crate::store::atomic`]，不直接 `fs::write`。

use crate::models::Config;
use crate::store::atomic;
use crate::store::{default_data_dir, Store, CONFIG_FILE};
use std::path::{Path, PathBuf};

/// 数据目录下的 `config.json`
pub fn config_path(store: &Store) -> PathBuf {
    store.data_dir().join(CONFIG_FILE)
}

/// 默认目录下的 `config.json`（只用来记 `dataDir`，供下次启动定位）
pub fn default_config_path() -> PathBuf {
    default_data_dir().join(CONFIG_FILE)
}

/// 读设置：文件不存在 / 空文件 → 默认值。
///
/// ⚠️ 文件存在但解析失败会返回 **Err**（不静默当默认值，也不动坏文件）——
/// 否则用户下次一保存就把坏文件覆盖掉，等于悄悄丢设置。前端收到错误应弹 Toast。
pub fn load(store: &Store) -> Result<Config, String> {
    let mut cfg: Config = atomic::read_json(&config_path(store))?.unwrap_or_default();
    // dataDir 以 Store 实际用的目录为准，避免文件里写的是旧值
    cfg.data_dir = store.data_dir().to_string_lossy().to_string();
    Ok(cfg)
}

/// 写设置（原子写 + 上一版留成 `config.json.bak`）
pub fn save(store: &Store, cfg: &Config) -> Result<(), String> {
    atomic::atomic_write_json(&config_path(store), cfg)
}

/// 把 `dataDir` 记到**默认目录**的 `config.json` 里（下次启动据此定位）。
///
/// 用 `serde_json::Value` 合并而不是先反序列化成 `Config` 再写回：
/// 这样文件里我们不认识的字段会被原样保留，不会被这次写入抹掉。
pub fn record_data_dir(dir: &str) -> Result<(), String> {
    let path = default_config_path();

    // 默认目录可能还不存在（例如刚改过目录、或用户手工删了）→ 先建
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建默认目录失败（{}）：{e}", parent.display()))?;
    }

    let mut value: serde_json::Value = atomic::read_json(&path)?.unwrap_or(serde_json::json!({}));
    if !value.is_object() {
        // 文件里原本不是对象（被手工改坏了）→ 换成对象，但先留一份现场
        let bad = path.with_extension("json.bad");
        let _ = std::fs::copy(&path, &bad);
        eprintln!(
            "[东方摩耶堂] config.json 不是对象，已另存现场到 {}",
            bad.display()
        );
        value = serde_json::json!({});
    }
    value["dataDir"] = serde_json::Value::String(dir.to_string());
    atomic::atomic_write_json(&path, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Theme;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!(
            "moyetang-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("建测试目录");
        Store::at(dir)
    }

    #[test]
    fn 没有配置文件时给默认值并带上真实数据目录() {
        let store = temp_store();
        let cfg = load(&store).expect("读设置");
        assert_eq!(cfg.theme, Theme::Light);
        assert_eq!(cfg.font_size, 16);
        assert_eq!(cfg.reminders.info_stale_minutes, 45);
        assert_eq!(cfg.backup_keep, 5);
        assert_eq!(cfg.data_dir, store.data_dir().to_string_lossy());
        // P2-D：球默认停在右侧、离顶 320（手机文本页的悬浮球）
        assert_eq!(cfg.mobile_toolbar_ball.side, "right");
        assert_eq!(cfg.mobile_toolbar_ball.y, 120);
    }

    /// 🔴 **老配置必须还能读**：P2-D 之前写下的 `config.json` 里没有 `mobileToolbarBall`
    /// 这一段 —— 读出来必须是默认值，而不是"读不动老配置"（本项目加配置字段的硬规矩）。
    #[test]
    fn 老配置里没有悬浮球那一段也能读_给默认值() {
        let store = temp_store();
        std::fs::write(
            config_path(&store),
            br#"{"theme":"dark","fontSize":18,"dataDir":"X:\\somewhere"}"#,
        )
        .unwrap();

        let cfg = load(&store).expect("老配置要能读");
        assert_eq!(cfg.theme, Theme::Dark, "老配置里写了的字段要生效");
        assert_eq!(cfg.font_size, 18);
        assert_eq!(cfg.mobile_toolbar_ball.side, "right", "没写过的字段给默认值");
        assert_eq!(cfg.mobile_toolbar_ball.y, 120);
    }

    /// 存过一次球的位置之后要能读回来（拖完球写的就是这一段）
    #[test]
    fn 悬浮球位置存了能读回来() {
        let store = temp_store();
        let mut cfg = load(&store).unwrap();
        cfg.mobile_toolbar_ball.side = "left".to_string();
        cfg.mobile_toolbar_ball.y = 133;
        save(&store, &cfg).unwrap();

        let back = load(&store).unwrap();
        assert_eq!(back.mobile_toolbar_ball.side, "left");
        assert_eq!(back.mobile_toolbar_ball.y, 133);
    }

    #[test]
    fn 保存后能读回来并留_bak() {
        let store = temp_store();
        let mut cfg = load(&store).unwrap();
        cfg.theme = Theme::Dark;
        save(&store, &cfg).unwrap();

        // 改第二次，第一次的内容应成为 .bak
        cfg.font_size = 18;
        save(&store, &cfg).unwrap();

        let back = load(&store).unwrap();
        assert_eq!(back.theme, Theme::Dark);
        assert_eq!(back.font_size, 18);

        let bak: Config = atomic::read_json(&atomic::bak_path(&config_path(&store)))
            .unwrap()
            .expect("应有上一版");
        assert_eq!(bak.font_size, 16, ".bak 是上一版");
    }

    #[test]
    fn 缺字段的老配置文件能读出来() {
        let store = temp_store();
        std::fs::write(config_path(&store), r#"{"theme":"dark"}"#).unwrap();

        let cfg = load(&store).unwrap();
        assert_eq!(cfg.theme, Theme::Dark);
        assert_eq!(cfg.backup_keep, 5, "缺的字段用默认值，不能读失败");
        assert!(cfg.reminders.info_stale_enabled);
    }

    #[test]
    fn 坏掉的配置文件必须报错而不是当默认值() {
        let store = temp_store();
        std::fs::write(config_path(&store), "{坏掉的").unwrap();
        assert!(load(&store).is_err());
    }

    #[test]
    fn 记录数据目录时不抹掉不认识的字段() {
        // 这里直接演练 record_data_dir 的合并逻辑：模拟默认目录里的旧配置
        let dir = std::env::temp_dir().join(format!(
            "moyetang-record-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CONFIG_FILE);
        std::fs::write(&path, r#"{"dataDir":"老路径","未来字段":123}"#).unwrap();

        // 复用与 record_data_dir 相同的合并写法
        let mut value: serde_json::Value = atomic::read_json(&path).unwrap().unwrap();
        value["dataDir"] = serde_json::Value::String("新路径".into());
        atomic::atomic_write_json(&path, &value).unwrap();

        let back: serde_json::Value = atomic::read_json(&path).unwrap().unwrap();
        assert_eq!(back["dataDir"], "新路径");
        assert_eq!(back["未来字段"], 123, "不认识的字段要原样保留");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
