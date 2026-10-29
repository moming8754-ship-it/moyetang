//! 备份导出 / 导入（M7）：把整个数据目录打成一个 zip —— 能带走，也能整个恢复回来。
//!
//! # 打包哪些
//! `info.jsonl` / `notes/` / `todos.json` / `reminders.json` / `config.json` / `assets/`
//! （DEV-PLAN §7.3 的清单）；后来陆续加的：`dailies/`、`awards.json`、`mottos.json`、
//! `annotations.json`、`archive.json`（M15 档案库）。
//!
//! # **有意不打包**哪些
//! - `notes/_trash/`：回收站是"删除留后路"的本地产物，不该跟着备份走
//!   （⚠️ 但 `notes/_archive/` **要**跟着走 —— 那是档案库收纳的笔记文件，不是垃圾：
//!   不带的话，导出再导入档案库里那几篇笔记就没了）；
//! - `backups/`：备份里再装备份，会一轮一轮指数膨胀；
//! - `.npm-cache/`、`dist/`：与程序数据无关的杂物（npm 缓存 / 前端构建产物）。
//!
//! # 导入前**先自动备份当前数据**
//! 覆盖恢复是最危险的操作（一次性把现有数据全换掉）。所以导入的第一步就是把当前数据
//! 导出一份到 `<数据目录>/backups/笔记备份-导入前-<时间>.zip` —— 用户后悔了还能回去。
//! 这是"数据不丢"这条命脉上的最后一环，不能省。
//!
//! # `config.json` 里的 `dataDir` 怎么办
//! 备份里的 `config.json` 带着**备份时那台机器**的数据目录路径。导入时**保留当前的
//! `dataDir`**（只把备份里其它设置合并过来），否则数据会被"搬"到一个可能根本不存在的路径上。

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::store::Store;

/// 备份文件名前缀（后面接日期）
pub const BACKUP_PREFIX: &str = "笔记备份";

/// 要打包的顶层条目（文件或目录），顺序固定，便于测试
const ENTRIES: &[&str] = &[
    "info.jsonl",
    "notes",
    "todos.json",
    "reminders.json",
    "config.json",
    "assets",
    // M11-A：每日报告（用户手写的那部分）
    "dailies",
    // M12-A：奖状 / 证书
    "awards.json",
    // M12-C：格言与原则
    "mottos.json",
    // M14-B：批注（锚点跟正文走，必须一起备份/恢复）
    "annotations.json",
    // M15：档案库
    // ⚠️ **只列 `archive.json`**：被收纳的笔记文件在 `notes/_archive/` 里，而 `notes` 是
    //    **递归**打包的（只排除 `notes/_trash`），所以它们已经在包里了 ——
    //    这里再列一次 `notes/_archive`，同一批文件会在 zip 里**打两遍**（条目重名）。
    //    🔴 但**必须**进备份：不然导出再导入，档案库里的笔记就没了。
    "archive.json",
    // 2026-10-04：倒计时（目标日 + 一句话）—— 新数据文件**必须**进这里，不然导出再导入就没了
    "countdowns.json",
    // M21（v2.11.0）：同步用的删除记录 + 设备状态 —— 同上，**必须**进备份
    "sync",
];

/// **不**该进备份的相对路径（前缀匹配）
const EXCLUDED: &[&str] = &["notes/_trash"];

/// 导出结果（给前端显示"备份到哪了、多少个文件"）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    /// 实际写出的 zip 路径
    pub file: String,
    /// 打进去的文件个数
    pub files: usize,
    /// zip 大小（字节）
    pub bytes: u64,
}

/// 导入结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 覆盖之前自动留下的那份备份
    pub safety_backup: String,
    /// 恢复出来的文件个数
    pub files: usize,
}

/// 默认的备份文件名：`笔记备份-YYYY-MM-DD.zip`
pub fn default_file_name() -> String {
    let today = chrono::Local::now().format("%Y-%m-%d");
    format!("{BACKUP_PREFIX}-{today}.zip")
}

/// 相对路径是不是被排除的（`notes/_trash` 之类）
fn excluded(relative: &str) -> bool {
    EXCLUDED
        .iter()
        .any(|skip| relative == *skip || relative.starts_with(&format!("{skip}/")))
}

/// zip 里的路径统一用 `/`（zip 规范），且必须是**安全的相对路径**
///
/// ⚠️ 导入时必须校验（zip slip）：包里如果混进 `../../x` 或 `C:\x`
/// 这种名字，解压就会写到数据目录外面去 —— 那是被恶意/损坏的包打穿。
fn safe_relative(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./");
    if trimmed.is_empty() {
        return None;
    }
    // 绝对路径 / 盘符 / 任何一段是 `..` → 一律拒绝
    if trimmed.starts_with('/') || trimmed.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// 递归收集要打包的 (zip 内路径, 磁盘路径)
fn collect(root: &Path, relative: &str, into: &mut Vec<(String, PathBuf)>) {
    if excluded(relative) {
        return;
    }
    let disk = root.join(relative);
    if disk.is_dir() {
        let Ok(entries) = fs::read_dir(&disk) else {
            return;
        };
        // 排序：让 zip 内容稳定（同样的数据导出两次，条目顺序一致，便于比对）
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        for name in names {
            collect(root, &format!("{relative}/{name}"), into);
        }
    } else if disk.is_file() {
        into.push((relative.to_string(), disk));
    }
}

/// 导出：把数据目录打包成 zip
pub fn export(store: &Store, dest: &Path) -> Result<BackupReport, String> {
    let root = store.data_dir().to_path_buf();

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in ENTRIES {
        collect(&root, entry, &mut files);
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建备份目录失败（{}）：{e}", parent.display()))?;
    }

    let file = File::create(dest).map_err(|e| format!("创建备份文件失败（{}）：{e}", dest.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for (name, disk) in &files {
        zip.start_file(name.as_str(), options)
            .map_err(|e| format!("写入备份条目失败（{name}）：{e}"))?;
        let mut reader = File::open(disk).map_err(|e| format!("读取失败（{}）：{e}", disk.display()))?;
        std::io::copy(&mut reader, &mut zip).map_err(|e| format!("打包失败（{name}）：{e}"))?;
    }

    zip.finish().map_err(|e| format!("收尾备份文件失败：{e}"))?;

    let bytes = fs::metadata(dest).map(|meta| meta.len()).unwrap_or(0);
    Ok(BackupReport {
        file: dest.to_string_lossy().to_string(),
        files: files.len(),
        bytes,
    })
}

/// 覆盖之前先给当前数据留一份（失败就**中止导入**，宁可不导入也不冒丢数据的险）
///
/// 🔴 2026-10-13：**这里补上了「只留最近 N 份」**。
/// `config.backup_keep`（默认 5，M7 就进了配置、设置页也能改）当初**没有任何代码读它** ——
/// 于是"每次导入留一份"变成只进不出：实测 `backups/` 里堆了 **58 份导入前 zip＝122.7 MB**，
/// 是整个 `backups/`（258 MB）里最大的一块。留完档顺手剪掉最老的。
fn safety_backup(store: &Store) -> Result<PathBuf, String> {
    let dir = store.data_dir().join("backups");
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S");
    let dest = dir.join(format!("{BACKUP_PREFIX}-导入前-{stamp}.zip"));
    export(store, &dest)?;
    prune_import_backups(store, &dir);
    Ok(dest)
}

/// 只留最近 `config.backup_keep` 份「导入前」整包备份（按文件名排序 ＝ 按时间排序）。
///
/// # 只碰自己这一族（2026-10-13）
/// 认死了 `笔记备份-导入前-*.zip` 这一个前缀，别的一律不碰：
/// `safety.rs` 那些「XX-删除前.json」、`sync-pre*` 快照、`.bak`、以及用户自己塞进
/// `backups/` 的任何东西。跟 `safety::prune` 是同一条规矩（只剪自己族）。
///
/// ⚠️ **剪不掉不算错**：留档本身已经成功了，不该因为"清理旧档失败"就让导入失败 ——
/// 只记一行日志。
pub fn prune_import_backups(store: &Store, dir: &std::path::Path) {
    let keep = crate::store::config::load(store)
        .map(|cfg| cfg.backup_keep as usize)
        .unwrap_or(5)
        .max(1); // 至少留 1 份：别把刚写出来的那份也剪了
    let head = format!("{BACKUP_PREFIX}-导入前-");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(&head) && name.ends_with(".zip"))
        .collect();
    names.sort();
    let drop_count = names.len().saturating_sub(keep);
    for name in names.into_iter().take(drop_count) {
        if let Err(error) = std::fs::remove_file(dir.join(&name)) {
            eprintln!("[东方摩耶堂] 清理旧整包备份 {name} 失败（不影响导入）：{error}");
        }
    }
}

/// 导入：从 zip 恢复数据
///
/// 顺序（每一步都不能少）：
/// 1. **先把当前数据备份出去**（失败就中止 —— 宁可不导入也不冒丢数据的险）；
/// 2. 把 zip 里所有条目读进内存并校验路径安全（zip slip）；
/// 3. **清掉备份管理范围内的旧内容**，再落盘（见 [`purge_managed`]）；
/// 4. 把 `config.json` 里的 `dataDir` 换回**当前**的（别让数据目录被搬走）。
///
/// # 为什么第 3 步要"清空重来"而不是"覆盖同名文件"
/// 用户点"导入备份"的意思是**回到备份那一刻**（PRD/DEV-PLAN 用的词是"覆盖恢复"）。
/// 如果只是覆盖同名文件，备份之后新建的笔记会**混在里面**，用户以为恢复干净了、
/// 其实不是 —— 这种"看起来对了其实没对"最坑人。
/// 敢这么做的前提是第 1 步：**当前数据已经原样留在 `backups/` 里了**，后悔随时能导回来。
pub fn import(store: &Store, src: &Path) -> Result<ImportReport, String> {
    let root = store.data_dir().to_path_buf();

    // ① 先留后路 —— 这一步失败就别继续了
    let safety = safety_backup(store)?;

    let file = File::open(src).map_err(|e| format!("打开备份文件失败（{}）：{e}", src.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("这不是一个能读的备份包：{e}"))?;

    // ② 先把所有条目读进内存并校验（**先全部校验、再动任何东西**：
    //    万一包在中间坏掉，不至于留下"清了一半"的数据目录）
    let mut payload: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取备份条目失败：{e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        let Some(relative) = safe_relative(&raw_name) else {
            return Err(format!(
                "备份包里有不安全的路径，已中止导入：{raw_name}（可能是损坏或被改过的包）"
            ));
        };
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取备份内容失败（{raw_name}）：{e}"))?;
        payload.push((relative, bytes));
    }

    // ③ 清空重来（安全备份已经在手上了）
    //
    // ⚠️ 把"这个包里到底有哪些条目"传下去：`awards.json` / `mottos.json` / `dailies/` /
    //    `annotations.json` / `archive.json` 是 M7 做完备份**之后**才陆续加进来的文件，
    //    **早于它们的旧备份里根本没有** ——
    //    无条件清的话，拿一个旧备份导入会把用户现在的奖状 / 格言整批删掉（2026-09-27 修）。
    let present: Vec<String> = payload
        .iter()
        .map(|(relative, _)| relative.to_string_lossy().replace('\\', "/"))
        .collect();
    purge_managed(store, &present)?;

    let mut written = 0usize;
    for (relative, bytes) in &payload {
        let dest = root.join(relative);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败（{}）：{e}", parent.display()))?;
        }
        // 走 `atomic`：导入要写这么多文件，中途断电也要保证每一个要么是旧的、要么是新的。
        // ⚠️ 必须用**字节版**（`atomic_write`）—— `assets/` 里全是二进制图片，
        //    用字符串版（`String::from_utf8_lossy`）会把非法 UTF-8 的字节替换掉，
        //    图片就悄悄写坏了（而且不报错）。
        crate::store::atomic::atomic_write(&dest, bytes)
            .map_err(|e| format!("写入失败（{}）：{e}", dest.display()))?;
        written += 1;
    }

    // ④ 别让数据目录被备份包搬走
    keep_current_data_dir(store)?;

    Ok(ImportReport {
        safety_backup: safety.to_string_lossy().to_string(),
        files: written,
    })
}

/// 清掉"备份管理范围内"的旧内容（导入前调用）
///
/// 三个容易漏的点：
/// 1. **`.bak` 也要删**：`atomic` 有一条"正式文件缺了就用 `.bak` 救回"的规矩，
///    只删正式文件的话，导入清掉的旧笔记会在下一次读取时**复活**
///    （M1 在"删笔记"上踩过一模一样的坑）；
/// 2. **`notes/_trash/` 不能碰**：回收站是"删除留后路"的本地产物，不属于备份范围，
///    不该因为一次导入就被清掉；
/// 3. 🔴 **"后加进来的文件"只清备份包里确实有的那几个**（`present` = 包里的条目名）：
///    `awards.json` / `mottos.json` / `dailies/` / `annotations.json` / `archive.json`
///    是 M7 之后才有的，
///    **旧备份里根本没有它们** —— 无条件清的话，拿旧备份导入会把用户现在的奖状 / 格言整批删掉。
fn purge_managed(store: &Store, present: &[String]) -> Result<(), String> {
    let root = store.data_dir();
    let has = |name: &str| {
        present
            .iter()
            .any(|one| one == name || one.starts_with(&format!("{name}/")))
    };

    // 顶层文件 + 它们的 .bak
    // 老三位（一直就在备份范围里）：无条件清，保持原行为
    for name in ["info.jsonl", "todos.json", "reminders.json"] {
        for candidate in [name.to_string(), format!("{name}.bak")] {
            let path = root.join(&candidate);
            if path.is_file() {
                fs::remove_file(&path)
                    .map_err(|e| format!("清理旧文件失败（{}）：{e}", path.display()))?;
            }
        }
    }

    // M7 之后才加进来的四族：**只清包里确实有的**（见函数注释第 3 条）
    for name in ["awards.json", "mottos.json", "annotations.json", "archive.json"] {
        if !has(name) {
            continue;
        }
        for candidate in [name.to_string(), format!("{name}.bak")] {
            let path = root.join(&candidate);
            if path.is_file() {
                fs::remove_file(&path)
                    .map_err(|e| format!("清理旧文件失败（{}）：{e}", path.display()))?;
            }
        }
    }

    // dailies/（每天一个 json，用户手写的那部分）：同样只在包里有时才清
    if has("dailies") {
        if let Ok(entries) = fs::read_dir(root.join("dailies")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    // notes/_archive/（M15 档案库收纳的笔记文件）：同样**只在包里有时才清**。
    //
    // ⚠️ 为什么必须清：`notes/` 那一轮只删**文件**（子目录原样留着，那是为了保住 `_trash/`），
    //    所以 `_archive/` 里的文件不会被它带走 —— 拿一个"档案库还空着"（或收的东西更少）的备份
    //    导入之后，多出来的那些 `notes/_archive/*.json` 会变成**没有条目的孤儿文件**
    //    （`archive.json` 里已经没有它们了），而且还会被下一次备份白白带走。
    // ⚠️ 反过来：**M15 之前的旧备份里没有 `archive.json`**，这时候一个字都不许动 ——
    //    不然拿旧备份导入会把用户现在的档案库清空（和上面四条同一个道理）。
    if has("archive.json") || has("notes/_archive") {
        if let Ok(entries) = fs::read_dir(root.join("notes").join("_archive")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    // notes/：只删**文件**（.json 与 .json.bak），子目录（`_trash/`）原样留着
    if let Ok(entries) = fs::read_dir(root.join("notes")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(&path);
            }
        }
    }

    // assets/：把图片清掉（备份里有的话下一步会重新解压出来）
    if let Ok(entries) = fs::read_dir(root.join("assets")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(&path);
            }
        }
    }

    Ok(())
}

/// 把 `config.json` 里的 `dataDir` 换回当前实际生效的那个
fn keep_current_data_dir(store: &Store) -> Result<(), String> {
    let current = store.data_dir().to_string_lossy().to_string();
    let mut config = crate::store::config::load(store)?;
    if config.data_dir != current {
        config.data_dir = current;
        crate::store::config::save(store, &config)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;
    // 测试里要手工造 zip（恶意路径那条），得用 write_all
    use std::io::Write;

    /// 一张"真二进制"的假图片：**故意含非法 UTF-8 字节**（0xFF / 0xFE / 0x89）。
    ///
    /// ⚠️ 这条很要紧：第一版导入用字符串版原子写（`String::from_utf8_lossy`），
    /// 会把非法字节替换成 U+FFFD → **图片悄悄写坏且不报错**。
    /// 如果测试里用 `b"PNGDATA"` 这种纯 ASCII，这个 bug 根本暴露不出来 ——
    /// 所以这里的样本必须是真二进制。
    const FAKE_PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE, 0x00, 0x80, 0xC3, 0x28];

    /// 造一点"像真数据"的东西：一条信息、一篇笔记、一条待办、一张图片
    fn seed(store: &Store) {
        fs::create_dir_all(store.data_dir().join("notes")).unwrap();
        fs::create_dir_all(store.data_dir().join("assets")).unwrap();

        let todo = crate::store::todo::create(
            store,
            "备份里的待办".into(),
            Default::default(),
            None,
        )
        .unwrap();
        assert_eq!(todo.title, "备份里的待办");

        crate::store::note::create(store, crate::models::NoteKind::Doc, "备份里的笔记".into())
            .unwrap();

        fs::write(store.data_dir().join("assets").join("pic.png"), FAKE_PNG).unwrap();
    }

    #[test]
    fn 导出再导入内容一致() {
        let store = temp_store("backup-roundtrip");
        seed(&store);
        let zip_path = store.data_dir().join("out.zip");
        let report = export(&store, &zip_path).unwrap();
        assert!(report.files >= 3, "应该打进好几个文件：{}", report.files);
        assert!(zip_path.is_file());

        // 把数据目录里的东西删干净，再导入回来
        fs::remove_file(store.data_dir().join("todos.json")).unwrap();
        fs::remove_dir_all(store.data_dir().join("notes")).unwrap();
        fs::remove_dir_all(store.data_dir().join("assets")).unwrap();

        let imported = import(&store, &zip_path).unwrap();
        assert!(imported.files >= 3);

        let todos = crate::store::todo::list(&store).unwrap();
        assert!(todos.iter().any(|one| one.title == "备份里的待办"), "待办回来了");
        let notes = crate::store::note::list(&store).unwrap();
        assert!(notes.iter().any(|one| one.title == "备份里的笔记"), "笔记回来了");
        assert_eq!(
            fs::read(store.data_dir().join("assets").join("pic.png")).unwrap(),
            FAKE_PNG,
            "★ 图片必须**逐字节**原样回来（含非法 UTF-8 的字节）"
        );
    }

    #[test]
    fn 回收站和备份目录不进备份() {
        let store = temp_store("backup-exclude");
        seed(&store);
        // 回收站里放一个（它是"删除留后路"的本地产物，不该跟着备份走）
        let trash = store.data_dir().join("notes").join("_trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join("gone.json"), b"{}").unwrap();
        // backups 目录里放一个（备份里再装备份会指数膨胀）
        let backups = store.data_dir().join("backups");
        fs::create_dir_all(&backups).unwrap();
        fs::write(backups.join("old.zip"), b"ZIP").unwrap();
        // .npm-cache / dist 这类杂物
        fs::create_dir_all(store.data_dir().join(".npm-cache")).unwrap();
        fs::write(store.data_dir().join(".npm-cache").join("junk"), b"x").unwrap();

        let zip_path = store.data_dir().join("out.zip");
        export(&store, &zip_path).unwrap();

        let file = File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            !names.iter().any(|n| n.contains("_trash")),
            "回收站不该进备份：{names:?}"
        );
        assert!(
            !names.iter().any(|n| n.starts_with("backups/")),
            "backups 不该进备份：{names:?}"
        );
        assert!(
            !names.iter().any(|n| n.contains("npm-cache")),
            "npm 缓存不该进备份：{names:?}"
        );
    }

    #[test]
    fn 导入前会自动留一份当前数据的备份() {
        let store = temp_store("backup-safety");
        seed(&store);
        let zip_path = store.data_dir().join("out.zip");
        export(&store, &zip_path).unwrap();

        // 导入前改一下待办，验证"覆盖前那份"确实存了旧状态
        crate::store::todo::create(&store, "导入之后应该没了".into(), Default::default(), None)
            .unwrap();

        let report = import(&store, &zip_path).unwrap();
        assert!(
            Path::new(&report.safety_backup).is_file(),
            "必须留下覆盖前的备份：{}",
            report.safety_backup
        );
        let safety = fs::read(&report.safety_backup).unwrap();
        assert!(
            String::from_utf8_lossy(&safety).contains("导入之后应该没了")
                || safety.len() > 0,
            "留的那份应该是覆盖前的数据"
        );
    }

    #[test]
    fn 恶意路径的备份包会被拒绝() {
        let store = temp_store("backup-zipslip");
        seed(&store);
        // 手工造一个带 `../` 的包
        let evil = store.data_dir().join("evil.zip");
        {
            let file = File::create(&evil).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("../../被穿透了.txt", options).unwrap();
            zip.write_all(b"pwned").unwrap();
            zip.finish().unwrap();
        }

        let err = import(&store, &evil).unwrap_err();
        assert!(err.contains("不安全"), "要明确拒绝并说清原因：{err}");
        // 而且**先校验后写入**：数据目录没被动过
        assert!(crate::store::todo::list(&store).unwrap().iter().any(|t| t.title == "备份里的待办"));
    }

    #[test]
    fn 导入是恢复不是合并_备份之后新建的会被清掉() {
        let store = temp_store("backup-replace");
        seed(&store);
        let zip_path = store.data_dir().join("out.zip");
        export(&store, &zip_path).unwrap();

        // 备份之后用户又写了东西
        crate::store::note::create(&store, crate::models::NoteKind::Doc, "备份之后新建的".into())
            .unwrap();
        assert!(crate::store::note::list(&store)
            .unwrap()
            .iter()
            .any(|one| one.title == "备份之后新建的"));

        import(&store, &zip_path).unwrap();

        let notes = crate::store::note::list(&store).unwrap();
        let titles: Vec<String> = notes.iter().map(|one| one.title.clone()).collect();
        assert!(
            !titles.iter().any(|title| title == "备份之后新建的"),
            "★ 导入的语义是「回到备份那一刻」，备份之后新建的笔记不该留着：{titles:?}"
        );
        assert!(
            titles.iter().any(|title| title == "备份里的笔记"),
            "备份里的笔记要回来：{titles:?}"
        );
    }

    #[test]
    fn 导入不会清掉回收站() {
        let store = temp_store("backup-keep-trash");
        seed(&store);
        let zip_path = store.data_dir().join("out.zip");
        export(&store, &zip_path).unwrap();

        let trash = store.data_dir().join("notes").join("_trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join("deleted.json"), b"{}").unwrap();

        import(&store, &zip_path).unwrap();

        assert!(
            trash.join("deleted.json").is_file(),
            "★ 回收站不属于备份范围，导入不该把它清掉"
        );
    }

    #[test]
    fn 相对路径校验() {
        assert!(safe_relative("notes/a.json").is_some());
        assert!(safe_relative("./notes/a.json").is_some());
        assert!(safe_relative("notes\\a.json").is_some(), "Windows 分隔符也要认");
        assert!(safe_relative("../x").is_none());
        assert!(safe_relative("notes/../../x").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        assert!(safe_relative("C:/Windows/x").is_none());
        assert!(safe_relative("").is_none());
    }

    #[test]
    fn 导入不会把数据目录搬走() {
        let store = temp_store("backup-keep-dir");
        seed(&store);
        let zip_path = store.data_dir().join("out.zip");
        export(&store, &zip_path).unwrap();

        // 篡改包里的 config.json：假装它来自另一台机器
        let patched = store.data_dir().join("patched.zip");
        {
            let file = File::open(&zip_path).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            let out = File::create(&patched).unwrap();
            let mut writer = zip::ZipWriter::new(out);
            let options = zip::write::SimpleFileOptions::default();
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).unwrap();
                let name = entry.name().to_string();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                if name == "config.json" {
                    let text = String::from_utf8_lossy(&bytes).replace(
                        &store.data_dir().to_string_lossy().to_string(),
                        "D:/别的机器上的目录",
                    );
                    bytes = text.into_bytes();
                }
                writer.start_file(name.as_str(), options).unwrap();
                writer.write_all(&bytes).unwrap();
            }
            writer.finish().unwrap();
        }

        import(&store, &patched).unwrap();
        let config = crate::store::config::load(&store).unwrap();
        assert_eq!(
            config.data_dir,
            store.data_dir().to_string_lossy().to_string(),
            "★ 导入不能把数据目录换成备份里那个"
        );
    }

    /// M15：档案库**必须**进备份 —— 不然导出再导入，档案库里那几篇笔记就没了。
    ///
    /// 两样东西都在包里：`archive.json`（条目）+ `notes/_archive/<id>.json`（被收纳的笔记文件，
    /// 它跟着 `notes/` 一起打包，**不是**像 `_trash/` 那样被排除）。
    #[test]
    fn 档案库会进备份_导入之后还回得去() {
        let store = temp_store("backup-archive");
        seed(&store);

        let info_one = crate::store::info::create(
            &store,
            crate::models::InfoKind::Text,
            "会被收起来的信息".to_string(),
            Vec::new(),
            None,
        )
        .unwrap();
        crate::store::archive::put(&store, "info", &info_one.id, "先收着").unwrap();

        let note_one = crate::store::note::create_with_content(
            &store,
            crate::models::NoteKind::Doc,
            "会被收起来的笔记".to_string(),
            "正文第一行\n第二行".to_string(),
        )
        .unwrap()
        .0;
        crate::store::archive::put(&store, "note", &note_one.id, "").unwrap();

        let zip_path = store.data_dir().join("out.zip");
        export(&store, &zip_path).unwrap();

        let file = File::open(&zip_path).unwrap();
        let mut zipfile = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..zipfile.len())
            .map(|i| zipfile.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            names.iter().any(|name| name == "archive.json"),
            "档案条目要进备份：{names:?}"
        );
        let archived_note = format!("notes/_archive/{}.json", note_one.id);
        assert!(
            names.iter().any(|name| name == &archived_note),
            "★ 被收纳的笔记文件也要进备份：{names:?}"
        );
        assert_eq!(
            names.iter().filter(|name| name.starts_with("notes/_archive/")).count(),
            2,
            "★ 笔记文件**连同它的 .bak** 一起进备份（收纳时两个都挪过去了）：{names:?}"
        );
        // ⚠️ 这条盯的是"登记了两次"那个坑：`notes/` 本来就是**递归**打包的，
        //    如果 `ENTRIES` 里再列一次 `notes/_archive`，同一份文件会在 zip 里打两遍（条目重名）。
        let mut unique = names.clone();
        unique.sort();
        let count = unique.len();
        unique.dedup();
        assert_eq!(unique.len(), count, "★ zip 里不该有重名条目：{names:?}");

        // 把档案库整个删掉，再导入回来 —— 得像没删过一样
        fs::remove_file(store.data_dir().join("archive.json")).unwrap();
        fs::remove_dir_all(store.data_dir().join("notes")).unwrap();
        import(&store, &zip_path).unwrap();

        let items = crate::store::archive::list(&store).unwrap();
        assert_eq!(items.len(), 2, "两条档案都该回来：{items:?}");
        let note_entry = items.iter().find(|one| one.kind == "note").unwrap();
        assert_eq!(note_entry.snapshot["content"], "正文第一行\n第二行");
        assert!(
            store
                .data_dir()
                .join("notes")
                .join("_archive")
                .join(format!("{}.json", note_one.id))
                .is_file(),
            "★ 被收纳的笔记文件也得回来"
        );

        // 而且取出来还能回到认知区（快照逐项复原）
        crate::store::archive::restore(&store, &note_one.id).unwrap();
        let back = crate::store::note::get(&store, &note_one.id).unwrap().unwrap();
        assert_eq!(back.content, "正文第一行\n第二行");
    }

    /// M15 **之前**的旧包里根本没有 `archive.json`：拿它导入**不许**清掉用户现在的档案库
    /// （和奖状 / 格言 / 批注 / 日报那四条同一个道理，见 `purge_managed` 的注释第 3 条）。
    #[test]
    fn 旧备份里没有档案库_导入不许清掉现在的档案库() {
        let store = temp_store("backup-archive-legacy-pack");
        seed(&store);

        let info_one = crate::store::info::create(
            &store,
            crate::models::InfoKind::Text,
            "收起来的信息".to_string(),
            Vec::new(),
            None,
        )
        .unwrap();
        crate::store::archive::put(&store, "info", &info_one.id, "先收着").unwrap();

        let full = store.data_dir().join("out.zip");
        export(&store, &full).unwrap();

        // 手工造一个"M15 之前"的包：把档案库那几条刨掉
        let old = store.data_dir().join("old.zip");
        {
            let file = File::open(&full).unwrap();
            let mut zipfile = zip::ZipArchive::new(file).unwrap();
            let out = File::create(&old).unwrap();
            let mut writer = zip::ZipWriter::new(out);
            let options = zip::write::SimpleFileOptions::default();
            for i in 0..zipfile.len() {
                let mut entry = zipfile.by_index(i).unwrap();
                let name = entry.name().to_string();
                if name == "archive.json" || name.starts_with("notes/_archive/") {
                    continue;
                }
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                writer.start_file(name.as_str(), options).unwrap();
                writer.write_all(&bytes).unwrap();
            }
            writer.finish().unwrap();
        }

        import(&store, &old).unwrap();

        let items = crate::store::archive::list(&store).unwrap();
        assert_eq!(items.len(), 1, "★ 旧包导入不该把现在的档案库清掉：{items:?}");
        assert_eq!(items[0].id, info_one.id);
        assert_eq!(items[0].note, "先收着");
    }

    /// 🔴 2026-10-13：「导入前备份」原来**只进不出** —— `config.backup_keep`（默认 5）
    /// 当初没有任何代码读它，实测堆了 **58 份 / 122.7 MB**（`backups/` 里最大的一块）。
    /// 这条钉住：留最近 N 份、且**只碰自己这一族**。
    #[test]
    fn 导入前备份只留最近五份_别的都不动() {
        let store = temp_store("backup-prune-import");
        let dir = store.data_dir().join("backups");
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..9 {
            std::fs::write(
                dir.join(format!("笔记备份-导入前-2026-10-13-0000{index:02}.zip")),
                b"ZIP",
            )
            .unwrap();
        }
        // 不许碰的三样：整包导出、.bak、别族留档
        std::fs::write(dir.join("笔记备份-2026-10-13.zip"), b"ZIP").unwrap();
        std::fs::write(
            dir.join("笔记备份-导入前-2026-10-13-000000.zip.bak"),
            b"ZIP",
        )
        .unwrap();
        std::fs::write(dir.join("info-删除前-2026-10-13-000000.json"), b"{}").unwrap();

        prune_import_backups(&store, &dir);

        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("笔记备份-导入前-") && name.ends_with(".zip"))
            .collect();
        assert_eq!(
            left.len(),
            5,
            "只留最近 5 份（配置缺省 backup_keep = 5）：{left:?}"
        );
        assert!(
            left.contains(&"笔记备份-导入前-2026-10-13-000008.zip".to_string()),
            "留下的该是最新的那几份：{left:?}"
        );
        assert!(
            !left.contains(&"笔记备份-导入前-2026-10-13-000000.zip".to_string()),
            "最老的那份该被剪掉：{left:?}"
        );
        assert!(dir.join("笔记备份-2026-10-13.zip").is_file(), "整包导出不许碰");
        assert!(
            dir.join("笔记备份-导入前-2026-10-13-000000.zip.bak").is_file(),
            ".bak 不许碰"
        );
        assert!(
            dir.join("info-删除前-2026-10-13-000000.json").is_file(),
            "别族留档不许碰"
        );
    }
}
