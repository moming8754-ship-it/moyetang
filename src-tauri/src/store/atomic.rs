//! 原子写 + 保留上一版 `.bak`。
//!
//! **这是整个数据层的命脉**：`info.jsonl`、`notes/*.json`、`todos.json`、
//! `reminders.json`、`config.json` 一律只能通过本模块落盘，禁止直接 `fs::write`。
//!
//! 一次写入的顺序（每一步都有理由，别改）：
//!
//! 1. 把新内容写进**同目录**的临时文件 `xxx.tmp`，并 `sync_all()`（fsync）；
//!    —— 不 fsync 就可能在断电后留下"文件存在但内容是空的"；
//!    —— 临时文件必须和目标同目录，跨盘的 `rename` 不是原子的（甚至直接失败）。
//! 2. 正式文件若已存在，先改名成 `xxx.bak`（**保留上一版**）；改名沿用旧 `.bak`。
//! 3. `rename(xxx.tmp → xxx)` 覆盖成正式文件（同目录 rename 是原子替换）。
//!    万一这一步失败，立刻把 `.bak` 改回正式文件，保证旧数据还在。
//!
//! 已知的极窄窗口：若在第 2 步和第 3 步之间进程被强杀，正式文件会短暂消失，
//! 此时 `.bak` 仍在。为此 [`read_to_string`] / [`read_json`] 在"正式文件不存在"时
//! 会自动回退到 `.bak` 并把它恢复成正式文件，数据不会丢。
//!
//! ⚠️ 教训（草笺项目踩过）：**JSON 绝不能二次序列化**。
//! 要写 JSON 就用 [`atomic_write_json`] 直接传结构体；把已经序列化好的字符串
//! 再交给序列化函数会写出"套娃 JSON"，读回来是 `"{\"a\":1}"` 这种字符串。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// 临时文件后缀
pub const TMP_SUFFIX: &str = ".tmp";
/// 上一版备份后缀
pub const BAK_SUFFIX: &str = ".bak";

/// `info.jsonl` → `info.jsonl.tmp`
pub fn tmp_path(path: &Path) -> PathBuf {
    sibling(path, TMP_SUFFIX)
}

/// `info.jsonl` → `info.jsonl.bak`
pub fn bak_path(path: &Path) -> PathBuf {
    sibling(path, BAK_SUFFIX)
}

/// 给路径的文件名后面拼一个后缀（**不是** `with_extension`：那会吃掉原来的扩展名）
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    match path.file_name() {
        Some(name) => {
            let mut name = name.to_os_string();
            name.push(suffix);
            path.with_file_name(name)
        }
        None => {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            PathBuf::from(name)
        }
    }
}

fn io_err(msg: impl Into<String>) -> io::Error {
    io::Error::other(msg.into())
}

/// 删除文件，但"本来就不存在"不算错误
fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(format!("删除文件失败（{}）：{e}", path.display()))),
    }
}

/// **原子写字节**：临时文件 → fsync → 上一版改名 `.bak` → 原子替换。
///
/// 父目录不存在会自动建。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| io_err(format!("创建目录失败（{}）：{e}", parent.display())))?;
        }
    }

    let tmp = tmp_path(path);
    let bak = bak_path(path);

    // 1) 新内容先完整落到临时文件并 fsync —— 在此之前绝不动正式文件
    {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| io_err(format!("创建临时文件失败（{}）：{e}", tmp.display())))?;
        file.write_all(bytes)
            .map_err(|e| io_err(format!("写入临时文件失败（{}）：{e}", tmp.display())))?;
        file.flush()
            .map_err(|e| io_err(format!("刷新临时文件失败（{}）：{e}", tmp.display())))?;
        file.sync_all()
            .map_err(|e| io_err(format!("落盘临时文件失败（{}）：{e}", tmp.display())))?;
    }

    // 2) 正式文件存在 → 先保留上一版
    let had_target = path.exists();
    if had_target {
        remove_if_exists(&bak)?;
        fs::rename(path, &bak).map_err(|e| {
            io_err(format!(
                "保留上一版失败（{} → {}）：{e}",
                path.display(),
                bak.display()
            ))
        })?;
    }

    // 3) 临时文件 → 正式文件
    if let Err(e) = fs::rename(&tmp, path) {
        // 失败就把上一版放回去，再清掉临时文件，别留下半成品
        if had_target {
            let _ = fs::rename(&bak, path);
        }
        let _ = fs::remove_file(&tmp);
        return Err(io_err(format!(
            "替换文件失败（{}）：{e}",
            path.display()
        )));
    }

    Ok(())
}

/// **原子写文本**（UTF-8）
pub fn atomic_write_str(path: &Path, text: &str) -> io::Result<()> {
    atomic_write(path, text.as_bytes())
}

/// 读文本：正式文件 → 回退上一版 `.bak`（都没有 → `Ok(None)`）
///
/// 正式文件不存在而 `.bak` 在，说明上次替换被打断；本次读取顺手把 `.bak` 恢复成
/// 正式文件（尽力而为，恢复失败不影响这次读取的返回值）。
pub fn read_to_string(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let bak = bak_path(path);
            match fs::read_to_string(&bak) {
                Ok(text) => {
                    eprintln!(
                        "[东方摩耶堂] 正式文件缺失，用上一版恢复：{}",
                        path.display()
                    );
                    let _ = fs::copy(&bak, path);
                    Ok(Some(text))
                }
                Err(e2) if e2.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(e2) => Err(io_err(format!(
                    "读取上一版失败（{}）：{e2}",
                    bak.display()
                ))),
            }
        }
        Err(e) => Err(io_err(format!("读取失败（{}）：{e}", path.display()))),
    }
}

/// 读取 `.bak`（上一版）：没有 → `Ok(None)`。用于"想拿回上一版"的场景。
// M7 的备份/恢复会用到；现在只有测试在用
#[allow(dead_code)]
pub fn read_backup(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(bak_path(path)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err(format!("读取上一版失败（{}）：{e}", path.display()))),
    }
}

/// **原子写 JSON**：结构体 → 序列化一次 → 原子写。
///
/// 传结构体，不要传 `String`（见文件头的"套娃 JSON"教训）。
pub fn atomic_write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化失败（{}）：{e}", path.display()))?;
    atomic_write_str(path, &text).map_err(|e| e.to_string())
}

/// 读 JSON：文件不存在 → `Ok(None)`。
///
/// ⚠️ 文件存在但解析不了时报**错误**而不是回退成默认值 —— 宁可让用户看到报错，
/// 也不能把坏文件当成"空数据"覆盖掉（用户最在意数据不能丢）。
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let text = match read_to_string(path) {
        Ok(Some(text)) => text,
        Ok(None) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("解析失败（{}）：{e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// 每个测试一个独立空目录（不引入 tempfile 依赖）
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = SEQ.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "moyetang-atomic-test-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).expect("建测试目录");
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 首次写入不留_bak_也不留_tmp() {
        let dir = TempDir::new();
        let file = dir.path("info.jsonl");

        atomic_write_str(&file, "第一版").expect("写入");

        assert_eq!(read_to_string(&file).unwrap().unwrap(), "第一版");
        assert!(!bak_path(&file).exists(), "首次写入不该有 .bak");
        assert!(!tmp_path(&file).exists(), "写完不该残留 .tmp");
    }

    #[test]
    fn 二次写入把上一版留成_bak() {
        let dir = TempDir::new();
        let file = dir.path("info.jsonl");

        atomic_write_str(&file, "第一版").expect("写入第一版");
        atomic_write_str(&file, "第二版").expect("写入第二版");

        assert_eq!(read_to_string(&file).unwrap().unwrap(), "第二版");
        assert_eq!(read_backup(&file).unwrap().unwrap(), "第一版");
        assert!(!tmp_path(&file).exists(), "写完不该残留 .tmp");
    }

    #[test]
    fn 只保留最近一次上一版() {
        let dir = TempDir::new();
        let file = dir.path("config.json");

        atomic_write_str(&file, "v1").unwrap();
        atomic_write_str(&file, "v2").unwrap();
        atomic_write_str(&file, "v3").unwrap();

        assert_eq!(read_to_string(&file).unwrap().unwrap(), "v3");
        assert_eq!(read_backup(&file).unwrap().unwrap(), "v2", "只留上一版");
    }

    #[test]
    fn 正式文件缺失时用_bak_救回来() {
        let dir = TempDir::new();
        let file = dir.path("info.jsonl");

        atomic_write_str(&file, "第一版").unwrap();
        atomic_write_str(&file, "第二版").unwrap();
        fs::remove_file(&file).unwrap(); // 模拟替换到一半被打断

        let got = read_to_string(&file).unwrap();
        assert_eq!(got.unwrap(), "第一版");
        assert!(file.exists(), "读取时应顺手把 .bak 恢复成正式文件");
    }

    #[test]
    fn 全部不存在时返回_none() {
        let dir = TempDir::new();
        let file = dir.path("nothing.json");
        assert!(read_to_string(&file).unwrap().is_none());
        assert!(read_backup(&file).unwrap().is_none());
    }

    #[test]
    fn 父目录不存在会自动建() {
        let dir = TempDir::new();
        let file = dir.path("notes").join("a.json");

        atomic_write_str(&file, "深一层").expect("写入");
        assert_eq!(read_to_string(&file).unwrap().unwrap(), "深一层");
    }

    #[test]
    fn json_往返不出现套娃() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Cfg {
            #[serde(rename = "dataDir")]
            data_dir: String,
            backup_keep: u32,
        }

        let dir = TempDir::new();
        let file = dir.path("config.json");
        let cfg = Cfg {
            data_dir: r"D:\东方摩耶堂".into(),
            backup_keep: 5,
        };

        atomic_write_json(&file, &cfg).expect("写 JSON");
        let back: Cfg = read_json(&file).unwrap().expect("读 JSON");
        assert_eq!(back, cfg);

        // 直接看文件内容：必须是对象，而不是被转义过的字符串
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.trim_start().starts_with('{'), "不应是套娃 JSON：{raw}");
    }

    #[test]
    fn 坏掉的_json_报错而不是当空数据() {
        let dir = TempDir::new();
        let file = dir.path("todos.json");
        atomic_write_str(&file, "{ 这不是合法 JSON").unwrap();

        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct Todos {
            #[serde(default)]
            items: Vec<u32>,
        }

        let got: Result<Option<Todos>, String> = read_json(&file);
        assert!(got.is_err(), "坏文件必须报错，否则会被当成空数据覆盖掉");
        // 坏内容仍然在文件里，没被顺手清掉
        assert!(fs::read_to_string(&file).unwrap().contains("不是合法"));
    }
}
