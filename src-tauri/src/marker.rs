//! 认知笔记里的 `-[]文字` 待办标记：**行级**解析（M3-4）。
//!
//! 三个约定，改动前先看这里：
//! 1. **写法是 `-[]文字`**，不是标准 Markdown 的 `- [ ]`（用户指定，少敲两个空格）。
//!    标准写法在这里**不算标记**，会当成普通文字渲染 —— 别"顺手兼容"，
//!    否则用户写的普通列表会莫名变成待办。
//! 2. **只在行首匹配**（允许前面有空白）：普通句子里出现 `-[]` 不误伤（DEV-PLAN §8）。
//! 3. 去重键 `markerKey = noteId + '#' + 归一化文本`（DEV-PLAN §4.3）。
//!    归一化 = 去掉首尾空白 + 把中间连续空白压成一个空格；
//!    **故意不做小写化**：`-[]Buy milk` 与 `-[]buy milk` 视为两件事，标题保留原样。
//!
//! ⚠️ 前端 `src/features/notes/markers.ts` 是这里的**镜像实现**（预览要同步拿到 key，
//! 不能每敲一个字都问一次后端）。两边规则必须一致，改一边就要改另一边。

/// 一条 `-[]` 标记
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    /// 0 基行号（前端用它把预览/编辑器里的行映射回标记）
    pub line: usize,
    /// 去重键：`noteId + '#' + 归一化文本`
    pub key: String,
    /// `-[]` 后面的文字（已 trim，保留原始大小写）
    pub text: String,
}

/// 归一化文本：去掉首尾空白 + 连续空白压成一个空格
pub fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 去重键：`noteId + '#' + 归一化文本`
pub fn marker_key(note_id: &str, text: &str) -> String {
    format!("{}#{}", note_id, normalize(text))
}

/// 树状图节点的去重键：`noteId + '#' + nodeId + '#' + 归一化文本`（M5）
///
/// 比正文的键多一段 `nodeId`：树里每个节点都是独立的一"行"，
/// 两个节点写着一样的文字是两件事，不该共用一条待办。
///
/// **为什么不怕和正文的键撞车**：一篇笔记要么是文本笔记、要么是树状图
/// （`NoteKind` 二选一），同一个 `noteId` 不可能同时产出两种键。
pub fn node_marker_key(note_id: &str, node_id: &str, text: &str) -> String {
    format!("{}#{}#{}", note_id, node_id, normalize(text))
}

/// 判断一行是不是标记；是的话给出 `-[]` 后面的文字。
///
/// 只认行首（前面允许空白）的 `-[]`；`-[]` 后面必须有文字，
/// 孤零零一个 `-[]` 不算（那种多半是没写完，不该生成一条空待办）。
///
/// 树状图也用它 —— **一个节点的文字就当成"一行"**。
pub fn strip_marker(line: &str) -> Option<&str> {
    let text = line.trim_start().strip_prefix("-[]")?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 扫一遍正文，按出现顺序给出所有标记。一行最多一个（行首那个）。
pub fn scan(note_id: &str, content: &str) -> Vec<Marker> {
    content
        .lines()
        .enumerate()
        .filter_map(|(line, raw)| {
            let text = strip_marker(raw)?;
            Some(Marker {
                line,
                key: marker_key(note_id, text),
                text: text.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 行首的标记能被认出来() {
        let found = scan("note-1", "-[]我一定要学会做饭");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 0);
        assert_eq!(found[0].text, "我一定要学会做饭");
        assert_eq!(found[0].key, "note-1#我一定要学会做饭");
    }

    #[test]
    fn 前面有空白也算行首() {
        let found = scan("n", "  -[]缩进也能认");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "缩进也能认");
    }

    #[test]
    fn 行中间的不算标记() {
        assert!(scan("n", "这句话里有 -[]符号但不在行首").is_empty());
        assert!(scan("n", "> -[]引用块里也算普通文字").is_empty());
    }

    #[test]
    fn 标准写法不是标记() {
        // 用户指定的是 `-[]`；标准 Markdown 待办在这里只是普通文字
        assert!(scan("n", "- [ ] 标准写法").is_empty());
        assert!(scan("n", "- [x] 标准写法").is_empty());
    }

    #[test]
    fn 空的标记不算() {
        assert!(scan("n", "-[]").is_empty());
        assert!(scan("n", "-[]   ").is_empty());
    }

    #[test]
    fn 行号对得上且多行都扫得到() {
        let content = "第一行\n-[]甲\n随便一句\n-[]乙\n> *〔联动信息〕引用*\n-[]丙";
        let found = scan("n", content);
        assert_eq!(found.len(), 3);
        assert_eq!(
            found.iter().map(|m| m.line).collect::<Vec<_>>(),
            vec![1, 3, 5]
        );
        assert_eq!(
            found.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            vec!["甲", "乙", "丙"]
        );
    }

    #[test]
    fn 归一化让空格差异的同一件事共用一个键() {
        let a = scan("n", "-[]  学会   做饭 ");
        let b = scan("n", "-[]学会 做饭");
        assert_eq!(a[0].key, b[0].key, "多余空白不该产生第二条待办");
        assert_eq!(a[0].key, "n#学会 做饭");
        // 但文字本身保留原样（标题给人看的）
        assert_eq!(a[0].text, "学会   做饭");
    }

    #[test]
    fn 大小写不同视为两件事() {
        let a = marker_key("n", "Buy milk");
        let b = marker_key("n", "buy milk");
        assert_ne!(a, b);
    }

    #[test]
    fn 不同笔记的同名标记互不干扰() {
        assert_ne!(marker_key("note-1", "吃饭"), marker_key("note-2", "吃饭"));
    }

    #[test]
    fn 空正文扫出空结果() {
        assert!(scan("n", "").is_empty());
        assert!(scan("n", "\n\n   \n").is_empty());
    }

    // ─────────────────── M5：树节点 ───────────────────

    #[test]
    fn 树节点的键带着节点id() {
        let key = node_marker_key("note-1", "node-9", "学会   做饭");
        assert_eq!(key, "note-1#node-9#学会 做饭");

        // 同一棵树里，两个节点写一样的文字 → 两条不同的待办
        assert_ne!(
            node_marker_key("n", "节点甲", "吃饭"),
            node_marker_key("n", "节点乙", "吃饭")
        );
        // 不同树里的同一个节点 id 也不该混
        assert_ne!(
            node_marker_key("树一", "n1", "吃饭"),
            node_marker_key("树二", "n1", "吃饭")
        );
        // 正文的键和树节点的键形状不同（同一篇笔记只会是其中一种）
        assert_ne!(marker_key("n", "吃饭"), node_marker_key("n", "n1", "吃饭"));
    }

    #[test]
    fn 树节点复用同一套标记规则() {
        // 行首限定、`-[]` 后必须有文字、标准写法不算 —— 与正文完全一致
        assert_eq!(strip_marker("-[]写方案"), Some("写方案"));
        assert_eq!(strip_marker("   -[]缩进也算行首"), Some("缩进也算行首"));
        assert_eq!(strip_marker("节点里提到 -[]但不在开头"), None);
        assert_eq!(strip_marker("-[]"), None);
        assert_eq!(strip_marker("- [ ] 标准写法"), None);
        assert_eq!(strip_marker("普通节点文字"), None);
    }
}
