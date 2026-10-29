//! 笔记导出 / 导入（人可读的 Markdown / 纯文本）—— M27（v2.18.0）
//!
//! 三条设计约定（改之前先读）：
//!
//! 1. **导出的是"人可读的文件"，不是备份**。整库 zip 备份在 [`crate::store::backup`]；
//!    这里只把**一篇笔记**变成 `.md` / `.txt`，拿去微信、邮箱、别的编辑器里都能直接看。
//! 2. **图片连带走**：正文里的 `![](assets/xxx.jpg)` 会被改写成 `<笔记名>.assets/xxx.jpg`，
//!    并把**真的用到了、本地也真的有的**那些图复制到同目录的同名文件夹里 —— 导出的东西
//!    离开数据目录也不断图。⚠️ 本地没有的图（还没同步过来）**保持原样不改写**：
//!    改写成一个不存在的路径，比留一句"它还在数据目录里"更糟。
//! 3. **能纯的都纯**：`safe_stem` / `tree_outline` / `asset_refs` / `rewrite_out` /
//!    `rewrite_in` / `parse_import` 全是纯函数（单测不用造数据目录），
//!    只有 [`build_bundle`] 会读图字节。
//!
//! 树笔记的导出：`content` 照原样（那是它的"正文"），**另外把整棵树渲染成嵌套列表**
//! 追加在后面（md 用 `## 大纲`，txt 用 `【大纲】`）—— 只导正文的话，一棵 60 个节点的树
//! 会只剩 8 个字。

use crate::models::{Note, NoteKind, TreeNode};
use crate::store::{assets, Store};

/// 导出格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Markdown（`# 标题` 开头）
    Md,
    /// 纯文本（第一行是标题，不带 `#`）
    Txt,
}

impl Format {
    /// 前端传 "md" / "txt"（大小写不敏感；也认 "markdown"）
    pub fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "md" | "markdown" => Ok(Self::Md),
            "txt" | "text" | "plain" => Ok(Self::Txt),
            other => Err(format!("不认识的导出格式：{other}")),
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Self::Md => "md",
            Self::Txt => "txt",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Md => "text/markdown",
            Self::Txt => "text/plain",
        }
    }
}

/// 一个要写出去的文件：`name` 是**相对导出根**的名字（带子目录，用 `/` 分隔）
#[derive(Debug, Clone)]
pub struct OutFile {
    pub name: String,
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// 一篇笔记的导出结果：主文件 + 附件（图片）
#[derive(Debug, Clone)]
pub struct Bundle {
    /// 文件名主干（标题洗过之后的样子，不含扩展名）
    pub stem: String,
    /// 附件文件夹名（`<stem>.assets`）
    pub asset_dir: String,
    /// 主文件（`<stem>.md` / `<stem>.txt`）
    pub main: OutFile,
    /// 连同导出的图片（`<stem>.assets/xxx.jpg`）
    pub images: Vec<OutFile>,
}

/// 文件名主干：把不能在文件名里出现的字符换掉。
///
/// ⚠️ 刻意做得保守（Windows 上会踩的坑全挡掉）：`\/:*?"<>|` 与控制字符 → `_`；
/// 首尾空白和**结尾的点**去掉（Windows 存不下 `笔记.` 这种名字）；
/// 太长截断到 60 字（中文标题 60 字 = 180 字节，够用且不会撞系统的 255 字节上限）；
/// `CON` / `PRN` 这类 Windows 保留名前面加个 `_`。
pub fn safe_stem(title: &str) -> String {
    const BAD: [char; 10] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\u{7f}'];
    let mut cleaned: String = title
        .chars()
        .map(|c| {
            if BAD.contains(&c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut stem: String = cleaned.trim().chars().take(60).collect();
    while stem.ends_with(' ') || stem.ends_with('.') {
        stem.pop();
    }
    if stem.is_empty() {
        return "未命名笔记".to_string();
    }
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|one| stem.eq_ignore_ascii_case(one)) {
        return format!("_{stem}");
    }
    stem
}

/// 把一棵树渲染成嵌套的 Markdown 列表
pub fn tree_outline(root: &TreeNode) -> String {
    let mut out = String::new();
    walk_node(root, 0, &mut out);
    out.trim_end().to_string()
}

fn walk_node(node: &TreeNode, depth: usize, out: &mut String) {
    let pad = "  ".repeat(depth);
    let text = node.text.trim();
    if text.is_empty() {
        out.push_str(&format!("{pad}-\n"));
    } else {
        out.push_str(&format!("{pad}- {text}\n"));
    }
    if let Some(path) = node
        .asset_path
        .as_deref()
        .map(str::trim)
        .filter(|one| !one.is_empty())
    {
        out.push_str(&format!("{pad}  ![]({path})\n"));
    }
    for child in &node.children {
        walk_node(child, depth + 1, out);
    }
}

/// 扫出一段文本里引用到的图片名（`assets/xxx.jpg` 里的 `xxx.jpg`，去重、保持出现顺序）
///
/// ⚠️ 前缀左边必须**不是**字母数字或 `.` `_` `-` —— 否则 `笔记.assets/a.jpg` 里的
/// `assets/` 也会被当成引用扫出来（那是"已经导出过一轮"的文件，不是数据目录里的图）。
pub fn asset_refs(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for name in scan_prefixed(text, "assets/") {
        if !found.contains(&name) {
            found.push(name);
        }
    }
    found
}

/// 树里所有节点挂的图（`assetPath`）
pub fn tree_asset_refs(root: &TreeNode) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    collect_node_assets(root, &mut found);
    found
}

fn collect_node_assets(node: &TreeNode, into: &mut Vec<String>) {
    if let Some(path) = node.asset_path.as_deref().map(str::trim) {
        if let Some(name) = path.strip_prefix("assets/") {
            let name = name.trim();
            if !name.is_empty() && !into.contains(&name.to_string()) {
                into.push(name.to_string());
            }
        }
    }
    for child in &node.children {
        collect_node_assets(child, into);
    }
}

/// 扫出 `prefix` 后面的图片名（`prefix` 是 ASCII，名字只认 `[A-Za-z0-9._-]`）
fn scan_prefixed(text: &str, prefix: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    let mut offset = 0usize;
    while let Some(pos) = rest.find(prefix) {
        let at = offset + pos;
        let before_ok = text[..at]
            .chars()
            .next_back()
            .map(|c| !(c.is_alphanumeric() || c == '.' || c == '_' || c == '-'))
            .unwrap_or(true);
        let name_start = at + prefix.len();
        let name: String = text[name_start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-')
            .collect();
        if before_ok && !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
        offset = name_start;
        rest = &text[name_start..];
    }
    out
}

/// 把 `assets/名字` 改写成 `<文件夹>/名字`（**只改 `names` 里列出的那些**）
pub fn rewrite_out(text: &str, folder: &str, names: &[String]) -> String {
    rewrite_prefixed(text, "assets/", &format!("{folder}/"), names)
}

/// 把 `<文件夹>/名字` 改回 `assets/名字`（导入时用，同样只改 `names` 里的）
pub fn rewrite_in(text: &str, folder: &str, names: &[String]) -> String {
    rewrite_prefixed(text, &format!("{folder}/"), "assets/", names)
}

fn rewrite_prefixed(text: &str, from: &str, to: &str, names: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < text.len() {
        if text[i..].starts_with(from) {
            let before_ok = text[..i]
                .chars()
                .next_back()
                .map(|c| !(c.is_alphanumeric() || c == '.' || c == '_' || c == '-'))
                .unwrap_or(true);
            let name_start = i + from.len();
            let name: String = text[name_start..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-')
                .collect();
            if before_ok && !name.is_empty() && names.iter().any(|one| one == &name) {
                out.push_str(to);
                out.push_str(&name);
                i = name_start + name.len();
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap_or('\u{0}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 导出用的正文（md 带 `# 标题`；树笔记额外追加"大纲"）
pub fn body_for_export(note: &Note, format: Format) -> String {
    let title = note.title.trim();
    let title = if title.is_empty() { "未命名笔记" } else { title };
    let mut body = note.content.trim_end().to_string();
    if note.kind == NoteKind::Tree {
        if let Some(root) = note.root.as_ref() {
            let outline = tree_outline(root);
            if !outline.is_empty() {
                if !body.is_empty() {
                    body.push_str("\n\n");
                }
                body.push_str(match format {
                    Format::Md => "## 大纲\n\n",
                    Format::Txt => "【大纲】\n\n",
                });
                body.push_str(&outline);
            }
        }
    }
    let text = match format {
        Format::Md => format!("# {title}\n\n{body}"),
        Format::Txt => format!("{title}\n\n{body}"),
    };
    text.trim_end().to_string()
}

/// 组装一篇笔记的导出内容（读图片字节是唯一的磁盘动作）
pub fn build_bundle(
    store: &Store,
    note: &Note,
    format: Format,
    with_images: bool,
) -> Result<Bundle, String> {
    let stem = safe_stem(&note.title);
    let asset_dir = format!("{stem}.assets");
    let mut text = body_for_export(note, format);
    let mut images: Vec<OutFile> = Vec::new();

    // 纯文本不带图：`.txt` 里的图片没有意义，复制出去只会让人困惑
    if with_images && format == Format::Md {
        let mut wanted = asset_refs(&text);
        if let Some(root) = note.root.as_ref() {
            for name in tree_asset_refs(root) {
                if !wanted.contains(&name) {
                    wanted.push(name);
                }
            }
        }
        let mut copied: Vec<String> = Vec::new();
        for name in wanted {
            if !assets::name_ok(&name) {
                continue;
            }
            match assets::read(store, &name) {
                Ok(bytes) => {
                    images.push(OutFile {
                        name: format!("{asset_dir}/{name}"),
                        bytes,
                        mime: mime_for(&name).to_string(),
                    });
                    copied.push(name);
                }
                // 图还没同步到这台机器 → 跳过，链接也保持原样（见文件头约定 2）
                Err(_) => continue,
            }
        }
        if !copied.is_empty() {
            text = rewrite_out(&text, &asset_dir, &copied);
        }
    }

    Ok(Bundle {
        main: OutFile {
            name: format!("{stem}.{}", format.ext()),
            bytes: text.into_bytes(),
            mime: format.mime().to_string(),
        },
        stem,
        asset_dir,
        images,
    })
}

/// 按扩展名猜 MIME（安卓 MediaStore 要它，猜不出就当二进制）
pub fn mime_for(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    match lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("") {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// 解析导入的一个文件：标题 + 正文。
///
/// 规则（和手机端 B6 保持一致，别再各写一套）：
/// ① 第一行是 `# 标题` → 拿它当标题，正文 = 去掉这一行、再去掉紧跟的空行；
/// ② 否则标题 = 文件名（`fallback` 传进来），正文 = 整个文件**原样**；
/// ③ 开头有 BOM（Windows 记事本存的）先剥掉。
pub fn parse_import(text: &str, fallback: &str) -> (String, String) {
    let clean = text.strip_prefix('\u{feff}').unwrap_or(text);
    let first = clean.lines().next().unwrap_or("").trim();
    if let Some(rest) = first.strip_prefix("# ") {
        let title = rest.trim();
        let body = clean
            .split_once('\n')
            .map(|(_, tail)| tail.to_string())
            .unwrap_or_default();
        let body = body.trim_start_matches(['\r', '\n']).to_string();
        let title = if title.is_empty() { fallback } else { title };
        return (title.to_string(), body);
    }
    let fallback = if fallback.trim().is_empty() {
        "导入的笔记"
    } else {
        fallback
    };
    (fallback.to_string(), clean.to_string())
}

/// 文件名 → 标题（导入时用：`我的笔记.md` → `我的笔记`）
pub fn title_from_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = base
        .rsplit_once('.')
        .map(|(head, _)| head)
        .filter(|head| !head.is_empty())
        .unwrap_or(base);
    let stem = stem.trim();
    if stem.is_empty() {
        "导入的笔记".to_string()
    } else {
        stem.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::note;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "moyetang-export-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("建测试目录");
        dir
    }

    fn tree_note(store: &Store, title: &str, content: &str) -> Note {
        let (mut note, _) = note::create_with_content(store, NoteKind::Tree, title.to_string(), content.to_string())
            .expect("建树笔记");
        let mut root = TreeNode::new("根节点");
        let mut with_image = TreeNode::new("带图的子节点");
        with_image.asset_path = Some("assets/aa.jpg".to_string());
        root.children.push(TreeNode::new("普通子节点"));
        root.children.push(with_image);
        note.root = Some(root);
        note::save(store, &note).expect("存树笔记")
    }

    #[test]
    fn 文件名洗得干净() {
        assert_eq!(safe_stem("正常标题"), "正常标题");
        assert_eq!(safe_stem("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(safe_stem("   "), "未命名笔记");
        assert_eq!(safe_stem("结尾有点..."), "结尾有点");
        assert_eq!(safe_stem("CON"), "_CON");
        let long = "字".repeat(200);
        assert_eq!(safe_stem(&long).chars().count(), 60);
    }

    #[test]
    fn 格式解析认三种写法() {
        assert_eq!(Format::parse("md").unwrap(), Format::Md);
        assert_eq!(Format::parse("Markdown").unwrap(), Format::Md);
        assert_eq!(Format::parse(" TXT ").unwrap(), Format::Txt);
        assert!(Format::parse("pdf").is_err());
    }

    #[test]
    fn 树渲染成嵌套列表带图() {
        let root = TreeNode {
            id: "r".into(),
            text: "根".into(),
            asset_path: None,
            collapsed: true,
            children: vec![
                TreeNode {
                    id: "a".into(),
                    text: "子一".into(),
                    asset_path: None,
                    collapsed: false,
                    children: vec![TreeNode::new("孙")],
                    source_info_id: None,
                },
                TreeNode {
                    id: "b".into(),
                    text: "".into(),
                    asset_path: Some("assets/x.jpg".into()),
                    collapsed: false,
                    children: vec![],
                    source_info_id: None,
                },
            ],
            source_info_id: None,
        };
        let text = tree_outline(&root);
        assert_eq!(text, "- 根\n  - 子一\n    - 孙\n  -\n    ![](assets/x.jpg)");
        // collapsed 只是界面上的折叠，导出必须**照样带出来**（不然导出会丢内容）
        assert!(text.contains("孙"));
    }

    #[test]
    fn 扫引用不会把导出目录当引用() {
        let text = "看图 ![](assets/aa.jpg) 再看 ![](assets/aa.jpg) 还有 (assets/bb.png) \
                    外加已经导出过的 (笔记.assets/cc.jpg) 和 assets/";
        assert_eq!(asset_refs(text), vec!["aa.jpg".to_string(), "bb.png".to_string()]);
    }

    #[test]
    fn 改写链接只动点名的那些() {
        let text = "![](assets/aa.jpg) ![](assets/bb.png) ![](笔记.assets/cc.jpg)";
        let names = vec!["aa.jpg".to_string()];
        let out = rewrite_out(text, "笔记.assets", &names);
        assert_eq!(out, "![](笔记.assets/aa.jpg) ![](assets/bb.png) ![](笔记.assets/cc.jpg)");
        // 改回来（导入时走反方向）
        let back = rewrite_in(&out, "笔记.assets", &names);
        assert!(back.contains("![](assets/aa.jpg)"));
    }

    #[test]
    fn 导入解析认标题行与文件名() {
        let (title, body) = parse_import("# 我的标题\n\n正文一\n正文二\n", "文件名");
        assert_eq!(title, "我的标题");
        assert_eq!(body, "正文一\n正文二\n");
        let (title, body) = parse_import("\u{feff}没有标题行\n第二行\n", "文件名");
        assert_eq!(title, "文件名");
        assert_eq!(body, "没有标题行\n第二行\n");
        assert_eq!(title_from_file_name("D:\\下载\\我的笔记.md"), "我的笔记");
        assert_eq!(title_from_file_name("笔记"), "笔记");
    }

    #[test]
    fn 文本笔记导出带标题() {
        let dir = temp_dir("doc");
        let store = Store::at(&dir);
        store.ensure_dirs().unwrap();
        let (note, _) = note::create_with_content(&store, NoteKind::Doc, "记事".into(), "正文".into()).unwrap();
        assert_eq!(body_for_export(&note, Format::Md), "# 记事\n\n正文");
        assert_eq!(body_for_export(&note, Format::Txt), "记事\n\n正文");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 树笔记导出正文加大纲() {
        let dir = temp_dir("tree");
        let store = Store::at(&dir);
        store.ensure_dirs().unwrap();
        let note = tree_note(&store, "树笔记", "正文那句话");
        let text = body_for_export(&note, Format::Md);
        assert!(text.starts_with("# 树笔记\n\n正文那句话\n\n## 大纲\n\n- 根节点"), "{text}");
        assert!(text.contains("- 带图的子节点"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 导出会把图带上并改链接() {
        let dir = temp_dir("bundle");
        let store = Store::at(&dir);
        store.ensure_dirs().unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets").join("aa.jpg"), b"JPEGDATA").unwrap();
        let (note, _) = note::create_with_content(
            &store,
            NoteKind::Doc,
            "带图笔记".into(),
            "看图 ![](assets/aa.jpg) 和还没同步的 ![](assets/missing.jpg)".into(),
        )
        .unwrap();
        let bundle = build_bundle(&store, &note, Format::Md, true).unwrap();
        assert_eq!(bundle.stem, "带图笔记");
        assert_eq!(bundle.main.name, "带图笔记.md");
        assert_eq!(bundle.images.len(), 1);
        assert_eq!(bundle.images[0].name, "带图笔记.assets/aa.jpg");
        assert_eq!(bundle.images[0].bytes, b"JPEGDATA");
        let text = String::from_utf8(bundle.main.bytes.clone()).unwrap();
        assert!(text.contains("(带图笔记.assets/aa.jpg)"), "{text}");
        assert!(text.contains("(assets/missing.jpg)"), "没同步过来的图不许改写：{text}");

        // 不带图那一档：一个附件都不复制，链接也不动
        let plain = build_bundle(&store, &note, Format::Md, false).unwrap();
        assert!(plain.images.is_empty());
        let text = String::from_utf8(plain.main.bytes).unwrap();
        assert!(text.contains("(assets/aa.jpg)"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 树节点挂的图也一起导出() {
        let dir = temp_dir("tree-img");
        let store = Store::at(&dir);
        store.ensure_dirs().unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets").join("aa.jpg"), b"JPEGDATA").unwrap();
        let note = tree_note(&store, "带图的树", "");
        let bundle = build_bundle(&store, &note, Format::Md, true).unwrap();
        assert_eq!(bundle.images.len(), 1);
        assert_eq!(bundle.images[0].name, "带图的树.assets/aa.jpg");
        let text = String::from_utf8(bundle.main.bytes).unwrap();
        assert!(text.contains("(带图的树.assets/aa.jpg)"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 纯文本导出不带图() {
        let dir = temp_dir("txt");
        let store = Store::at(&dir);
        store.ensure_dirs().unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets").join("aa.jpg"), b"JPEGDATA").unwrap();
        let (note, _) = note::create_with_content(
            &store,
            NoteKind::Doc,
            "纯文本".into(),
            "图 ![](assets/aa.jpg)".into(),
        )
        .unwrap();
        let bundle = build_bundle(&store, &note, Format::Txt, true).unwrap();
        assert!(bundle.images.is_empty());
        assert_eq!(bundle.main.name, "纯文本.txt");
        let _ = fs::remove_dir_all(&dir);
    }
}
