//! 文件管理器「用东方摩耶堂打开」的共用小工具。

#[cfg(desktop)]
use std::path::{Path, PathBuf};

/// 从命令行参数里挑出真实存在的 Markdown / 文本文件。
#[cfg(desktop)]
pub fn note_paths_from_args(args: &[String], cwd: &Path) -> Vec<String> {
    args.iter()
        .filter_map(|raw| {
            let raw = raw.trim().trim_matches('"');
            if raw.is_empty() || raw.starts_with("--") {
                return None;
            }
            let path = PathBuf::from(raw);
            let path = if path.is_absolute() { path } else { cwd.join(path) };
            if !path.is_file() {
                return None;
            }
            let ext = path
                .extension()
                .map(|one| one.to_string_lossy().to_ascii_lowercase())?;
            if !matches!(ext.as_str(), "md" | "markdown" | "txt") {
                return None;
            }
            Some(path.to_string_lossy().to_string())
        })
        .collect()
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn set_reg_string(root: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_SZ,
    };

    let root_w = wide(root);
    let mut key: HKEY = std::ptr::null_mut();
    let code = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            root_w.as_ptr(),
            0,
            std::ptr::null_mut(),
            0,
            KEY_WRITE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if code != ERROR_SUCCESS {
        return Err(format!("创建注册表项失败（{root}，code={code}）"));
    }

    let name_w = name.map(wide);
    let value_w = wide(value);
    let code = unsafe {
        RegSetValueExW(
            key,
            name_w.as_ref().map_or(std::ptr::null(), |one| one.as_ptr()),
            0,
            REG_SZ,
            value_w.as_ptr().cast::<u8>(),
            (value_w.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    unsafe { RegCloseKey(key) };
    if code != ERROR_SUCCESS {
        return Err(format!("写注册表值失败（{root}，code={code}）"));
    }
    Ok(())
}

/// 注册当前 exe 为 Markdown / 文本的“打开方式”候选。
///
/// - 只写 `HKEY_CURRENT_USER`，不需要管理员权限；
/// - **不改默认打开程序**，只在右键「打开方式」里增加东方摩耶堂；
/// - 每次启动更新 exe 路径，免安装版挪目录后也能自动修正。
#[cfg(windows)]
pub fn register_open_with() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("取当前 exe 路径失败：{e}"))?;
    let exe_text = exe.to_string_lossy().to_string();
    let exe_name = exe
        .file_name()
        .map(|one| one.to_string_lossy().to_string())
        .unwrap_or_else(|| "notes-app.exe".to_string());
    let prog_id = "Moyetang.Note";
    let open_cmd = format!("\"{exe_text}\" \"%1\"");

    for ext in ["md", "markdown", "txt"] {
        set_reg_string(
            &format!("Software\\Classes\\.{ext}\\OpenWithProgids"),
            Some(prog_id),
            "",
        )?;
    }
    set_reg_string(
        "Software\\Classes\\Moyetang.Note",
        None,
        "东方摩耶堂笔记",
    )?;
    set_reg_string(
        "Software\\Classes\\Moyetang.Note\\DefaultIcon",
        None,
        &format!("\"{exe_text}\",0"),
    )?;
    set_reg_string(
        "Software\\Classes\\Moyetang.Note\\shell\\open\\command",
        None,
        &open_cmd,
    )?;

    let app_root = format!("Software\\Classes\\Applications\\{exe_name}");
    set_reg_string(&format!("{app_root}\\shell\\open\\command"), None, &open_cmd)?;
    for ext in ["md", "markdown", "txt"] {
        set_reg_string(&format!("{app_root}\\SupportedTypes"), Some(&format!(".{ext}")), "")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::note_paths_from_args;
    use std::path::Path;

    #[test]
    fn 只认存在的markdown文本文件() {
        let dir = std::env::temp_dir().join(format!(
            "moyetang-open-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("随手记.md");
        let exe = dir.join("notes-app.exe");
        std::fs::write(&md, "正文").unwrap();
        std::fs::write(&exe, "").unwrap();

        let got = note_paths_from_args(
            &[
                exe.to_string_lossy().to_string(),
                "随手记.md".to_string(),
                "--autostart".to_string(),
                "不存在.md".to_string(),
            ],
            &dir,
        );
        assert_eq!(got, vec![md.to_string_lossy().to_string()]);
        let _ = std::fs::remove_dir_all(Path::new(&dir));
    }
}
