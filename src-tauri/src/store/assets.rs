//! 图片附件：复制进 `<数据目录>/assets/`。
//!
//! 约定：库文件里只存**相对路径**（`assets/xxxx.png`），绝对路径由
//! [`abs_path`] 在需要时算出来 —— 这样用户改数据目录时，历史记录里的路径照样有效。

use crate::store::Store;
use std::fs;
use std::path::{Path, PathBuf};

/// 附件目录名
pub const ASSETS_DIR: &str = "assets";
/// 允许的图片扩展名（小写）
const ALLOWED_EXT: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"];

/// `<数据目录>/assets`
pub fn assets_dir(store: &Store) -> PathBuf {
    store.data_dir().join(ASSETS_DIR)
}

/// 把外部图片文件复制进 `assets/`，返回相对路径（`assets/xxxx.png`）。
///
/// 文件名用 uuid：避免同名覆盖，也避免中文/特殊字符路径带来的麻烦；
/// 原文件**保留不动**（用户拖进来的东西，我们只读取复制）。
pub fn import_file(store: &Store, source: &Path) -> Result<String, String> {
    if !source.is_file() {
        return Err(format!("找不到这个文件：{}", source.display()));
    }

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        let shown = if ext.is_empty() {
            "（没有扩展名）".to_string()
        } else {
            ext.clone()
        };
        return Err(format!(
            "不支持的图片格式：{shown}（支持 png/jpg/jpeg/gif/webp/bmp/avif）"
        ));
    }

    let dir = assets_dir(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 assets 目录失败：{e}"))?;

    let name = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let target = dir.join(&name);
    fs::copy(source, &target).map_err(|e| {
        format!(
            "复制图片失败（{} → {}）：{e}",
            source.display(),
            target.display()
        )
    })?;

    Ok(format!("{ASSETS_DIR}/{name}"))
}

/// 相对路径 → 绝对路径（前端要拿它去显示图片）。
///
/// 只接受 `assets/` 下的**单层文件名**：挡住 `..\..\` 这类路径穿越，
/// 免得前端一个参数就能把机器上任意文件读出来。
pub fn abs_path(store: &Store, rel: &str) -> Result<PathBuf, String> {
    let normalized = rel.trim().replace('\\', "/");
    let rest = normalized
        .strip_prefix("assets/")
        .ok_or_else(|| format!("附件路径必须以 assets/ 开头：{rel}"))?;
    if rest.is_empty() || rest.contains("..") || rest.contains('/') || rest.contains(':') {
        return Err(format!("附件路径不合法：{rel}"));
    }
    Ok(assets_dir(store).join(rest))
}

/// 靠**文件头魔数**判断图片格式。
///
/// 剪贴板里只有字节、没有文件名，所以不能按扩展名判断。
/// 认不出来返回 `None` —— 宁可报错，也别写出一堆打不开的垃圾文件。
fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| bytes.len() >= sig.len() && &bytes[..sig.len()] == sig;
    if starts(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if starts(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some("gif");
    }
    if starts(b"BM") {
        return Some("bmp");
    }
    // WebP: RIFF????WEBP
    if bytes.len() >= 12 && starts(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    // AVIF/HEIF: ????ftyp{avif,avis,heic,heif,mif1}
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"avif" || brand == b"avis" || brand == b"heic" || brand == b"heif" || brand == b"mif1"
        {
            return Some("avif");
        }
    }
    None
}

/// 把一段**图片字节**写进 `assets/`，返回相对路径。
///
/// 用途：从**剪贴板粘贴图片**（用户 M4 反馈："图片已经在剪贴板里了，能不能 Ctrl+V 一下"）。
/// 剪贴板给的是字节、不是磁盘上的文件路径，所以走不了 [`import_file`]。
///
/// 扩展名按魔数猜；猜不出来报错。文件名仍然用 uuid（不覆盖、不怕中文路径）。
pub fn write_image_bytes(store: &Store, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("剪贴板里没有图片内容".to_string());
    }
    let ext = sniff_ext(bytes).ok_or_else(|| {
        "剪贴板里这段内容不像图片（认不出格式，支持 png/jpg/gif/webp/bmp/avif）".to_string()
    })?;

    let dir = assets_dir(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 assets 目录失败：{e}"))?;

    let name = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let target = dir.join(&name);
    fs::write(&target, bytes)
        .map_err(|e| format!("写入图片失败（{}）：{e}", target.display()))?;

    Ok(format!("{ASSETS_DIR}/{name}"))
}

// ───────────────────────── M26：图片参与同步（2026-10-06）─────────────────────────
//
// 规矩（《同步协议》§5.2 与文末附录四）：**只增不删的并集**。
// 你早就定了"原图永不删"（正文摘图 / 奖状换图 / 树节点去图，`assets/` 里的原文件都留着），
// 所以图片集合只增不减 → **不需要墓碑、不需要冲突判定**；文件名是 uuid → 两台设备各自导入也不会撞名。
//
// 这个文件里只放"看得见的文件操作"；**"该传哪些"那条纯规则在 `sync_merge::plan_assets`**。

/// 一张图的身份证（同步清单里就是**名字 + 字节数**）
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    /// **单层文件名**（`xxxx.png`）—— 不是 `assets/xxxx.png`：同步只在 `assets/` 里搬文件
    pub name: String,
    pub size: u64,
}

/// 单张图的上限（协议附录四 §4.2 第 4 条）：超了**不同步**并在报告里点名（别往手机里塞巨图）
pub const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;

/// 文件名合法吗 —— **对方传来的名字落盘前必须过这一关**
///
/// 只允许 `assets/` 下的**单层文件名**：挡住 `..`、斜杠、冒号。
/// 不然对方一个 `name` 参数就能往你磁盘的任意位置写文件（和 [`abs_path`] 同一条规矩）。
pub fn name_ok(name: &str) -> bool {
    if name.trim() != name || name.is_empty() || name.len() > 128 {
        return false;
    }
    if name.starts_with('.') {
        return false; // 隐藏文件 / `.` / `..` 一律不收
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') || name.contains("..") {
        return false;
    }
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    ALLOWED_EXT.contains(&ext.as_str())
}

/// 列出 `assets/` 里参与同步的图
///
/// 顺序**必须确定**（按名字排）：两端算出来的清单要能逐字节对上，否则每次同步都以为有差异。
pub fn list(store: &Store) -> Result<Vec<AssetMeta>, String> {
    let dir = assets_dir(store);
    let mut out: Vec<AssetMeta> = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(one) => one,
        // 还没有图片目录 = 空清单（不是错误）
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("读 assets 目录失败（{}）：{e}", dir.display())),
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name_ok(&name) {
            continue; // 不是我们认的图片（或名字不合法）→ 不进同步清单
        }
        out.push(AssetMeta { name, size: meta.len() });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读一张图的字节（要传给别人时用）
pub fn read(store: &Store, name: &str) -> Result<Vec<u8>, String> {
    if !name_ok(name) {
        return Err(format!("图片名不合法：{name}"));
    }
    fs::read(assets_dir(store).join(name)).map_err(|e| format!("读图片失败（{name}）：{e}"))
}

/// 收到一张对方传来的图之后，实际发生了什么（账单与报告要用）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Incoming {
    /// 落盘了（这张我原来没有）
    Saved,
    /// 我已经有一模一样的一张 → 什么都不做
    Skipped,
    /// 同名但字节数不同 → **保留本地那张**，不覆盖
    Clash,
}

/// 落盘一张**对方传来的**图（只增不改）
///
/// ⚠️ 三条安全线，改之前先读：
/// ① 名字必须过 [`name_ok`]（挡路径穿越）；
/// ② **已存在的一律不覆盖**：同大小 → 跳过；不同大小 → 报冲突、留本地
///    （uuid 撞名说明文件坏了，那就更不该覆盖）；
/// ③ 先写 `.xxx.part` 临时文件 → 核对字节数 → 再改名。中途失败**删掉半成品**，
///    绝不留一个"看着有、其实是半张"的图。
pub fn save_incoming(store: &Store, name: &str, bytes: &[u8]) -> Result<Incoming, String> {
    if !name_ok(name) {
        return Err(format!("图片名不合法：{name}"));
    }
    if bytes.is_empty() {
        return Err(format!("{name}：收到的是空内容"));
    }
    let dir = assets_dir(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 assets 目录失败：{e}"))?;
    let target = dir.join(name);

    if let Ok(meta) = fs::metadata(&target) {
        if meta.is_file() {
            if meta.len() == bytes.len() as u64 {
                return Ok(Incoming::Skipped);
            }
            return Ok(Incoming::Clash);
        }
    }

    let tmp = dir.join(format!(".{name}.part"));
    fs::write(&tmp, bytes).map_err(|e| format!("写图片失败（{name}）：{e}"))?;
    let written = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if written != bytes.len() as u64 {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "{name}：写进去的字节数和收到的不一样（{written} ≠ {}）",
            bytes.len()
        ));
    }
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{name}：改名失败：{e}")
    })?;
    Ok(Incoming::Saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn 导入图片会复制进_assets_并返回相对路径() {
        let store = temp_store("assets-import");
        let src = store.data_dir().join("外面的一张图.png");
        fs::write(&src, b"fake-png-bytes").unwrap();

        let rel = import_file(&store, &src).unwrap();
        assert!(rel.starts_with("assets/"), "实际：{rel}");
        assert!(rel.ends_with(".png"), "扩展名要保留：{rel}");

        let abs = abs_path(&store, &rel).unwrap();
        assert!(abs.is_file(), "复制后的文件应存在：{}", abs.display());
        assert_eq!(fs::read(&abs).unwrap(), b"fake-png-bytes");
        assert!(src.is_file(), "原文件不能动");
    }

    #[test]
    fn 不支持的格式要报错() {
        let store = temp_store("assets-ext");
        let src = store.data_dir().join("恶意.exe");
        fs::write(&src, b"x").unwrap();
        let err = import_file(&store, &src).unwrap_err();
        assert!(err.contains("不支持的图片格式"), "实际：{err}");
    }

    #[test]
    fn 路径穿越要被挡住() {
        let store = temp_store("assets-traversal");
        assert!(abs_path(&store, "assets/../../config.json").is_err());
        assert!(abs_path(&store, "assets/sub/x.png").is_err());
        assert!(abs_path(&store, "config.json").is_err());
        assert!(abs_path(&store, "assets/ok.png").is_ok());
    }

    #[test]
    fn 剪贴板字节按魔数认格式() {
        let store = temp_store("assets-bytes");
        // 最小 PNG 头 + 一点内容
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(b"fake");
        let rel = write_image_bytes(&store, &png).unwrap();
        assert!(rel.ends_with(".png"), "实际：{rel}");
        assert_eq!(fs::read(abs_path(&store, &rel).unwrap()).unwrap(), png);

        let jpg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        assert!(write_image_bytes(&store, &jpg).unwrap().ends_with(".jpg"));

        let gif = b"GIF89a-rest".to_vec();
        assert!(write_image_bytes(&store, &gif).unwrap().ends_with(".gif"));

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert!(write_image_bytes(&store, &webp).unwrap().ends_with(".webp"));

        // 认不出来 → 报错，而不是写一堆打不开的文件
        let err = write_image_bytes(&store, b"\x00\x01\x02\x03not an image").unwrap_err();
        assert!(err.contains("不像图片"), "实际：{err}");

        let err = write_image_bytes(&store, b"").unwrap_err();
        assert!(err.contains("没有图片内容"), "实际：{err}");
    }

    // ── M26：同步用的那几件（只增不删的并集）─────────────────────────

    #[test]
    fn 同步用的文件名_只认单层图片名() {
        assert!(name_ok("6e81fbcc-c832-4028-b346-8caa4b29970d.png"));
        assert!(name_ok("a.jpg"));
        assert!(name_ok("a.JPEG"), "大写扩展名要认");
        // 下面这些一个都不能过（过了就能往磁盘任意位置写文件）
        assert!(!name_ok(""), "空名字");
        assert!(!name_ok("../../config.json"));
        assert!(!name_ok("sub/a.png"), "不许带目录");
        assert!(!name_ok("sub\\a.png"), "不许带反斜杠目录");
        assert!(!name_ok("C:/a.png"), "不许带盘符/冒号");
        assert!(!name_ok(".hidden.png"), "隐藏文件不收");
        assert!(!name_ok("a.exe"), "非图片扩展名");
        assert!(!name_ok("a"), "没有扩展名");
        assert!(!name_ok(" a.png"), "两头不许有空格");
    }

    #[test]
    fn 列图清单_按名字排序且跳过非图片() {
        let store = temp_store("assets-list");
        let dir = assets_dir(&store);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("bbb.png"), b"22").unwrap();
        fs::write(dir.join("aaa.jpg"), b"1").unwrap();
        fs::write(dir.join("readme.txt"), b"x").unwrap(); // 不是图片 → 不进清单
        fs::create_dir_all(dir.join("sub")).unwrap(); // 目录 → 不进清单

        let got = list(&store).unwrap();
        let names: Vec<&str> = got.iter().map(|one| one.name.as_str()).collect();
        assert_eq!(names, vec!["aaa.jpg", "bbb.png"], "要按名字排序");
        assert_eq!(got[1].size, 2, "size 要是真实字节数");

        // 目录都不存在时是空清单，不是错误
        let fresh = temp_store("assets-list-empty");
        assert!(list(&fresh).unwrap().is_empty());
    }

    #[test]
    fn 收图只增不改_同大小跳过_不同大小报冲突() {
        let store = temp_store("assets-incoming");
        let name = "11111111-2222-3333-4444-555555555555.png";
        let png = b"\x89PNG\r\n\x1a\nfirst".to_vec();

        assert_eq!(save_incoming(&store, name, &png).unwrap(), Incoming::Saved);
        assert_eq!(read(&store, name).unwrap(), png);

        // 一模一样再来一次 → 跳过（不重复写）
        assert_eq!(save_incoming(&store, name, &png).unwrap(), Incoming::Skipped);
        // 同名但内容长度不同 → 冲突：**本地那份不能被覆盖**
        let other = b"\x89PNG\r\n\x1a\nSECOND-LONGER".to_vec();
        assert_eq!(save_incoming(&store, name, &other).unwrap(), Incoming::Clash);
        assert_eq!(read(&store, name).unwrap(), png, "冲突时必须留本地那张");

        // 名字不合法 → 直接拒绝，磁盘上不能出现任何东西
        assert!(save_incoming(&store, "../evil.png", b"x").is_err());
        assert!(save_incoming(&store, name, b"").is_err(), "空内容不收");
        assert!(!assets_dir(&store).join("evil.png").exists());
        // 半成品临时文件不能留下
        let leftovers: Vec<String> = fs::read_dir(assets_dir(&store))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty(), "不该留临时文件：{leftovers:?}");
    }
}
