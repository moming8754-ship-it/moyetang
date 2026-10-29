//! 树状图节点的操作（M4）。
//!
//! # 为什么是"一次操作一条命令"，而不是"前端改完整篇写回"
//!
//! M3 的文本编辑器是「前端握一份正文 → 整篇写回」。树状图**不能照抄**，因为有覆盖竞态：
//! 树笔记会被后端自己改（`note::link_info` 往根节点下加联动节点）。如果前端握着一份
//! 旧树保存，刚联动进来的节点就被抹掉了 —— 这撞的是用户最在意的「数据不能丢」。
//!
//! 所以这里走**操作式**：每条命令都
//! `读盘拿最新（note::get）→ 改一处 → note::save → atomic::atomic_write_json`。
//! 全程**只有 `note::save` 这一个写口**，所以「一切写文件都走 `store::atomic`」一个字没改。
//!
//! 附带好处：防环、根保护、整枝删除这些规则能在 Rust 里写单元测试，
//! 而不是靠前端自觉（前端也会拦一道，但那是体验，不是保证）。
//!
//! # 节点 id 从哪来
//! 一律 `TreeNode::new()`（Rust 生成 uuid）。前端不自己造 id。

use crate::models::{Note, NoteKind, TreeNode};
use crate::store::{note, sync, sync_merge::KIND_TREE_NODE, Store};

/// 新节点的默认文字（建完立刻进入编辑态，用户直接覆盖）
pub const DEFAULT_NODE_TEXT: &str = "新节点";
/// 根节点的默认文字（老文件没根时补的也是它）
pub const ROOT_DEFAULT_TEXT: &str = "中心主题";

/// 拖拽落点：变成子节点 / 插到前面 / 插到后面
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DropPosition {
    /// 成为目标的**最后一个子节点**
    Child,
    /// 成为目标的**前一个同级**
    Before,
    /// 成为目标的**后一个同级**
    After,
}

/// 一次树操作的结果：前端拿它就地更新列表 + 决定选中/进入编辑哪个节点
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeOpResult {
    /// 落盘后的整篇笔记（`updatedAt` 已被后端盖章）
    pub note: Note,
    /// 操作完该选中（新建时还要进入编辑）的节点 id
    pub focus_node_id: Option<String>,
    /// 这次删掉/影响了几个节点（整枝删除时是整枝的节点数，给 toast 用）
    pub removed: usize,
}

/// 闭包怎么告诉外面"该选中谁、删了几个"
#[derive(Debug, Default)]
struct Effect {
    focus: Option<String>,
    removed: usize,
}

// ─────────────────────────── 纯函数（不碰文件，可单独测） ───────────────────────────

/// 按 id 找节点（不可变）
pub fn find<'a>(node: &'a TreeNode, id: &str) -> Option<&'a TreeNode> {
    if node.id == id {
        return Some(node);
    }
    node.children.iter().find_map(|child| find(child, id))
}

/// 按 id 找节点（可变，改文字/折叠/图片用）
pub fn find_mut<'a>(node: &'a mut TreeNode, id: &str) -> Option<&'a mut TreeNode> {
    if node.id == id {
        return Some(node);
    }
    node.children
        .iter_mut()
        .find_map(|child| find_mut(child, id))
}

/// 节点的父节点 id（根节点返回 None）
pub fn parent_of(node: &TreeNode, id: &str) -> Option<String> {
    if node.children.iter().any(|child| child.id == id) {
        return Some(node.id.clone());
    }
    node.children
        .iter()
        .find_map(|child| parent_of(child, id))
}

/// 节点深度（根 = 0）；找不到返回 None。
///
/// 目前只有测试在用（布局的深度算在前端 `features/tree/layout.ts` 里），
/// 但它是 `move_node` 那类判断的天然搭档，留着比删掉好 —— 加 `allow` 说明白就行。
#[allow(dead_code)]
pub fn depth_of(node: &TreeNode, id: &str, depth: usize) -> Option<usize> {
    if node.id == id {
        return Some(depth);
    }
    node.children
        .iter()
        .find_map(|child| depth_of(child, id, depth + 1))
}

/// 整棵树的节点数（含自己）——"将删除 N 个节点"就是用它
pub fn count_nodes(node: &TreeNode) -> usize {
    1 + node.children.iter().map(count_nodes).sum::<usize>()
}

/// 节点是不是自己或自己的后代（防环用）
pub fn contains(node: &TreeNode, id: &str) -> bool {
    find(node, id).is_some()
}

/// 把节点从树上摘下来（连带整枝），返回它自己
fn detach(root: &mut TreeNode, id: &str) -> Option<TreeNode> {
    fn walk(node: &mut TreeNode, id: &str) -> Option<TreeNode> {
        if let Some(index) = node.children.iter().position(|child| child.id == id) {
            return Some(node.children.remove(index));
        }
        node.children.iter_mut().find_map(|child| walk(child, id))
    }
    walk(root, id)
}

/// 在 `parent_id` 下**追加**一个子节点，返回新节点 id
pub fn add_child(
    root: &mut TreeNode,
    parent_id: &str,
    text: Option<String>,
) -> Result<String, String> {
    let parent = find_mut(root, parent_id)
        .ok_or_else(|| format!("找不到这个节点了（可能刚被删掉）：{parent_id}"))?;

    let node = TreeNode::new(text.unwrap_or_else(|| DEFAULT_NODE_TEXT.to_string()));
    let id = node.id.clone();
    parent.children.push(node);
    // 新节点在折叠的分支里会"建了却看不见"，所以顺手把父节点展开
    parent.collapsed = false;
    Ok(id)
}

/// 在 `node_id` **后面**插一个同级节点，返回新节点 id
///
/// 根节点没有同级 → 报错（前端也会把 ⋮＋ 置灰，这里是不靠前端自觉的那道保证）。
pub fn add_sibling(
    root: &mut TreeNode,
    node_id: &str,
    text: Option<String>,
) -> Result<String, String> {
    if root.id == node_id {
        return Err("中心主题没有同级节点（用 ⊕ 给它加子节点）".to_string());
    }
    let parent_id = parent_of(root, node_id)
        .ok_or_else(|| format!("找不到这个节点了（可能刚被删掉）：{node_id}"))?;
    let parent = find_mut(root, &parent_id).ok_or_else(|| "父节点不见了".to_string())?;
    let index = parent
        .children
        .iter()
        .position(|child| child.id == node_id)
        .ok_or_else(|| "节点不在它父亲的孩子列表里（树结构坏了）".to_string())?;

    let node = TreeNode::new(text.unwrap_or_else(|| DEFAULT_NODE_TEXT.to_string()));
    let id = node.id.clone();
    parent.children.insert(index + 1, node);
    Ok(id)
}

/// 删掉节点和它的**整个分支**，返回删掉了几个节点
///
/// 根节点不能删（删了整棵树就没了）→ 报错。
pub fn remove_branch(root: &mut TreeNode, node_id: &str) -> Result<usize, String> {
    if root.id == node_id {
        return Err("中心主题不能删（它是整棵树的根）".to_string());
    }
    let removed = detach(root, node_id)
        .ok_or_else(|| format!("找不到这个节点了（可能刚被删掉）：{node_id}"))?;
    Ok(count_nodes(&removed))
}

/// 拖动调整层级或顺序（**不是改坐标**：坐标永远由自动布局算出来）。
///
/// 防环：目标是"自己或自己的后代"时直接报错 —— 否则会把子树接到自己的子树下面，
/// 那一枝会从树上整段消失（数据还在但再也看不到，等于丢）。
pub fn move_node(
    root: &mut TreeNode,
    node_id: &str,
    target_id: &str,
    position: DropPosition,
) -> Result<(), String> {
    if node_id == target_id {
        return Ok(()); // 拖到自己身上：什么都不做，别报错吓人
    }
    if root.id == node_id {
        return Err("中心主题不能挪走（它是整棵树的根）".to_string());
    }

    let moving = find(root, node_id)
        .ok_or_else(|| format!("找不到要移动的节点：{node_id}"))?;
    if contains(moving, target_id) {
        return Err("不能把节点放进它自己的分支里（那样这一枝会从树上消失）".to_string());
    }
    if find(root, target_id).is_none() {
        return Err(format!("找不到目标节点：{target_id}"));
    }

    // 先摘下来再插：摘完重新找位置，避免下标被"摘"这一步顶偏
    let detached = detach(root, node_id).ok_or_else(|| "节点不在树上".to_string())?;

    match position {
        DropPosition::Child => {
            let target = find_mut(root, target_id)
                .ok_or_else(|| "目标节点不见了".to_string())?;
            target.children.push(detached);
            target.collapsed = false;
        }
        DropPosition::Before | DropPosition::After => {
            if root.id == target_id {
                // 摘都摘了，得放回去再报错，否则这一枝就没了
                root.children.push(detached);
                return Err("不能和中心主题做同级（它是根）".to_string());
            }
            let parent_id = parent_of(root, target_id)
                .ok_or_else(|| "目标节点的父节点不见了".to_string())?;
            let parent = find_mut(root, &parent_id)
                .ok_or_else(|| "目标节点的父节点不见了".to_string())?;
            let index = parent
                .children
                .iter()
                .position(|child| child.id == target_id)
                .ok_or_else(|| "目标节点不在它父亲的孩子列表里".to_string())?;
            let at = if position == DropPosition::Before {
                index
            } else {
                index + 1
            };
            parent.children.insert(at, detached);
        }
    }
    Ok(())
}

/// 收集一棵树上所有节点 id（查重、防撞用）
fn collect_ids(node: &TreeNode, out: &mut Vec<String>) {
    out.push(node.id.clone());
    for child in &node.children {
        collect_ids(child, out);
    }
}

/// 把一个节点（连同整枝）插到指定父节点的指定位置。
///
/// 用途：**撤销「删掉整枝」**（用户反馈要 Ctrl+Z）—— 没有这个原语就只能
/// "整篇覆盖写回"，而那正是本模块开头说明要避开的东西。
///
/// 三条校验（宁可报错，也不把树弄坏）：
/// 1. 父节点必须存在；
/// 2. 子树的 id **不能和树上已有的 id 相撞** —— 撞了以后"按 id 找节点"会找错，
///    那是比报错严重得多的静默损坏；
/// 3. 子树**自己内部**也不能有重复 id。
///
/// `index` 超范围就夹到末尾：撤销的时候树可能已经被别处改过（比如又联动进来一个节点），
/// 夹一下比直接失败友好，也不会丢东西。
pub fn insert_at(
    root: &mut TreeNode,
    parent_id: &str,
    index: usize,
    subtree: TreeNode,
) -> Result<String, String> {
    let mut existing = Vec::new();
    collect_ids(root, &mut existing);

    let mut incoming = Vec::new();
    collect_ids(&subtree, &mut incoming);
    for id in &incoming {
        if existing.contains(id) {
            return Err(format!("这个节点已经在树上了（id 重复）：{id}"));
        }
    }
    for (position, id) in incoming.iter().enumerate() {
        if incoming[..position].contains(id) {
            return Err(format!("要插回来的这一枝自己内部有重复 id：{id}"));
        }
    }

    let parent =
        find_mut(root, parent_id).ok_or_else(|| format!("找不到要插到哪个节点下：{parent_id}"))?;
    let at = index.min(parent.children.len());
    let id = subtree.id.clone();
    parent.children.insert(at, subtree);
    parent.collapsed = false;
    Ok(id)
}

/// 改节点文字（允许空：界面会显示"（空节点）"，用户接着改就行）
pub fn set_text(root: &mut TreeNode, node_id: &str, text: &str) -> Result<(), String> {
    let node = find_mut(root, node_id)
        .ok_or_else(|| format!("找不到这个节点了（可能刚被删掉）：{node_id}"))?;
    node.text = text.to_string();
    Ok(())
}

/// 折叠 / 展开一条分支
pub fn set_collapsed(root: &mut TreeNode, node_id: &str, collapsed: bool) -> Result<(), String> {
    let node = find_mut(root, node_id)
        .ok_or_else(|| format!("找不到这个节点了（可能刚被删掉）：{node_id}"))?;
    if node.children.is_empty() {
        return Err("这个节点还没有子节点，没什么可折叠的".to_string());
    }
    node.collapsed = collapsed;
    Ok(())
}

/// 给节点插图片 / 去掉图片。
///
/// ⚠️ 传 `None` 只是**解除引用**，`assets/` 里的原文件一个字不动
/// （守「删除留后路」：用户可能只是不想在这张卡片上显示它）。
pub fn set_image(
    root: &mut TreeNode,
    node_id: &str,
    asset_path: Option<String>,
) -> Result<(), String> {
    let node = find_mut(root, node_id)
        .ok_or_else(|| format!("找不到这个节点了（可能刚被删掉）：{node_id}"))?;
    node.asset_path = asset_path.filter(|path| !path.trim().is_empty());
    Ok(())
}

// ─────────────────────────── 带盘的包装（读 → 改 → 原子写） ───────────────────────────

/// 所有 `note_tree_*` 命令的公共骨架：**读盘拿最新 → 改一处 → `note::save`（原子写）**。
///
/// 注意这里**不是**"用前端传来的树覆盖文件"，所以不可能抹掉别人刚写进去的节点。
fn edit<F>(store: &Store, note_id: &str, f: F) -> Result<TreeOpResult, String>
where
    F: FnOnce(&mut TreeNode) -> Result<Effect, String>,
{
    let mut note =
        note::get(store, note_id)?.ok_or_else(|| format!("笔记不存在：{note_id}"))?;
    if note.kind != NoteKind::Tree {
        return Err("这篇不是树状图笔记（只有树状图有节点树）".to_string());
    }

    // 没有根节点的树笔记是**坏文件**（正常流程走不到：`Note::new(Tree)` 一定建根，
    // `link_info` 也会补）。这里**不偷偷修**：一是不想在失败路径上还写盘，
    // 二是要让用户知道文件出过问题。前端看到这种笔记会显示「补上中心主题」按钮，
    // 那条路是 [`ensure_root_saved`]。
    let root = note
        .root
        .as_mut()
        .ok_or_else(|| "这篇笔记没有根节点（文件可能受损）——点画布上的「补上中心主题」".to_string())?;
    let effect = f(root)?;
    let saved = note::save(store, &note)?;

    Ok(TreeOpResult {
        note: saved,
        focus_node_id: effect.focus,
        removed: effect.removed,
    })
}

/// 补上丢失的根节点：`note_tree_ensure_root`
///
/// 正常流程走不到这里（`Note::new(Tree)` 一定会建根，`link_info` 也会兜底补）。
/// 这条是**自救**：万一文件被手改坏，或写到一半断电留下了没有 `root` 的树笔记，
/// 画布上会一个节点都没有 → 用户点哪儿都没反应，等于这篇笔记废了。
/// 前端打开这种笔记时显示「补上中心主题」，点它就调这条。
///
/// 幂等：已经有根就原样返回，不白写一次盘。
pub fn ensure_root_saved(store: &Store, note_id: &str) -> Result<Note, String> {
    let mut note =
        note::get(store, note_id)?.ok_or_else(|| format!("笔记不存在：{note_id}"))?;
    if note.kind != NoteKind::Tree {
        return Err("这篇不是树状图笔记（只有树状图有节点树）".to_string());
    }
    if note.root.is_some() {
        return Ok(note);
    }
    note.root = Some(TreeNode::new(ROOT_DEFAULT_TEXT));
    note::save(store, &note)
}

/// 加子节点：`note_tree_add_child`
/// 🔴 P0-1（2026-10-06）：把**正文里还没成为节点**的整行文字，补成根节点下的子节点。
///
/// # 为什么要有它（用户真机验收的现象）
/// 手机版**没有树编辑界面** —— 点开树笔记打开的是**文本页**，他打的字进的是 `content`；
/// 而电脑侧的树视图**只渲染 `root`** → 于是"树在、内容没了"（他那句"来看看 嗯?……"其实
/// 好好地躺在 `content` 里，一个字没丢）。
///
/// 这个函数把那些话**补进树**，让两边都看得见。三条底线：
/// 1. **幂等**：已经在树里的文字（任何节点、任意层级）不再重复添加 → 反复保存不会越长越多；
/// 2. **非破坏**：只往根节点**追加**，绝不改动/删除已有节点（他电脑上那棵 8 节点的树必须原样）；
/// 3. **操作式**：走 `add_child_saved` 逐个加（每次都读盘拿最新 + 原子写），不整篇覆盖。
///
/// 返回**新加了几个节点**（0 = 全都已经在树里了，什么都没动）。
pub fn append_text_saved(store: &Store, note_id: &str, text: &str) -> Result<usize, String> {
    let note = crate::store::note::get(store, note_id)?
        .ok_or_else(|| format!("笔记不存在：{note_id}"))?;
    if note.kind != crate::models::NoteKind::Tree {
        return Ok(0); // 不是树笔记 → 什么都不做（调用方也不必判）
    }
    let root_id = match note.root.as_ref() {
        Some(root) => root.id.clone(),
        None => {
            // 坏树（没有根）：先补一个「中心主题」，再往下走
            let fixed = ensure_root_saved(store, note_id)?;
            fixed
                .root
                .map(|r| r.id)
                .ok_or_else(|| "补根节点失败".to_string())?
        }
    };

    // 收集"树里现有的全部文字"（含所有层级）—— 用来做幂等判断
    let mut existing: std::collections::HashSet<String> = std::collections::HashSet::new();
    fn walk(node: &TreeNode, out: &mut std::collections::HashSet<String>) {
        out.insert(node.text.trim().to_string());
        for child in &node.children {
            walk(child, out);
        }
    }
    if let Some(root) = note.root.as_ref() {
        walk(root, &mut existing);
    }

    let mut added = 0usize;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if existing.contains(line) {
            continue; // 已经在树里（幂等）
        }
        add_child_saved(store, note_id, &root_id, Some(line.to_string()))?;
        existing.insert(line.to_string());
        added += 1;
    }
    Ok(added)
}

pub fn add_child_saved(
    store: &Store,
    note_id: &str,
    parent_id: &str,
    text: Option<String>,
) -> Result<TreeOpResult, String> {
    edit(store, note_id, |root| {
        let id = add_child(root, parent_id, text)?;
        Ok(Effect {
            focus: Some(id),
            removed: 0,
        })
    })
}

/// 加同级节点：`note_tree_add_sibling`
pub fn add_sibling_saved(
    store: &Store,
    note_id: &str,
    node_id: &str,
    text: Option<String>,
) -> Result<TreeOpResult, String> {
    edit(store, note_id, |root| {
        let id = add_sibling(root, node_id, text)?;
        Ok(Effect {
            focus: Some(id),
            removed: 0,
        })
    })
}

/// 删除节点（含整枝）：`note_tree_remove`
///
/// 删完该选中谁？**它的父节点**（用户视线本来就还在那一带，不会突然"什么都没选中"）。
///
/// # 🔴 树 B（2026-10-07）：删节点要**埋墓碑**（跟删待办/删笔记同一条规矩，见 `sync::bury`）
///
/// 不埋的后果：另一端手里那份旧树会在下次同步时把这些节点**原样传回来复活**
/// （"删了就是删了，得有痕迹"——《同步协议》§5.1 第 2 条）。
///
/// ⚠️ **整枝一起埋**（不是只埋被点的那个节点）：只埋父节点的话，子节点会因为在树上找不到父
/// 而被挂到根下面重新长出来（见 `sync_merge::merge_trees` 规则 §5"祖先链断了挂根"）。
pub fn remove_saved(store: &Store, note_id: &str, node_id: &str) -> Result<TreeOpResult, String> {
    // 先只看不动：把要删的这一枝的 id 都记下来（`edit` 里还会重读一次盘，这里只是"要埋哪些墓碑"）
    let doomed: Vec<String> = {
        let before =
            note::get(store, note_id)?.ok_or_else(|| format!("笔记不存在：{note_id}"))?;
        if before.kind != NoteKind::Tree {
            return Err("这篇不是树状图笔记（只有树状图有节点树）".to_string());
        }
        let root = before
            .root
            .as_ref()
            .ok_or_else(|| "这篇笔记没有根节点（文件可能受损）——点画布上的「补上中心主题」".to_string())?;
        let branch = find(root, node_id)
            .ok_or_else(|| format!("找不到这个节点了（可能刚被删掉）：{node_id}"))?;
        let mut ids = Vec::new();
        collect_ids(branch, &mut ids);
        ids
    };

    let result = edit(store, note_id, |root| {
        let parent = parent_of(root, node_id);
        let removed = remove_branch(root, node_id)?;
        Ok(Effect {
            focus: parent,
            removed,
        })
    })?;

    // ⚠️ **落盘成功之后**才埋：写盘失败就不该留下"删过"的痕迹（留了的话，这一枝在下次同步时
    //    会被当成"已删"真的抹掉）。
    // ⚠️ 埋墓碑失败**不该**让删除失败（树已经改了）→ 只留痕，跟 `todo::delete` 一个写法。
    for id in &doomed {
        if let Err(e) = sync::bury(store, id, KIND_TREE_NODE) {
            eprintln!("[东方摩耶堂] 树节点删除记录没写成功（{id}）：{e}");
        }
    }
    Ok(result)
}

/// 把一个节点（连同整枝）插回指定位置：`note_tree_insert`
///
/// 撤销「删掉整枝」用。校验规则见 [`insert_at`]。
///
/// 🔴 树 B：插回来时**墓碑要一起撤掉**（[`unbury_nodes`]）—— 删节点会埋墓碑，撤销却不抹痕迹的话，
/// 下次同步的逐节点合并会把刚插回来的一枝按墓碑又摘掉一次（用户看到的就是"撤销没用，东西还是没了"）。
pub fn insert_saved(
    store: &Store,
    note_id: &str,
    parent_id: &str,
    index: usize,
    subtree: TreeNode,
) -> Result<TreeOpResult, String> {
    // 先记下这一枝都有哪些 id（`subtree` 下一步就被插进树里了，拿不回来）
    let mut revived: Vec<String> = Vec::new();
    collect_ids(&subtree, &mut revived);

    let result = edit(store, note_id, |root| {
        let id = insert_at(root, parent_id, index, subtree)?;
        Ok(Effect {
            focus: Some(id),
            removed: 0,
        })
    })?;

    // ⚠️ 只有真的插进去了才撤墓碑；撤失败只留痕（树已经改好了，不该让整条撤销看起来失败）
    unbury_nodes(store, &revived);
    Ok(result)
}

/// 把一批节点的墓碑撤掉（"撤销删掉整枝"用）。
///
/// ⚠️ 只撤 `treenode` 这一族：别的族的墓碑（笔记/待办/档案）跟节点 id 不是一个空间，
/// 万一撞上也不该被这里抹掉。
fn unbury_nodes(store: &Store, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let mut file = match sync::load_graves(store) {
        Ok(one) => one,
        Err(e) => {
            eprintln!("[东方摩耶堂] 撤销删除时读不到删除记录（就不撤了）：{e}");
            return;
        }
    };
    let before = file.items.len();
    file.items
        .retain(|one| !(one.kind == KIND_TREE_NODE && ids.iter().any(|id| id == &one.id)));
    if file.items.len() == before {
        return; // 本来就没埋过 → 不白写一次盘
    }
    if let Err(e) = sync::save_graves(store, &file) {
        eprintln!("[东方摩耶堂] 撤销删除时没能抹掉删除记录：{e}");
    }
}

/// 拖动改层级/顺序：`note_tree_move`
pub fn move_saved(
    store: &Store,
    note_id: &str,
    node_id: &str,
    target_id: &str,
    position: DropPosition,
) -> Result<TreeOpResult, String> {
    edit(store, note_id, |root| {
        move_node(root, node_id, target_id, position)?;
        Ok(Effect {
            focus: Some(node_id.to_string()),
            removed: 0,
        })
    })
}

/// 改文字：`note_tree_set_text`
pub fn set_text_saved(
    store: &Store,
    note_id: &str,
    node_id: &str,
    text: String,
) -> Result<TreeOpResult, String> {
    edit(store, note_id, |root| {
        set_text(root, node_id, &text)?;
        Ok(Effect {
            focus: Some(node_id.to_string()),
            removed: 0,
        })
    })
}

/// 折叠/展开：`note_tree_set_collapsed`
pub fn set_collapsed_saved(
    store: &Store,
    note_id: &str,
    node_id: &str,
    collapsed: bool,
) -> Result<TreeOpResult, String> {
    edit(store, note_id, |root| {
        set_collapsed(root, node_id, collapsed)?;
        Ok(Effect {
            focus: Some(node_id.to_string()),
            removed: 0,
        })
    })
}

/// 插图片/去图片：`note_tree_set_image`
pub fn set_image_saved(
    store: &Store,
    note_id: &str,
    node_id: &str,
    asset_path: Option<String>,
) -> Result<TreeOpResult, String> {
    edit(store, note_id, |root| {
        set_image(root, node_id, asset_path)?;
        Ok(Effect {
            focus: Some(node_id.to_string()),
            removed: 0,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    /// 造一棵小树：中心主题 → [A → (A1, A2), B]
    fn sample() -> TreeNode {
        let mut root = TreeNode::new("中心主题");
        let mut a = TreeNode::new("A");
        a.children.push(TreeNode::new("A1"));
        a.children.push(TreeNode::new("A2"));
        root.children.push(a);
        root.children.push(TreeNode::new("B"));
        root
    }

    /// 按文字取节点 id（测试里比手写 uuid 好读）
    fn id_of(root: &TreeNode, text: &str) -> String {
        fn walk(node: &TreeNode, text: &str) -> Option<String> {
            if node.text == text {
                return Some(node.id.clone());
            }
            node.children.iter().find_map(|child| walk(child, text))
        }
        walk(root, text).unwrap_or_else(|| panic!("树里没有叫「{text}」的节点"))
    }

    #[test]
    fn 按文字找节点_id_能对上() {
        let root = sample();
        assert_eq!(find(&root, &id_of(&root, "A1")).unwrap().text, "A1");
        assert_eq!(count_nodes(&root), 5);
        assert_eq!(depth_of(&root, &id_of(&root, "A2"), 0), Some(2));
        assert_eq!(parent_of(&root, &id_of(&root, "A2")).unwrap(), id_of(&root, "A"));
        assert!(parent_of(&root, &root.id).is_none(), "根没有父节点");
    }

    #[test]
    fn 加子节点会追加到末尾并展开父节点() {
        let mut root = sample();
        let a = id_of(&root, "A");
        set_collapsed(&mut root, &a, true).unwrap();

        let new_id = add_child(&mut root, &a, Some("A3".into())).unwrap();
        let a_node = find(&root, &a).unwrap();
        assert_eq!(a_node.children.len(), 3, "追加到末尾");
        assert_eq!(a_node.children[2].id, new_id);
        assert_eq!(a_node.children[2].text, "A3");
        assert!(!a_node.collapsed, "建了却藏在折叠分支里会很困惑，所以顺手展开");
        assert!(a_node.children[2].source_info_id.is_none(), "手建的节点没有来源");
    }

    #[test]
    fn 不加文字时给默认名() {
        let mut root = sample();
        let root_id = root.id.clone();
        let id = add_child(&mut root, &root_id, None).unwrap();
        assert_eq!(find(&root, &id).unwrap().text, DEFAULT_NODE_TEXT);
    }

    #[test]
    fn 加同级是插在自己后面() {
        let mut root = sample();
        let a1 = id_of(&root, "A1");
        let new_id = add_sibling(&mut root, &a1, Some("A1.5".into())).unwrap();

        let a = id_of(&root, "A");
        let texts: Vec<&str> = find(&root, &a)
            .unwrap()
            .children
            .iter()
            .map(|child| child.text.as_str())
            .collect();
        assert_eq!(texts, vec!["A1", "A1.5", "A2"], "插在 A1 后面，不是插到 A2 后面");
        assert_eq!(find(&root, &new_id).unwrap().text, "A1.5");
    }

    #[test]
    fn 根节点没有同级() {
        let mut root = sample();
        let root_id = root.id.clone();
        let err = add_sibling(&mut root, &root_id, None).unwrap_err();
        assert!(err.contains("没有同级"), "要给人话：{err}");
    }

    #[test]
    fn 删整枝返回删了几个节点() {
        let mut root = sample();
        let a = id_of(&root, "A");
        let removed = remove_branch(&mut root, &a).unwrap();
        assert_eq!(removed, 3, "A + A1 + A2");
        assert_eq!(count_nodes(&root), 2, "只剩 中心主题 + B");
        assert!(find(&root, &a).is_none());
    }

    #[test]
    fn 中心主题不能删() {
        let mut root = sample();
        let root_id = root.id.clone();
        let err = remove_branch(&mut root, &root_id).unwrap_err();
        assert!(err.contains("不能删"), "要给人话：{err}");
        assert_eq!(count_nodes(&root), 5, "报错时树要原样不动");
    }

    #[test]
    fn 防环_不能把节点放进自己的分支里() {
        let mut root = sample();
        let a = id_of(&root, "A");
        let a1 = id_of(&root, "A1");

        // A → A1 里（A1 是 A 的后代）→ 必须拒绝
        let err = move_node(&mut root, &a, &a1, DropPosition::Child).unwrap_err();
        assert!(err.contains("自己的分支"), "要说明白为什么不行：{err}");

        assert_eq!(count_nodes(&root), 5, "被拒绝时一个节点都不能丢");
        assert!(find(&root, &a1).is_some(), "A1 还得在树上");
    }

    #[test]
    fn 拖到自己身上是无动作而不是报错() {
        let mut root = sample();
        let a = id_of(&root, "A");
        move_node(&mut root, &a, &a, DropPosition::After).unwrap();
        assert_eq!(count_nodes(&root), 5);
    }

    #[test]
    fn 拖动改层级() {
        let mut root = sample();
        let b = id_of(&root, "B");
        let a1 = id_of(&root, "A1");

        move_node(&mut root, &b, &a1, DropPosition::Child).unwrap();
        assert_eq!(count_nodes(&root), 5, "只是换个位置，不能多也不能少");
        assert_eq!(parent_of(&root, &b).unwrap(), a1, "B 现在挂在 A1 下面");
    }

    #[test]
    fn 拖动改顺序() {
        let mut root = sample();
        let b = id_of(&root, "B");
        let a = id_of(&root, "A");

        // B 拖到 A 前面
        move_node(&mut root, &b, &a, DropPosition::Before).unwrap();
        let order: Vec<&str> = root
            .children
            .iter()
            .map(|child| child.text.as_str())
            .collect();
        assert_eq!(order, vec!["B", "A"]);

        // 再拖到 A 后面 → 回到原样（顺序调整要能来回）
        move_node(&mut root, &b, &a, DropPosition::After).unwrap();
        let order: Vec<&str> = root
            .children
            .iter()
            .map(|child| child.text.as_str())
            .collect();
        assert_eq!(order, vec!["A", "B"]);
        assert_eq!(count_nodes(&root), 5);
    }

    #[test]
    fn 不能和中心主题做同级() {
        let mut root = sample();
        let b = id_of(&root, "B");
        let root_id = root.id.clone();
        let err = move_node(&mut root, &b, &root_id, DropPosition::Before).unwrap_err();
        assert!(err.contains("根"), "实际：{err}");
        // ⚠️ 报错路径也必须把摘下来的枝还回去，否则这一枝就凭空消失了
        assert_eq!(count_nodes(&root), 5, "报错时不能把节点弄丢");
        assert!(find(&root, &b).is_some());
    }

    #[test]
    fn 中心主题不能挪走() {
        let mut root = sample();
        let a = id_of(&root, "A");
        let root_id = root.id.clone();
        let err = move_node(&mut root, &root_id, &a, DropPosition::Child).unwrap_err();
        assert!(err.contains("不能挪走"), "实际：{err}");
        assert_eq!(count_nodes(&root), 5);
    }

    #[test]
    fn 改文字与空文字() {
        let mut root = sample();
        let a = id_of(&root, "A");
        set_text(&mut root, &a, "改过的 A").unwrap();
        assert_eq!(find(&root, &a).unwrap().text, "改过的 A");

        set_text(&mut root, &a, "").unwrap();
        assert_eq!(find(&root, &a).unwrap().text, "", "允许清空，界面自己显示占位");
    }

    #[test]
    fn 没子节点的节点没什么可折叠() {
        let mut root = sample();
        let b = id_of(&root, "B");
        let err = set_collapsed(&mut root, &b, true).unwrap_err();
        assert!(err.contains("没什么可折叠"), "实际：{err}");

        let a = id_of(&root, "A");
        set_collapsed(&mut root, &a, true).unwrap();
        assert!(find(&root, &a).unwrap().collapsed);
    }

    #[test]
    fn 图片可以设置也可以清掉且不碰_assets() {
        let mut root = sample();
        let a = id_of(&root, "A");
        set_image(&mut root, &a, Some("assets/x.png".into())).unwrap();
        assert_eq!(
            find(&root, &a).unwrap().asset_path.as_deref(),
            Some("assets/x.png")
        );

        set_image(&mut root, &a, None).unwrap();
        assert!(find(&root, &a).unwrap().asset_path.is_none());

        // 空字符串等于清掉（前端可能传空串）
        set_image(&mut root, &a, Some("   ".into())).unwrap();
        assert!(find(&root, &a).unwrap().asset_path.is_none());
    }

    #[test]
    fn 找不到节点时报人话() {
        let mut root = sample();
        let err = add_child(&mut root, "不存在的 id", None).unwrap_err();
        assert!(err.contains("找不到"), "实际：{err}");
        let err = remove_branch(&mut root, "不存在的 id").unwrap_err();
        assert!(err.contains("找不到"), "实际：{err}");
    }

    // ───────── 带盘的（走 atomic，顺便验"读最新→改→原子写"这条链） ─────────

    #[test]
    fn 命令级_加节点落盘且焦点给的是新节点() {
        let store = temp_store("tree-add");
        let note = note::create(&store, NoteKind::Tree, "知识树".into()).unwrap();
        let root_id = note.root.as_ref().unwrap().id.clone();

        let result = add_child_saved(&store, &note.id, &root_id, Some("第一条".into())).unwrap();
        assert_eq!(result.removed, 0);

        let focus = result.focus_node_id.expect("新建要告诉前端选中谁");
        let stored = note::get(&store, &note.id).unwrap().unwrap();
        let root = stored.root.as_ref().unwrap();
        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].id, focus, "返回的焦点就是落盘的那个节点");

        // 真的走的是原子写：上一版 .bak 得在
        let path = note::note_path(&store, &note.id);
        assert!(crate::store::atomic::bak_path(&path).is_file(), "要有上一版备份");
    }

    #[test]
    fn 命令级_删整枝会报删了几个并且焦点回父节点() {
        let store = temp_store("tree-remove");
        let note = note::create(&store, NoteKind::Tree, "树".into()).unwrap();
        let root_id = note.root.as_ref().unwrap().id.clone();
        let a = add_child_saved(&store, &note.id, &root_id, Some("A".into())).unwrap();
        let a_id = a.focus_node_id.unwrap();
        let a1 = add_child_saved(&store, &note.id, &a_id, Some("A1".into())).unwrap();
        assert_eq!(a1.removed, 0);

        let removed = remove_saved(&store, &note.id, &a_id).unwrap();
        assert_eq!(removed.removed, 2, "A 连同 A1 一起走");
        assert_eq!(removed.focus_node_id.as_deref(), Some(root_id.as_str()), "焦点回父节点");

        let stored = note::get(&store, &note.id).unwrap().unwrap();
        assert!(stored.root.as_ref().unwrap().children.is_empty());
    }

    #[test]
    fn 命令级_一次操作不会抹掉别人刚写进去的节点() {
        // 这条就是"为什么不用整篇覆盖"的回归：模拟"联动进来一个节点"之后，
        // 前端手里的旧树已经不是最新的了，但操作式命令读的是盘上的最新版。
        let store = temp_store("tree-race");
        let note = note::create(&store, NoteKind::Tree, "树".into()).unwrap();
        let root_id = note.root.as_ref().unwrap().id.clone();
        let stale = note.clone(); // 前端手里那份（还没有联动节点）

        // 后端往树里塞了一个联动节点（note::link_info 走的就是这条路）
        let mut info = crate::models::Info {
            id: "info-x".into(),
            kind: crate::models::InfoKind::Text,
            text: "联动进来的想法".into(),
            asset_path: None,
            created_at: crate::models::now_iso(),
            updated_at: crate::models::now_iso(),
            categories: Vec::new(),
            status: crate::models::InfoStatus::Pending,
            links: Vec::new(),
        };
        info.status = crate::models::InfoStatus::Linked;
        note::link_info(&store, &note.id, &info).unwrap();

        // 用户在前端（拿着旧树）点了一下"加子节点"
        add_child_saved(&store, &stale.id, &root_id, Some("用户新建的".into())).unwrap();

        let stored = note::get(&store, &note.id).unwrap().unwrap();
        let texts: Vec<&str> = stored
            .root
            .as_ref()
            .unwrap()
            .children
            .iter()
            .map(|child| child.text.as_str())
            .collect();
        assert!(texts.contains(&"联动进来的想法"), "联动节点不能被抹掉：{texts:?}");
        assert!(texts.contains(&"用户新建的"), "用户的节点也得在：{texts:?}");
    }

    #[test]
    fn 命令级_不是树状图笔记会报错() {
        let store = temp_store("tree-wrong-kind");
        let doc = note::create(&store, NoteKind::Doc, "文本笔记".into()).unwrap();
        let err = add_child_saved(&store, &doc.id, "任意", None).unwrap_err();
        assert!(err.contains("不是树状图"), "实际：{err}");
    }

    #[test]
    fn 命令级_老文件缺_root_时报人话且能自救() {
        let store = temp_store("tree-no-root");
        let mut note = note::create(&store, NoteKind::Tree, "空树".into()).unwrap();
        note.root = None;
        note::save(&store, &note).unwrap();

        // 操作式命令遇到坏文件要报人话，而不是默默在失败路径上写盘
        let err = add_child_saved(&store, &note.id, "随便", None).unwrap_err();
        assert!(err.contains("没有根节点"), "实际：{err}");

        // 自救：补一个中心主题并落盘
        let fixed = ensure_root_saved(&store, &note.id).unwrap();
        let root = fixed.root.as_ref().expect("根要被补出来");
        assert_eq!(root.text, ROOT_DEFAULT_TEXT);
        assert!(note::get(&store, &note.id).unwrap().unwrap().root.is_some());

        // 幂等：已经有根就不该再建一个（否则每次调用都会多一个根）
        let again = ensure_root_saved(&store, &note.id).unwrap();
        assert_eq!(again.root.as_ref().unwrap().id, root.id);
    }

    #[test]
    fn 插回整枝能还原删除前的位置() {
        let mut root = sample();
        let a = id_of(&root, "A");
        let removed = detach(&mut root, &a).unwrap();
        assert_eq!(count_nodes(&root), 2);

        // 插回原位置（中心主题的第 0 个孩子）
        let root_id = root.id.clone();
        let id = insert_at(&mut root, &root_id, 0, removed).unwrap();
        assert_eq!(id, a);
        assert_eq!(count_nodes(&root), 5, "整枝都回来了");
        let texts: Vec<&str> = root
            .children
            .iter()
            .map(|child| child.text.as_str())
            .collect();
        assert_eq!(texts, vec!["A", "B"], "插回原来的次序");
        assert!(find(&root, &id_of(&root, "A2")).is_some(), "后代一个不少");
    }

    #[test]
    fn 插回整枝_index_超范围就夹到末尾() {
        let mut root = sample();
        let a = id_of(&root, "A");
        let removed = detach(&mut root, &a).unwrap();
        let root_id = root.id.clone();
        insert_at(&mut root, &root_id, 999, removed).unwrap();
        let texts: Vec<&str> = root
            .children
            .iter()
            .map(|child| child.text.as_str())
            .collect();
        assert_eq!(texts, vec!["B", "A"], "夹到末尾而不是报错");
        assert_eq!(count_nodes(&root), 5);
    }

    #[test]
    fn 插回整枝拒绝_id_相撞() {
        // id 撞了以后"按 id 找节点"会找错 —— 宁可报错也不能插
        let mut root = sample();
        let a = id_of(&root, "A");
        let dup = find(&root, &a).unwrap().clone();
        let root_id = root.id.clone();
        let err = insert_at(&mut root, &root_id, 0, dup).unwrap_err();
        assert!(err.contains("已经在树上"), "实际：{err}");
        assert_eq!(count_nodes(&root), 5, "报错时树要原样不动");
    }

    #[test]
    fn 插回整枝拒绝子树内部重复_id() {
        let mut root = sample();
        let mut bad = TreeNode::new("坏的");
        let same = TreeNode::new("重复");
        bad.children.push(same.clone());
        bad.children.push(same);
        let root_id = root.id.clone();
        let err = insert_at(&mut root, &root_id, 0, bad).unwrap_err();
        assert!(err.contains("重复 id"), "实际：{err}");
    }

    #[test]
    fn 插回整枝时父节点找不到要报人话() {
        let mut root = sample();
        let a = id_of(&root, "A");
        let removed = detach(&mut root, &a).unwrap();
        let err = insert_at(&mut root, "不存在的父节点", 0, removed).unwrap_err();
        assert!(err.contains("找不到要插到哪个节点下"), "实际：{err}");
    }

    #[test]
    fn 命令级_删掉再插回来等于没删() {
        let store = temp_store("tree-undo-remove");
        let note = note::create(&store, NoteKind::Tree, "撤销用".into()).unwrap();
        let root_id = note.root.as_ref().unwrap().id.clone();
        let a = add_child_saved(&store, &note.id, &root_id, Some("A".into())).unwrap();
        let a_id = a.focus_node_id.clone().unwrap();
        add_child_saved(&store, &note.id, &a_id, Some("A1".into())).unwrap();

        let before = note::get(&store, &note.id).unwrap().unwrap().root.unwrap();
        // 记下"删什么、从哪儿删"
        let parent = parent_of(&before, &a_id).unwrap();
        let index = find(&before, &parent)
            .unwrap()
            .children
            .iter()
            .position(|child| child.id == a_id)
            .unwrap();
        let branch = find(&before, &a_id).unwrap().clone();

        let after_remove = remove_saved(&store, &note.id, &a_id).unwrap();
        assert_eq!(after_remove.removed, 2);

        let restored = insert_saved(&store, &note.id, &parent, index, branch).unwrap();
        assert_eq!(restored.focus_node_id.as_deref(), Some(a_id.as_str()));
        let after = note::get(&store, &note.id).unwrap().unwrap().root.unwrap();
        assert_eq!(
            serde_json::to_string(&before).unwrap(),
            serde_json::to_string(&after).unwrap(),
            "删掉再插回来，树应该和原来一模一样"
        );
    }

    #[test]
    fn 命令级_拖拽走盘后层级真的变了() {
        let store = temp_store("tree-move");
        let note = note::create(&store, NoteKind::Tree, "树".into()).unwrap();
        let root_id = note.root.as_ref().unwrap().id.clone();
        let a = add_child_saved(&store, &note.id, &root_id, Some("A".into())).unwrap();
        let a_id = a.focus_node_id.unwrap();
        let b = add_child_saved(&store, &note.id, &root_id, Some("B".into())).unwrap();
        let b_id = b.focus_node_id.unwrap();

        move_saved(&store, &note.id, &b_id, &a_id, DropPosition::Child).unwrap();

        let stored = note::get(&store, &note.id).unwrap().unwrap();
        let root = stored.root.as_ref().unwrap();
        assert_eq!(root.children.len(), 1, "B 挪到 A 下面了");
        assert_eq!(root.children[0].children[0].id, b_id);
    }
}


/// 🔴 P0-1（2026-10-06）：手机在**文本页**写的树笔记正文 → 补成树节点。
#[cfg(test)]
mod p01_append_tests {
    use super::*;
    use crate::models::NoteKind;
    use crate::store::temp_store;

    fn root_id(store: &Store, id: &str) -> String {
        crate::store::note::get(store, id)
            .unwrap()
            .unwrap()
            .root
            .unwrap()
            .id
    }

    #[test]
    fn 正文补成节点_幂等且不动已有节点() {
        let store = temp_store("p01-append");
        let note = crate::store::note::create(&store, NoteKind::Tree, "树".into()).unwrap();
        let mut base = note.clone();
        base.root = Some(TreeNode::new("中心主题"));
        crate::store::note::save(&store, &base).unwrap();
        let rid = root_id(&store, &note.id);
        add_child_saved(&store, &note.id, &rid, Some("原有节点".into())).unwrap();

        // 手机上在文本页写了这些（含空行、含一行"已经在树里"的）
        let added = append_text_saved(&store, &note.id, "第一行\n\n第二行  \n原有节点").unwrap();
        assert_eq!(added, 2, "只该补两行：空行跳过、已在树里的不重复");

        let after = crate::store::note::get(&store, &note.id).unwrap().unwrap();
        let texts: Vec<String> = after
            .root
            .as_ref()
            .unwrap()
            .children
            .iter()
            .map(|n| n.text.clone())
            .collect();
        assert!(texts.contains(&"原有节点".to_string()), "已有节点不许被动：{texts:?}");
        assert!(
            texts.contains(&"第一行".to_string()) && texts.contains(&"第二行".to_string()),
            "两行都该进树：{texts:?}"
        );

        // 再存一次同样的正文 → 一个都不加（幂等，反复保存不会越长越多）
        let again = append_text_saved(&store, &note.id, "第一行\n第二行\n原有节点\n").unwrap();
        assert_eq!(again, 0, "幂等失败：重复保存又加了一遍");
    }
}
