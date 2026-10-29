//! 合并引擎 · **纯逻辑**（M23 / v2.13.0）
//!
//! # 这是《同步协议》§5 的可执行版本
//! 电脑与手机**共用这一份代码**（Tauri 的 Rust 核心两端同一份）：规则只写一次、单测只写一遍。
//!
//! ## 三条总原则（协议 §5.1）
//! 1. **谁最后改的听谁的** —— 同一条两边都有 → 比 `updatedAt`，新的**整条赢**（不做字段缝合）。
//! 2. **删除也算一条记录** —— 墓碑（`sync/graves.json`）一起参与同步，防止"删了又被传回来复活"。
//! 3. **分不清就不猜** —— 判不出来（同一分钟都改过 / 删了又被改过）→ **两份都留**：
//!    胜出的那份照常落盘，另一份**存成副本**（标题后加「（冲突副本）」），完成后提示用户。
//!
//! ## 时钟容差（协议 §5.4）
//! 两台设备的钟可能差几分钟：**差在 [`CLOCK_TOLERANCE_SECONDS`]（2 分钟）以内视为"同时改"** →
//! 走"两份都留"，**不硬判谁赢**（宁可多一份副本，绝不悄悄吞掉一次改动）。
//!
//! ## 逐文件规则（协议 §5.2）
//! - **互传**：`todo` / `reminder` / `note` / `daily` / `annotation`
//! - **只进不出**：[`ONLY_IN_KINDS`]（信息 / **格言 / 档案库 / 倒计时**）——
//!   只接受"对方没有的新 id"；两边都有同一条 → **一律不动**（记进 `skipped_only_in` 报告给用户）
//! - 🔴 **奖状是例外（2026-10-21 用户拍板）**：两边都有 → **按 `updatedAt` 取新**（不做冲突副本），
//!   **删除也跨端**（埋墓碑）。原因：用户改了奖状的图与寄语，手机一直拿不到。
//! - **不传**：`config` / `assets` / `backups`（引擎里根本不生成这些 kind）
//!
//! ⚠️ **纯逻辑**：这个文件**不碰磁盘**（`collect`/`apply` 在 `sync_apply.rs`）——
//! 这样合并规则可以用几十条单测钉死，而不必造真实数据目录。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::models::{now_iso, TreeNode};
use crate::store::assets::AssetMeta;
use crate::store::sync::{self, Grave, CLOCK_TOLERANCE_SECONDS};

/// 记录种类（协议 §5.2 的"逐文件规则"）
pub const KIND_TODO: &str = "todo";
pub const KIND_REMINDER: &str = "reminder";
pub const KIND_NOTE: &str = "note";
pub const KIND_DAILY: &str = "daily";
pub const KIND_ANNOTATION: &str = "annotation";
pub const KIND_INFO: &str = "info";
pub const KIND_AWARD: &str = "award";
pub const KIND_MOTTO: &str = "motto";
pub const KIND_ARCHIVE: &str = "archive";
pub const KIND_COUNTDOWN: &str = "countdown";
/// **树节点**（树 B）：树笔记里的一个节点被删掉时，墓碑的 `kind` 就用它。
///
/// 为什么节点也要单独一个 kind（不能借 `note`）：墓碑文件里只有 `id + kind + deletedAt`，
/// 而节点 id 与笔记 id 不是同一个空间 —— 混在一起的话，"删掉某篇笔记"会顺带把 id 撞上的
/// 那个节点也判成已删（进而把别人的树枝摘掉）。
pub const KIND_TREE_NODE: &str = "treenode";

/// 保留这个常量只是为了让旧调用与测试能明确看到：**现在没有只进不出的族**。
pub const ONLY_IN_KINDS: [&str; 0] = [];

/// 这几族都按 `updatedAt` 整条取新；不做冲突副本，也不传播删除。
pub const LAST_WRITE_WINS_KINDS: [&str; 5] = [
    KIND_INFO,
    KIND_AWARD,
    KIND_MOTTO,
    KIND_ARCHIVE,
    KIND_COUNTDOWN,
];

/// 冲突副本的标题后缀（协议 §5.1 第 3 条，用户界面上要能一眼认出来）
pub const COPY_SUFFIX: &str = "（冲突副本）";

/// 一条**可同步的记录**：身份 + 改动时间 + 原始 JSON（整条赢 → 直接换整份 JSON）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rec {
    pub kind: String,
    pub id: String,
    pub updated_at: String,
    pub json: serde_json::Value,
}

/// 清单里的一条（**只带身份与时间，不带内容** —— 比对只用这些，省流量）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub kind: String,
    pub id: String,
    pub updated_at: String,
}

/// 墓碑的传输形态（跟 `sync::Grave` 同形，但独立定义 → 协议字段名稳）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraveMeta {
    pub id: String,
    pub kind: String,
    pub deleted_at: String,
}

impl From<&Grave> for GraveMeta {
    fn from(one: &Grave) -> Self {
        GraveMeta {
            id: one.id.clone(),
            kind: one.kind.clone(),
            deleted_at: one.deleted_at.clone(),
        }
    }
}

/// 一端的清单（第一轮交换的就是它）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub device: String,
    pub protocol: u32,
    pub entries: Vec<Entry>,
    pub graves: Vec<GraveMeta>,
}

/// 一次冲突（两份都留 → 报告里要能说清"是哪条、两边各是什么时间"）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub kind: String,
    /// `same_moment`（同一分钟内都改过）｜`deleted_but_modified`（一边删了、另一边后来改过）
    pub reason: String,
    pub mine_at: String,
    pub theirs_at: String,
    /// 副本的标题（给人看的）
    pub title: String,
}

/// 合并计划（**纯数据**，给 `sync_apply` 去执行）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// 我要采纳**对方**的记录（去拉这些 id 的内容）
    pub take_theirs: Vec<String>,
    /// 我要把**我这边的**记录给对方（对方来拉这些 id）
    pub send_mine: Vec<String>,
    /// 冲突（两份都留；副本由"输的那一端"或"改动较新的那一端"生成，见 `apply_plan`）
    pub conflicts: Vec<Conflict>,
    /// 我要落地的删除（对方的墓碑 / 我该跟着删的）
    pub apply_graves: Vec<GraveMeta>,
    /// 对方该落地的删除（我的墓碑）
    pub send_graves: Vec<GraveMeta>,
    /// 「只进不出」的族里、两边都有同一条 → 忽略（只报告，绝不动）
    pub skipped_only_in: Vec<String>,
}

#[allow(dead_code)] // 账单口径：测试与 M23 界面路径都用它，留着是为了"账单"只有一个算法
impl Plan {
    /// 这次一共动了多少项（给"账单"用）
    pub fn moved(&self) -> usize {
        self.take_theirs.len() + self.send_mine.len() + self.apply_graves.len() + self.conflicts.len()
    }
    pub fn is_empty(&self) -> bool {
        self.moved() == 0 && self.send_graves.is_empty()
    }
}

fn only_in(kind: &str) -> bool {
    ONLY_IN_KINDS.iter().any(|one| *one == kind)
}

fn last_write_wins(kind: &str) -> bool {
    LAST_WRITE_WINS_KINDS.iter().any(|one| *one == kind)
}

fn delete_cross_device(kind: &str) -> bool {
    !last_write_wins(kind) || kind == KIND_AWARD
}

/// 同一条两边都改过 → 是不是"分不清"（时钟容差内的算同时改）
pub fn indistinguishable(mine_at: &str, theirs_at: &str) -> bool {
    sync::same_moment(mine_at, theirs_at)
}

/// 我的墓碑是不是"盖得住"对方的这条记录（记录的时间 ≤ 删除时间 → 删除生效）
pub fn grave_covers(grave_at: &str, record_at: &str) -> bool {
    match (sync::parse_at(grave_at), sync::parse_at(record_at)) {
        (Some(g), Some(r)) => {
            // 记录时间**在删除之后**（超过容差）→ 盖不住（用户删完又改过）
            r <= g + chrono::Duration::seconds(CLOCK_TOLERANCE_SECONDS)
        }
        // 时间读不出来 → **不硬判**：当成"盖不住"（走冲突、留副本），绝不静默删掉对方的内容
        _ => false,
    }
}

fn entry_of(rec: &Rec) -> Entry {
    Entry {
        kind: rec.kind.clone(),
        id: rec.id.clone(),
        updated_at: rec.updated_at.clone(),
    }
}

/// 由记录列表生成清单
pub fn manifest_of(device: &str, mine: &[Rec], graves: &[Grave], protocol: u32) -> Manifest {
    let mut entries: Vec<Entry> = mine.iter().map(entry_of).collect();
    entries.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.id.cmp(&b.id)));
    let mut gs: Vec<GraveMeta> = graves.iter().map(GraveMeta::from).collect();
    gs.sort_by(|a, b| a.id.cmp(&b.id));
    Manifest {
        device: device.to_string(),
        protocol,
        entries,
        graves: gs,
    }
}

/// 从清单里找一条
fn find<'a>(list: &'a [Entry], kind: &str, id: &str) -> Option<&'a Entry> {
    list.iter().find(|one| one.kind == kind && one.id == id)
}

fn find_grave<'a>(list: &'a [GraveMeta], id: &str) -> Option<&'a GraveMeta> {
    list.iter().find(|one| one.id == id)
}

/// **核心**：拿两边的清单与墓碑，算出这次该怎么办（纯函数，无 IO）
///
/// `title_of` 用来给冲突副本起标题（找不到标题就用 id 兜底）—— 传进来是为了让这个函数保持纯粹。
pub fn plan_with<F>(
    mine: &[Entry],
    theirs: &[Entry],
    mine_graves: &[GraveMeta],
    theirs_graves: &[GraveMeta],
    // **上次同步时间**（`sync/state.json`）：两边都没在这之后改过 → 这条**什么都不用做**。
    // 没有它就会出现"每次同步都给同一条生成一份冲突副本"的荒唐事（2026-10-06 实测撞到）。
    since: Option<&str>,
    title_of: F,
) -> Plan
where
    F: Fn(&str, &str) -> String,
{
    let mut out = Plan::default();

    // ── 1) 记录 × 记录（以"我这边的清单"为主轴，再补上"对方独有的"）
    let mut keys: Vec<(String, String)> = Vec::new();
    for one in mine {
        keys.push((one.kind.clone(), one.id.clone()));
    }
    for one in theirs {
        let key = (one.kind.clone(), one.id.clone());
        if !keys.contains(&key) {
            keys.push(key);
        }
    }

    for (kind, id) in keys {
        let m = find(mine, &kind, &id);
        let t = find(theirs, &kind, &id);
        let gm = find_grave(mine_graves, &id);
        let gt = find_grave(theirs_graves, &id);

        match (m, t) {
            // 两边都有
            (Some(m), Some(t)) => {
                // 信息 / 奖状 / 格言 / 档案 / 倒计时：**时间新的整条赢、时间一样什么都不做**。
                // 这几族都不做冲突副本；用户要的是"电脑改的，手机也能拿到"，不是滚出一堆重复卡。
                if last_write_wins(&kind) {
                    if sync::strictly_newer(&t.updated_at, &m.updated_at) {
                        out.take_theirs.push(id);
                    } else if sync::strictly_newer(&m.updated_at, &t.updated_at) {
                        out.send_mine.push(id);
                    }
                    continue;
                }
                if only_in(&kind) {
                    // 只进不出：两边都有 → 一律不动（只报告）
                    out.skipped_only_in.push(id);
                    continue;
                }
                // 🔴 关键闸门：**两边都没在上次同步之后改过 → 这条什么都不用做**
                //    （否则"同一条同步过的记录"每次都会因时间相同被判成冲突 → 每次多一份副本）
                // 🔴 2026-10-06 修（P0-1 连带）：这里**必须用 `strictly_newer`（不容差）**。
                //    原来用 `newer_wins` → 它把"差 2 分钟内"一律当"没更新" →
                //    「上次同步后 2 分钟内改的记录」会被判成"没改过" → 那条**永远同步不出去**
                //    （端到端测试实测：账单"补过来 0 / 传过去 0"，改动石沉大海）。
                let untouched = matches!(since, Some(s)
                    if !sync::strictly_newer(&m.updated_at, s) && !sync::strictly_newer(&t.updated_at, s));
                if untouched {
                    continue;
                }
                if indistinguishable(&m.updated_at, &t.updated_at) {
                    out.conflicts.push(Conflict {
                        id: id.clone(),
                        kind: kind.clone(),
                        reason: "same_moment".into(),
                        mine_at: m.updated_at.clone(),
                        theirs_at: t.updated_at.clone(),
                        title: title_of(&kind, &id),
                    });
                }
                // ⚠️ `sync::newer_wins(mine, theirs)` 的语义是「**我这版**更新（我赢）」——
                //    参数顺序别弄反（2026-10-06 我第一版就反了，被 4 条单测逮住）。
                else if sync::newer_wins(&t.updated_at, &m.updated_at) {
                    out.take_theirs.push(id); // 对方更新 → 我采纳对方
                } else if sync::newer_wins(&m.updated_at, &t.updated_at) {
                    out.send_mine.push(id); // 我更新 → 对方采纳我
                } else {
                    // 两边判不出来（时间读不出来 / 完全相等但容差判定没覆盖到）→ **不猜，留副本**
                    out.conflicts.push(Conflict {
                        id: id.clone(),
                        kind: kind.clone(),
                        reason: "same_moment".into(),
                        mine_at: m.updated_at.clone(),
                        theirs_at: t.updated_at.clone(),
                        title: title_of(&kind, &id),
                    });
                }
            }
            // 只有我有
            (Some(m), None) => match gt {
                Some(g) if delete_cross_device(&kind) => {
                    if grave_covers(&g.deleted_at, &m.updated_at) {
                        // 对方删了、我这边没改过 → 删除生效（我跟着删）
                        out.apply_graves.push(g.clone());
                    } else {
                        // 对方删了、但我**后来改过** → 不猜：留副本 + 删除照样生效
                        out.conflicts.push(Conflict {
                            id: id.clone(),
                            kind: kind.clone(),
                            reason: "deleted_but_modified".into(),
                            mine_at: m.updated_at.clone(),
                            theirs_at: g.deleted_at.clone(),
                            title: title_of(&kind, &id),
                        });
                        out.apply_graves.push(g.clone());
                    }
                }
                // 对方没有那条墓碑（他那儿也没有这条）→ 传给他
                _ => out.send_mine.push(id),
            },
            // 只有对方有
            (None, Some(t)) => match gm {
                Some(g) if delete_cross_device(&kind) => {
                    if grave_covers(&g.deleted_at, &t.updated_at) {
                        // 我删了、对方没改过 → 让他也删
                        out.send_graves.push(g.clone());
                    } else {
                        // 我删了、对方后来改过 → 不猜：留副本 + 我的删除照样生效
                        out.conflicts.push(Conflict {
                            id: id.clone(),
                            kind: kind.clone(),
                            reason: "deleted_but_modified".into(),
                            mine_at: g.deleted_at.clone(),
                            theirs_at: t.updated_at.clone(),
                            title: title_of(&kind, &id),
                        });
                        out.send_graves.push(g.clone());
                    }
                }
                // 我这边没有墓碑 → 采纳对方的（只进不出的族也只接受"我没有的新 id"✓）
                _ => out.take_theirs.push(id),
            },
            (None, None) => {}
        }
    }

    // ── 2) 墓碑 × 墓碑（对方有、我没有 → 我也记一条；这样"删了的东西"以后不会再被谁传回来）
    for g in theirs_graves {
        if !delete_cross_device(&g.kind) {
            continue; // 信息 / 格言 / 档案 / 倒计时本轮只开启"改"，删除仍不互传
        }
        if find_grave(mine_graves, &g.id).is_none() {
            out.apply_graves.push(g.clone());
        }
    }
    for g in mine_graves {
        if !delete_cross_device(&g.kind) {
            continue;
        }
        if find_grave(theirs_graves, &g.id).is_none() && !out.send_graves.iter().any(|one| one.id == g.id) {
            out.send_graves.push(g.clone());
        }
    }

    // 去重（同一 id 可能既在"我该删"里又被别处提到）
    dedup(&mut out.take_theirs);
    dedup(&mut out.send_mine);
    dedup(&mut out.skipped_only_in);
    out.apply_graves.sort_by(|a, b| a.id.cmp(&b.id));
    out.apply_graves.dedup_by(|a, b| a.id == b.id);
    out.send_graves.sort_by(|a, b| a.id.cmp(&b.id));
    out.send_graves.dedup_by(|a, b| a.id == b.id);
    out.conflicts.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn dedup(list: &mut Vec<String>) {
    list.sort();
    list.dedup();
}

/// 便捷版：直接拿记录与本机标题
///
/// ⚠️ 生产路径（`sync_apply`）走的是 `plan_with`（要传"本机标题"闭包）；这个包装留给测试与
/// 后续"客户端补算"用，现在只有测试调它 —— 别按"没人用"删掉。
#[allow(dead_code)]
pub fn plan(mine: &[Rec], theirs: &[Rec], mine_graves: &[Grave], theirs_graves: &[Grave]) -> Plan {
    let me: Vec<Entry> = mine.iter().map(entry_of).collect();
    let te: Vec<Entry> = theirs.iter().map(entry_of).collect();
    let mg: Vec<GraveMeta> = mine_graves.iter().map(GraveMeta::from).collect();
    let tg: Vec<GraveMeta> = theirs_graves.iter().map(GraveMeta::from).collect();
    plan_with(&me, &te, &mg, &tg, None, |_kind, id| id.to_string())
}

/// 给冲突副本起个能认出来的标题：原文 + 「（冲突副本）」+ 时间
pub fn copy_title(original: &str, at: &str) -> String {
    let stamp = at.get(0..16).unwrap_or(at).replace('T', " ");
    let base = original.trim();
    if base.is_empty() {
        format!("{} {} {}", COPY_SUFFIX, stamp, "")
    } else {
        format!("{} {} {}", base, COPY_SUFFIX, stamp)
    }
}

/// 副本的新 id（**必须全局唯一**：两端各自生成也不会撞）
pub fn copy_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 冲突副本的 `updatedAt`：用现在的时间（副本是"这次同步刚产生的"）
///
/// ⚠️ 与 `copy_id` / `copy_title` 是一套（造副本要用）；目前由测试覆盖，别按"没人用"删掉。
#[allow(dead_code)]
pub fn copy_stamp() -> String {
    now_iso()
}

// ───────────────────── M26：图片（`assets/`）怎么同步 · 纯规则（2026-10-06）─────────────────────
//
// 《同步协议》§5.2 + 附录四：**只增不删的并集**。
// 为什么这条能这么简单：你定的"原图永不删" → 图片集合只增不减
//   → **不用墓碑、不用冲突判定、不用比时间**；文件名是 uuid → 各自导入也不会撞名。
//
// ⚠️ 这个函数**不碰磁盘**（读文件/写文件在 `store::assets`）：规则要能被单测钉死，
//    两端（电脑与手机）算出来的计划也要**逐字节一致** —— 所以顺序全部按名字排序。

/// 一轮同步最多搬多少字节的图（协议附录四 §4.2 第 3 条）
///
/// 留预算的理由：首次同步可能有一堆图，一口气灌进去既慢又容易断；
/// 装不下的记进账单「还有 N 张下次接着传」，**下次同步接着来**。
pub const ASSET_ROUND_BUDGET_BYTES: u64 = 8 * 1024 * 1024;
/// 一轮最多搬几张图
pub const ASSET_ROUND_BUDGET_FILES: usize = 12;

/// 图片这一趟该怎么走
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssetPlan {
    /// 对方有、我没有 → **要对方传给我**
    pub want: Vec<String>,
    /// 我有、对方没有 → **我传给对方**
    pub send: Vec<String>,
    /// 同名但字节数不同 → 保留各自的，报告一句（uuid 撞名 = 文件坏了，不覆盖）
    pub clash: Vec<String>,
    /// 超过单张上限 → 不同步，点名
    pub oversized: Vec<String>,
    /// 这轮预算装不下、**下次接着传**的张数
    pub deferred: usize,
}

/// 按"只增不删"算这一趟要传哪些图（`mine` = 我这边的清单，`theirs` = 对方的清单）
pub fn plan_assets(mine: &[AssetMeta], theirs: &[AssetMeta]) -> AssetPlan {
    use std::collections::HashMap;
    let my_sizes: HashMap<&str, u64> = mine.iter().map(|a| (a.name.as_str(), a.size)).collect();
    let their_sizes: HashMap<&str, u64> = theirs.iter().map(|a| (a.name.as_str(), a.size)).collect();

    let mut plan = AssetPlan::default();

    // 对方的每一张：我没有 → 要；有但字节数不同 → 冲突（保留本地）
    for one in theirs {
        match my_sizes.get(one.name.as_str()) {
            None => {
                if one.size > crate::store::assets::MAX_ASSET_BYTES {
                    plan.oversized.push(one.name.clone());
                } else {
                    plan.want.push(one.name.clone());
                }
            }
            Some(size) if *size == one.size => {}
            Some(_) => plan.clash.push(one.name.clone()),
        }
    }
    // 我的每一张：对方没有 → 给他（对方有的那两种情况上面已经处理过）
    for one in mine {
        if their_sizes.contains_key(one.name.as_str()) {
            continue;
        }
        if one.size > crate::store::assets::MAX_ASSET_BYTES {
            plan.oversized.push(one.name.clone());
        } else {
            plan.send.push(one.name.clone());
        }
    }

    // 顺序确定（两端算得一样），再按"两张清单共用一个预算"截断
    plan.want.sort();
    plan.send.sort();
    plan.clash.sort();
    plan.oversized.sort();
    plan.oversized.dedup();

    let size_of = |name: &str| -> u64 {
        my_sizes
            .get(name)
            .or_else(|| their_sizes.get(name))
            .copied()
            .unwrap_or(0)
    };
    let mut used_bytes = 0u64;
    let mut used_files = 0usize;
    let mut keep = |list: Vec<String>, plan: &mut AssetPlan| -> Vec<String> {
        let mut out = Vec::new();
        for name in list {
            let size = size_of(&name);
            if used_files >= ASSET_ROUND_BUDGET_FILES || used_bytes + size > ASSET_ROUND_BUDGET_BYTES {
                plan.deferred += 1;
                continue;
            }
            used_bytes += size;
            used_files += 1;
            out.push(name);
        }
        out
    };
    // ⚠️ 借用检查：先把两个 list 取出来，再逐个过预算
    let want = std::mem::take(&mut plan.want);
    plan.want = keep(want, &mut plan);
    let send = std::mem::take(&mut plan.send);
    plan.send = keep(send, &mut plan);

    plan
}

// ───────────────────── 树 B：树笔记的**逐节点合并** · 纯规则（2026-10-07）─────────────────────
//
// # 为什么要单开一套（真事故）
// 树笔记原来只有一条粗规则「**整棵树谁更全听谁的**」（`sync_apply` 里的 `keep_local_tree_when_richer`）：
// 只要对方那份 `root` 是**上次同步时的旧副本**，谁的时间新就整棵赢 → 另一端后加的节点被整片抹掉
// （用户真机验收报的"树在、内容没了"）。而"两端都能改树"是这个 App 的常态（电脑画布 + 手机文本页），
// 所以粗规则必须换成**按节点 id 求并集**。
//
// # 规则（这就是规格，别自己改口径）
// 1. **按节点 id 并集**：本地没有、对方有（且**没有**这个 id 的墓碑）→ 采纳对方那个节点（连同子树）；
//    本地有、对方没有 → 本地保留（**不许**因为对方没有就删 —— 那正是"对方那份是旧副本"的常态）；
// 2. **删除走墓碑**：`kind = `[`KIND_TREE_NODE`]、180 天、沿用 `sync/graves.json` 那一套机制；
//    墓碑盖得住的节点**两边都不许复活、也不许被采纳**；
// 3. **同一节点两边文字不一样** → **保留本地文字**，把对方的文字留成一条「对方的文字（冲突副本）」
//    子节点（新 uuid、不折叠、不带图片）——**绝不静默丢内容**；
// 4. **显示属性以本地为准**：`collapsed` 用本地的；`asset_path` 本地没有而对方有 → 采纳对方的
//    （本地有就一个字不动）；
// 5. **结构不能丢**：对方带来的节点挂到**最近的现存祖先**下面；祖先链断了（父被删了）就挂到根下面
//    —— 但**根节点必须保留**（红线：绝不许拿笔记正文重建根节点）；
// 6. **幂等**：同一份输入合两遍，结果树一模一样（`树_合并两遍结果一模一样()` 钉着）。
//
// ⚠️ 与 `plan` / `plan_assets` 一样是**纯逻辑**：不碰磁盘（读盘/写盘在 `sync_apply`），
//    输入是两棵 `TreeNode` + 墓碑清单，输出是合并后的树 + 冲突说明。

/// 一次逐节点合并留下的冲突（同一节点两边文字不一样）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeConflict {
    /// 是在哪个节点上撞的（正本的 id，两端一致）
    pub node_id: String,
    /// 本地保下来的文字（原样留在正本节点上）
    pub mine_text: String,
    /// 对方那段文字（已经留成子节点了）
    pub theirs_text: String,
    /// 那段文字的副本标题（= 对方文字 + [`COPY_SUFFIX`]）
    pub copy_title: String,
}

/// 逐节点合并的结果
///
/// ⚠️ 这里**不派生 `PartialEq`**：`TreeNode` 本身没实现它，要比就比序列化结果（单测里有 `as_json`）。
#[derive(Clone, Debug)]
pub struct TreeMerge {
    /// 合并后的根。两边都没有根时是 `None`；**本地有根就一定是本地那个 id**（红线：根不许被换）
    pub root: Option<TreeNode>,
    /// 这一趟**真的新留了**几份「（冲突副本）」子节点（已经留过的不再重复计数 → 账单不会虚涨）
    pub conflicts: Vec<TreeConflict>,
}

/// 墓碑盖得住的节点 id。
///
/// ⚠️ 只认 [`KIND_TREE_NODE`] 这一族：墓碑里只有 id，别的族的 id（笔记/待办/档案）与节点 id
/// 不是同一个空间，混着判会误摘。
fn dead_node_ids(graves: &[GraveMeta]) -> HashSet<String> {
    graves
        .iter()
        .filter(|one| one.kind == KIND_TREE_NODE)
        .map(|one| one.id.clone())
        .collect()
}

/// 一棵树里"谁是谁的孩子"（找"最近的现存祖先"要用）。
///
/// 用 `or_insert`：**先插的赢** —— 调用方先收本地那棵，所以两边都有同一个 id 时按本地的父算
/// （结构以本地为准，跟规则 §4「显示属性以本地为准」一个道理）。
fn collect_parents(
    node: &TreeNode,
    parent: Option<&str>,
    out: &mut HashMap<String, Option<String>>,
) {
    out.entry(node.id.clone())
        .or_insert_with(|| parent.map(|one| one.to_string()));
    for child in &node.children {
        collect_parents(child, Some(&node.id), out);
    }
}

/// 按 id 找节点（只读）
fn find_any<'a>(node: &'a TreeNode, id: &str) -> Option<&'a TreeNode> {
    if node.id == id {
        return Some(node);
    }
    node.children.iter().find_map(|child| find_any(child, id))
}

/// 按 id 找节点（可改）
fn find_any_mut<'a>(node: &'a mut TreeNode, id: &str) -> Option<&'a mut TreeNode> {
    if node.id == id {
        return Some(node);
    }
    node.children
        .iter_mut()
        .find_map(|child| find_any_mut(child, id))
}

/// 把一棵树按墓碑筛一遍（**前序**：父先于子，兄弟顺序保持原样）。
///
/// - `is_root = true` → 永远保留（红线：根没了整棵树就没了，绝不许拿正文重建）；
/// - 返回 `None` = 这个节点被墓碑盖住、自己不进来；
/// - 它**活着的**后代进 `orphans`，由上一层挂到自己名下 = 挂到"**最近的现存祖先**"（规则 §5）。
fn prune_dead(
    node: &TreeNode,
    dead: &HashSet<String>,
    is_root: bool,
    orphans: &mut Vec<TreeNode>,
) -> Option<TreeNode> {
    if !is_root && dead.contains(&node.id) {
        for child in &node.children {
            if let Some(survivor) = prune_dead(child, dead, false, orphans) {
                orphans.push(survivor);
            }
        }
        return None;
    }
    let mut kept = node.clone();
    kept.children.clear();
    for child in &node.children {
        let mut lifted: Vec<TreeNode> = Vec::new();
        if let Some(survivor) = prune_dead(child, dead, false, &mut lifted) {
            kept.children.push(survivor);
        }
        // 被摘掉的那个孩子的活后代 → 挂到**当前这个**节点（它就是"最近的现存祖先"）
        kept.children.append(&mut lifted);
    }
    Some(kept)
}

/// 结果的锚点：从 `start` 往上找**第一个还在结果树上的祖先**；到顶了/父链断了 → `None`（挂根）
fn nearest_alive(
    start: Option<&str>,
    root: &TreeNode,
    parents: &HashMap<String, Option<String>>,
) -> Option<String> {
    let mut cursor: Option<String> = start.map(|one| one.to_string());
    // 父链最多走 1000 层：坏数据成环时不能把同步卡死（宁可挂根，也不能转不出来）
    for _ in 0..1000 {
        let Some(id) = cursor else { return None };
        if find_any(root, &id).is_some() {
            return Some(id);
        }
        cursor = parents.get(&id).cloned().flatten();
    }
    None
}

/// 两边都有同一个 id → 合并**这一个**节点：
///
/// - 文字不一样 → 保留本地文字，把对方的文字留成一条「（冲突副本）」子节点（规则 §3）；
/// - 折叠一律用本地的（**对方展开/收起都不算数**：折叠是"用户当时的视线"，不该被同步改走）；
/// - 图片 / 联动来源：本地没有而对方有 → 采纳对方的（本地有就一个字不动，规则 §4）。
fn merge_same_node(slot: &mut TreeNode, theirs: &TreeNode, conflicts: &mut Vec<TreeConflict>) {
    if slot.text != theirs.text {
        let copy_title = format!("{}{}", theirs.text, COPY_SUFFIX);
        // 🔴 幂等闸门（规则 §6，也是"绝不静默丢内容"能成立的前提）：
        //    已经留着同一段文字的副本就不再造第二个 —— 否则**每次同步都会多一份副本**
        //    （合并的输入里永远有对方那段"没变"的文字，第二遍一定还会走到这里）。
        if !slot.children.iter().any(|child| child.text == copy_title) {
            // 副本节点：新 uuid、不折叠、不带图片（规则 §3 末句：collapsed/图片按本地）
            slot.children.push(TreeNode::new(copy_title.clone()));
            conflicts.push(TreeConflict {
                node_id: slot.id.clone(),
                mine_text: slot.text.clone(),
                theirs_text: theirs.text.clone(),
                copy_title,
            });
        }
    }
    // 本地没图（没有或空串）→ 采纳对方的图；本地有图 → 不动
    if slot
        .asset_path
        .as_deref()
        .map(|path| path.trim().is_empty())
        .unwrap_or(true)
    {
        slot.asset_path = theirs
            .asset_path
            .clone()
            .filter(|path| !path.trim().is_empty());
    }
    // 联动来源（〔联动信息〕那个标记）跟图片一个道理：本地没有才采纳对方的
    if slot.source_info_id.is_none() {
        slot.source_info_id = theirs.source_info_id.clone();
    }
}

/// **核心**：把本地那棵树与对方那棵树按节点 id 合起来（纯函数，无 IO）
///
/// `mine` = 本地现在这棵（没有根/文件不在就是 `None`）；`theirs` = 对方那份；
/// `graves` = **两边**的墓碑（本地记着的 + 对方报上来的），只有 `treenode` 那一族算数。
pub fn merge_trees(
    mine: Option<&TreeNode>,
    theirs: Option<&TreeNode>,
    graves: &[GraveMeta],
) -> TreeMerge {
    let dead = dead_node_ids(graves);
    let mut out = TreeMerge {
        root: None,
        conflicts: Vec::new(),
    };

    // ── 1) 骨架 = **本地那棵**：于是"本地有、对方没有"的节点天然留着（规则 §1 后半句），
    //       本地顺序、折叠、图片也天然都保住了。被墓碑盖住的本地节点摘掉，但它们活着的后代
    //       往上挂到最近的现存祖先（规则 §5：结构不能丢）。
    if let Some(local) = mine {
        let mut lifted: Vec<TreeNode> = Vec::new();
        if let Some(mut root) = prune_dead(local, &dead, true, &mut lifted) {
            root.children.append(&mut lifted);
            out.root = Some(root);
        }
    } else if let Some(remote) = theirs {
        // 本地没有根（文件不在 / 坏树）→ 采纳对方的根。⚠️ 这不是"拿正文重建根节点"，
        // 是**照抄对方那份**：重建那条路是红线（会把树里原有的节点清光）。
        let mut lifted: Vec<TreeNode> = Vec::new();
        if let Some(mut root) = prune_dead(remote, &dead, true, &mut lifted) {
            root.children.append(&mut lifted);
            out.root = Some(root);
        }
    }

    let Some(remote) = theirs else { return out };
    if out.root.is_none() {
        return out;
    }

    // 两边合起来的父链（本地先插 → 同一个 id 按本地算），用来找"最近的现存祖先"
    let mut parents: HashMap<String, Option<String>> = HashMap::new();
    if let Some(local) = mine {
        collect_parents(local, None, &mut parents);
    }
    collect_parents(remote, None, &mut parents);

    // 对方那棵的**前序遍历**：父一定排在子前面，所以"先挂父、再挂子"天然成立
    let mut order: Vec<(String, Option<String>)> = Vec::new();
    fn walk(node: &TreeNode, parent: Option<&str>, out: &mut Vec<(String, Option<String>)>) {
        out.push((node.id.clone(), parent.map(|one| one.to_string())));
        for child in &node.children {
            walk(child, Some(&node.id), out);
        }
    }
    walk(remote, None, &mut order);

    // ── 2) 对方那棵的每一个节点：本地没有 → 采纳（连同子树）；两边都有 → 合并这一个节点
    for (id, parent) in order {
        // 规则 §2：墓碑盖得住的节点**两边都不许复活、也不许被采纳**
        if dead.contains(&id) {
            continue;
        }
        let Some(node) = find_any(remote, &id) else {
            continue; // 理论上到不了（id 就是刚遍历出来的），写成这样是为了绝不 panic
        };
        // ⚠️ 借用检查：`root` 与 `conflicts` 是两个字段，分开借才不打架
        let TreeMerge { root, conflicts } = &mut out;
        let Some(tree) = root.as_mut() else { break };
        if let Some(slot) = find_any_mut(tree, &id) {
            merge_same_node(slot, node, conflicts);
            continue;
        }
        // 采纳对方这个节点（连同它的子树；子树里被墓碑盖住的照样筛掉）
        let Some(taken) = prune_dead(node, &dead, false, &mut Vec::new()) else {
            continue;
        };
        // 挂到"最近的现存祖先"下；祖先链断了（父被删了/对方那枝本地从来没有）→ 挂到根
        match nearest_alive(parent.as_deref(), tree, &parents) {
            Some(anchor) => match find_any_mut(tree, &anchor) {
                Some(slot) => slot.children.push(taken),
                None => tree.children.push(taken),
            },
            None => tree.children.push(taken),
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sync::Grave;

    fn rec(kind: &str, id: &str, at: &str, title: &str) -> Rec {
        Rec {
            kind: kind.into(),
            id: id.into(),
            updated_at: at.into(),
            json: serde_json::json!({ "id": id, "title": title }),
        }
    }
    fn grave(id: &str, kind: &str, at: &str) -> Grave {
        Grave {
            id: id.into(),
            kind: kind.into(),
            deleted_at: at.into(),
        }
    }
    const T0: &str = "2026-10-06T10:00:00+08:00";
    const T1: &str = "2026-10-06T11:00:00+08:00";
    const T2: &str = "2026-10-06T12:00:00+08:00";

    // ── 1~6 谁新听谁（整条赢）
    #[test]
    fn only_mine_goes_to_them() {
        let p = plan(&[rec(KIND_TODO, "a", T0, "买牛奶")], &[], &[], &[]);
        assert_eq!(p.send_mine, vec!["a".to_string()]);
        assert!(p.take_theirs.is_empty());
    }

    #[test]
    fn only_theirs_comes_to_me() {
        let p = plan(&[], &[rec(KIND_TODO, "a", T0, "买牛奶")], &[], &[]);
        assert_eq!(p.take_theirs, vec!["a".to_string()]);
    }

    #[test]
    fn newer_theirs_wins() {
        let p = plan(
            &[rec(KIND_TODO, "a", T1, "旧")],
            &[rec(KIND_TODO, "a", T2, "新")],
            &[],
            &[],
        );
        assert_eq!(p.take_theirs, vec!["a".to_string()]);
        assert!(p.conflicts.is_empty());
    }

    #[test]
    fn newer_mine_wins() {
        let p = plan(
            &[rec(KIND_TODO, "a", T2, "新")],
            &[rec(KIND_TODO, "a", T1, "旧")],
            &[],
            &[],
        );
        assert_eq!(p.send_mine, vec!["a".to_string()]);
    }

    #[test]
    fn identical_time_is_a_conflict_not_a_guess() {
        let p = plan(
            &[rec(KIND_TODO, "a", T1, "我改的")],
            &[rec(KIND_TODO, "a", T1, "他改的")],
            &[],
            &[],
        );
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(p.conflicts[0].reason, "same_moment");
        assert!(p.take_theirs.is_empty() && p.send_mine.is_empty());
    }

    #[test]
    fn within_two_minutes_counts_as_same_moment() {
        // 差 90 秒 < 容差 120 秒 → 视为同时改
        let p = plan(
            &[rec(KIND_TODO, "a", "2026-10-06T11:00:00+08:00", "我")],
            &[rec(KIND_TODO, "a", "2026-10-06T11:01:30+08:00", "他")],
            &[],
            &[],
        );
        assert_eq!(p.conflicts.len(), 1);
    }

    #[test]
    fn beyond_two_minutes_is_decided_by_time() {
        // 差 3 分钟 > 容差 → 按时间判
        let p = plan(
            &[rec(KIND_TODO, "a", "2026-10-06T11:00:00+08:00", "我")],
            &[rec(KIND_TODO, "a", "2026-10-06T11:03:00+08:00", "他")],
            &[],
            &[],
        );
        assert_eq!(p.conflicts.len(), 0);
        assert_eq!(p.take_theirs, vec!["a".to_string()]);
    }

    // ── 7~12 删除（墓碑）
    #[test]
    fn their_grave_deletes_my_untouched_record() {
        let p = plan(
            &[rec(KIND_TODO, "a", T0, "老")],
            &[],
            &[],
            &[grave("a", KIND_TODO, T2)],
        );
        assert_eq!(p.apply_graves.len(), 1);
        assert_eq!(p.apply_graves[0].id, "a");
        assert!(p.conflicts.is_empty(), "没改过就该安静地删掉");
    }

    #[test]
    fn my_grave_makes_them_delete() {
        let p = plan(
            &[],
            &[rec(KIND_TODO, "a", T0, "老")],
            &[grave("a", KIND_TODO, T2)],
            &[],
        );
        assert_eq!(p.send_graves.len(), 1);
    }

    #[test]
    fn deleted_then_modified_keeps_a_copy() {
        // 他 12:00 删的；我 13:00 又改过（> 容差）→ 不许静默删我的改动
        let p = plan(
            &[rec(KIND_TODO, "a", "2026-10-06T13:00:00+08:00", "我又改了")],
            &[],
            &[],
            &[grave("a", KIND_TODO, T2)],
        );
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(p.conflicts[0].reason, "deleted_but_modified");
        assert_eq!(p.apply_graves.len(), 1, "删除照样生效，但改动留成副本");
    }

    #[test]
    fn modified_within_tolerance_of_deletion_still_deletes() {
        let p = plan(
            &[rec(KIND_TODO, "a", "2026-10-06T12:01:00+08:00", "几乎同时")],
            &[],
            &[],
            &[grave("a", KIND_TODO, T2)],
        );
        assert!(p.conflicts.is_empty());
        assert_eq!(p.apply_graves.len(), 1);
    }

    #[test]
    fn unparsable_time_never_deletes_silently() {
        let p = plan(&[rec(KIND_TODO, "a", "看不懂的时间", "别删我")], &[], &[], &[grave("a", KIND_TODO, T2)]);
        assert_eq!(p.conflicts.len(), 1, "读不出时间 → 走冲突留副本，绝不静默删");
    }

    #[test]
    fn both_have_graves_no_work() {
        let p = plan(&[], &[], &[grave("a", KIND_TODO, T1)], &[grave("a", KIND_TODO, T2)]);
        assert!(p.is_empty(), "两边都记着了 → 无事可做");
    }

    #[test]
    fn their_grave_is_adopted_even_if_i_lack_the_record() {
        let p = plan(&[], &[], &[], &[grave("x", KIND_NOTE, T1)]);
        assert_eq!(p.apply_graves.len(), 1, "墓碑要跟着走，否则以后会被传回来复活");
    }

    // ── 13~18 只进不出
    #[test]
    fn only_in_accepts_new_id_from_them() {
        let p = plan(&[], &[rec(KIND_INFO, "i1", T1, "他新收的")], &[], &[]);
        assert_eq!(p.take_theirs, vec!["i1".to_string()]);
    }

    #[test]
    fn only_in_sends_my_new_id() {
        let p = plan(&[rec(KIND_INFO, "i1", T1, "我刚记的")], &[], &[], &[]);
        assert_eq!(p.send_mine, vec!["i1".to_string()]);
    }

    #[test]
    fn updated_at_newer_wins_for_former_only_in_family() {
        let p = plan(
            &[rec(KIND_INFO, "i1", T1, "我这版")],
            &[rec(KIND_INFO, "i1", T2, "他那版更新")],
            &[],
            &[],
        );
        assert_eq!(p.take_theirs, vec!["i1".to_string()]);
        assert!(p.send_mine.is_empty());
        assert!(p.skipped_only_in.is_empty());
        assert!(p.conflicts.is_empty(), "这几族不做冲突副本，新的整条赢");
    }

    #[test]
    fn only_in_does_not_propagate_graves() {
        let p = plan(&[], &[], &[], &[grave("i1", KIND_INFO, T1)]);
        assert!(p.apply_graves.is_empty(), "只进不出的族不做删除传播");
    }

    #[test]
    fn every_last_write_kind_uses_updated_at() {
        for kind in LAST_WRITE_WINS_KINDS {
            let p = plan(
                &[rec(kind, "x", T1, "a")],
                &[rec(kind, "x", T2, "b")],
                &[],
                &[],
            );
            assert_eq!(p.take_theirs, vec!["x".to_string()], "{kind} 应当采纳更新的那版");
            assert!(p.conflicts.is_empty(), "{kind} 不生成冲突副本");
        }
    }

    #[test]
    fn non_only_in_kind_with_both_sides_conflicts_or_wins() {
        for kind in [KIND_TODO, KIND_NOTE, KIND_DAILY, KIND_REMINDER, KIND_ANNOTATION] {
            let p = plan(&[rec(kind, "x", T1, "a")], &[rec(kind, "x", T1, "b")], &[], &[]);
            assert_eq!(p.conflicts.len(), 1, "{kind} 应当参与冲突判定");
        }
    }

    // ── 19~26 清单/计划本身
    #[test]
    fn manifest_carries_no_payload() {
        let m = manifest_of("dev-a", &[rec(KIND_TODO, "a", T0, "秘密内容")], &[], 1);
        let text = serde_json::to_string(&m).unwrap();
        assert!(!text.contains("秘密内容"), "清单里绝不能带内容");
        assert!(text.contains("\"todo\""));
    }

    #[test]
    fn manifest_is_sorted_for_stable_diffs() {
        let m = manifest_of(
            "d",
            &[rec(KIND_TODO, "b", T0, ""), rec(KIND_TODO, "a", T0, ""), rec(KIND_NOTE, "a", T0, "")],
            &[],
            1,
        );
        let ids: Vec<String> = m.entries.iter().map(|one| format!("{}/{}", one.kind, one.id)).collect();
        assert_eq!(ids, vec!["note/a", "todo/a", "todo/b"]);
    }

    #[test]
    fn same_timestamp_is_treated_as_a_conflict() {
        let mine = vec![rec(KIND_TODO, "a", T0, "同一条")];
        let theirs = vec![rec(KIND_TODO, "a", T0, "同一条")];
        let p = plan(&mine, &theirs, &[], &[]);
        // ⚠️ 这里刻意**不**优化成"内容相同就不冲突"：内容比较要做深比较、且两端 JSON 键序可能不同；
        //    多留一份副本远比"漏判"安全 —— 所以同一时间点一律按冲突走（下面这条断言就是钉这个语义）。
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(p.conflicts[0].reason, "same_moment");
        assert!(p.take_theirs.is_empty() && p.send_mine.is_empty());
        assert_eq!(p.apply_graves.len(), 0);
    }

    #[test]
    fn moved_counts_everything() {
        let p = Plan {
            take_theirs: vec!["a".into()],
            send_mine: vec!["b".into()],
            conflicts: vec![],
            apply_graves: vec![],
            send_graves: vec![],
            skipped_only_in: vec![],
        };
        assert_eq!(p.moved(), 2);
        assert!(!p.is_empty());
    }

    #[test]
    fn copy_title_has_suffix_and_time() {
        let t = copy_title("高数复习", "2026-10-06T13:05:00+08:00");
        assert!(t.contains("高数复习"));
        assert!(t.contains(COPY_SUFFIX));
        assert!(t.contains("2026-10-06 13:05"));
    }

    #[test]
    fn copy_title_handles_empty_title() {
        let t = copy_title("   ", T1);
        assert!(t.starts_with(COPY_SUFFIX));
    }

    #[test]
    fn copy_id_is_unique() {
        let a = copy_id();
        let b = copy_id();
        assert_ne!(a, b);
        assert!(a.len() >= 32);
    }

    #[test]
    fn grave_covers_semantics() {
        assert!(grave_covers(T2, T1), "记录比删除早 → 盖得住");
        assert!(grave_covers(T2, T2), "同一时刻 → 盖得住");
        assert!(!grave_covers(T1, T2), "记录比删除晚 → 盖不住（要留副本）");
        assert!(!grave_covers("坏时间", T1));
    }

    #[test]
    fn plan_dedups_repeated_ids() {
        // 同一条既在"我该删"又出现在别处 → 只留一次
        let p = plan(&[], &[rec(KIND_TODO, "a", T0, "x")], &[grave("a", KIND_TODO, T2)], &[]);
        assert_eq!(p.send_graves.len(), 1);
    }

    #[test]
    fn many_records_mixed_scenario() {
        // 一条各自新、一条冲突、一条删除、一条只进不出
        let mine = vec![
            rec(KIND_TODO, "mine-new", T2, "我新的"),
            rec(KIND_TODO, "conflict", T1, "我"),
            rec(KIND_TODO, "gone", T0, "他删我留"),
            rec(KIND_INFO, "only1", T1, "我这版"),
        ];
        let theirs = vec![
            rec(KIND_TODO, "theirs-new", T2, "他新的"),
            rec(KIND_TODO, "conflict", T1, "他"),
            rec(KIND_INFO, "only1", T2, "他那版"),
        ];
        let tg = vec![grave("gone", KIND_TODO, T2)];
        let p = plan(&mine, &theirs, &[], &tg);
        assert_eq!(p.send_mine, vec!["mine-new".to_string()]);
        assert_eq!(p.take_theirs, vec!["only1".to_string(), "theirs-new".to_string()]);
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(p.conflicts[0].id, "conflict");
        assert_eq!(p.apply_graves.len(), 1);
        assert!(p.skipped_only_in.is_empty());
    }

    #[test]
    fn conflict_titles_are_resolved_through_callback() {
        let me = vec![Entry { kind: KIND_TODO.into(), id: "a".into(), updated_at: T1.into() }];
        let te = vec![Entry { kind: KIND_TODO.into(), id: "a".into(), updated_at: T1.into() }];
        let p = plan_with(&me, &te, &[], &[], None, |_k, _i| "买牛奶".to_string());
        assert_eq!(p.conflicts[0].title, "买牛奶");
    }

    #[test]
    fn newer_wins_is_used_for_cross_kind_ids_independently() {
        // 同一个 id 在不同 kind 下互不干扰
        let mine = vec![rec(KIND_TODO, "same", T2, "todo 我新")];
        let theirs = vec![rec(KIND_NOTE, "same", T1, "note 他旧")];
        let p = plan(&mine, &theirs, &[], &[]);
        assert_eq!(p.send_mine, vec!["same".to_string()]);
        assert_eq!(p.take_theirs, vec!["same".to_string()]);
        assert!(p.conflicts.is_empty());
    }

    // ───────────────────── M26：图片（只增不删的并集）─────────────────────

    fn asset(name: &str, size: u64) -> AssetMeta {
        AssetMeta { name: name.to_string(), size }
    }

    #[test]
    fn 图片只增不删_两边互相补缺() {
        // 我有 a，他有 b → 我要 b、给他 a
        let p = plan_assets(&[asset("a.png", 10)], &[asset("b.png", 20)]);
        assert_eq!(p.want, vec!["b.png"]);
        assert_eq!(p.send, vec!["a.png"]);
        assert!(p.clash.is_empty());
        assert_eq!(p.deferred, 0);

        // 一模一样的清单 → 什么都不做（**这是"再同步一次不该重复传"的地基**）
        let same = plan_assets(&[asset("a.png", 10)], &[asset("a.png", 10)]);
        assert!(same.want.is_empty() && same.send.is_empty(), "无差异就该空计划");
        assert_eq!(same.deferred, 0);
    }

    #[test]
    fn 图片删除不传播_只有一边有的时候永远是补过去() {
        // 他那边没有 a（"我删了"或"他从没有过"）—— 两种情况都**只补不删**：
        // 我仍然会把 a 给他（原图永不删，协议 §5.2）
        let p = plan_assets(&[asset("a.png", 10)], &[]);
        assert_eq!(p.send, vec!["a.png"]);
        // 反过来：他有我没有 → 只会补给我，绝不会让我删掉自己的东西（本地清单根本不参与删除）
        let q = plan_assets(&[], &[asset("b.png", 10)]);
        assert_eq!(q.want, vec!["b.png"]);
    }

    #[test]
    fn 同名不同大小算冲突_保留各自的() {
        let p = plan_assets(&[asset("x.png", 100)], &[asset("x.png", 200)]);
        assert_eq!(p.clash, vec!["x.png"]);
        assert!(p.want.is_empty(), "冲突的**不能**去要（否则就覆盖本地了）");
        assert!(p.send.is_empty(), "冲突的**不能**给（对方也该留着他自己那张）");
    }

    #[test]
    fn 超过单张上限的不同步并点名() {
        let huge = crate::store::assets::MAX_ASSET_BYTES + 1;
        let p = plan_assets(&[asset("huge.png", huge)], &[asset("huge2.png", huge)]);
        assert_eq!(p.oversized, vec!["huge.png", "huge2.png"]);
        assert!(p.want.is_empty() && p.send.is_empty());
    }

    #[test]
    fn 一轮预算装不下的记成下次再传() {
        // 每张 1 MB：8 MB 预算 = 最多 8 张，剩下的进 deferred（**首次同步不会被灌满**）
        let mine: Vec<AssetMeta> = (0..20)
            .map(|i| asset(&format!("mine-{i:02}.png"), 1024 * 1024))
            .collect();
        let p = plan_assets(&mine, &[]);
        assert_eq!(p.send.len(), 8, "8 MB 预算下最多 8 张：{:?}", p.send);
        assert_eq!(p.deferred, 12, "剩下 12 张下次再传");
        assert!(p.send.iter().all(|n| n.starts_with("mine-")), "顺序要确定：{:?}", p.send);
        // 名字排序 → 取的是前 8 个（两端算出来必须一样）
        assert_eq!(p.send[0], "mine-00.png");
        assert_eq!(p.send[7], "mine-07.png");

        // 张数上限也生效（每张很小 → 只受 12 张这个限制）
        let tiny: Vec<AssetMeta> = (0..20).map(|i| asset(&format!("t-{i:02}.png"), 10)).collect();
        let q = plan_assets(&tiny, &[]);
        assert_eq!(q.send.len(), ASSET_ROUND_BUDGET_FILES);
        assert_eq!(q.deferred, 20 - ASSET_ROUND_BUDGET_FILES);
    }

    // ───────────────────── 树 B：树笔记的逐节点合并 ─────────────────────
    //
    // 这十来条就是《树 B》规格的可执行版本：按 id 并集 / 删除走墓碑 / 文字冲突留副本 /
    // 显示属性以本地为准 / 结构不能丢 / 幂等。

    /// 造一个节点（测试里手写 id，比 uuid 好读）
    fn nd(id: &str, text: &str, kids: Vec<TreeNode>) -> TreeNode {
        TreeNode {
            id: id.into(),
            text: text.into(),
            asset_path: None,
            collapsed: false,
            children: kids,
            source_info_id: None,
        }
    }

    /// 一条树节点墓碑
    fn node_grave(id: &str) -> GraveMeta {
        GraveMeta {
            id: id.into(),
            kind: KIND_TREE_NODE.into(),
            deleted_at: T2.into(),
        }
    }

    /// 把一棵树摊平成带缩进的文字清单（断言结构比"逐字段比"好读得多）
    fn shape_of(root: &TreeNode) -> Vec<String> {
        fn walk(node: &TreeNode, depth: usize, out: &mut Vec<String>) {
            out.push(format!("{}{}", "  ".repeat(depth), node.text));
            for child in &node.children {
                walk(child, depth + 1, out);
            }
        }
        let mut out = Vec::new();
        walk(root, 0, &mut out);
        out
    }

    /// 树比大小的那个"值"（`TreeNode` 没实现 PartialEq，用序列化结果比）
    fn as_json(root: &TreeNode) -> String {
        serde_json::to_string(root).unwrap()
    }

    #[test]
    fn 树_按节点id并集_两边互相补缺() {
        // 两边同一个根，各有一个对方没有的孩子 → 合起来两个都要在
        let mine = nd("r", "中心主题", vec![nd("a", "A（本地加的）", vec![])]);
        let theirs = nd("r", "中心主题", vec![nd("b", "B（对方加的）", vec![])]);
        let merged = merge_trees(Some(&mine), Some(&theirs), &[]);
        assert_eq!(
            shape_of(merged.root.as_ref().unwrap()),
            vec!["中心主题", "  A（本地加的）", "  B（对方加的）"],
            "两边独有的节点都要留着（不是「谁赢」）"
        );
        assert!(merged.conflicts.is_empty(), "没有文字冲突就不该报冲突");

        // 本地有、对方没有 → **本地保留**（对方那份常常只是上次同步的旧副本）
        let only_mine = merge_trees(Some(&mine), Some(&nd("r", "中心主题", vec![])), &[]);
        assert_eq!(shape_of(only_mine.root.as_ref().unwrap()), vec!["中心主题", "  A（本地加的）"]);
    }

    #[test]
    fn 树_墓碑盖住的节点不许复活也不许采纳() {
        // ① 对方那边还有 X（我这边没有），但 X 有墓碑 → 不许采纳
        let mine = nd("r", "中心主题", vec![]);
        let theirs = nd("r", "中心主题", vec![nd("x", "已经删掉的", vec![])]);
        let merged = merge_trees(Some(&mine), Some(&theirs), &[node_grave("x")]);
        assert_eq!(shape_of(merged.root.as_ref().unwrap()), vec!["中心主题"]);

        // ② 本地还留着的节点，只要有墓碑也要摘掉（"两边都不许复活"）
        let mine2 = nd(
            "r",
            "中心主题",
            vec![nd("y", "本地该删的", vec![nd("y1", "它的孩子", vec![])])],
        );
        let both = merge_trees(Some(&mine2), None, &[node_grave("y"), node_grave("y1")]);
        assert_eq!(shape_of(both.root.as_ref().unwrap()), vec!["中心主题"]);

        // ③ 父被墓碑盖住、孩子没被盖住 → **这一枝不算丢**：孩子挂到最近的现存祖先（这里是根）
        let lifted = merge_trees(Some(&mine2), None, &[node_grave("y")]);
        assert_eq!(
            shape_of(lifted.root.as_ref().unwrap()),
            vec!["中心主题", "  它的孩子"],
            "规则 §5：祖先链断了就挂到根下面（宁可挂高一点，也不许把内容弄丢）"
        );
    }

    #[test]
    fn 树_别的族的墓碑不该摘节点() {
        // 同一个 id 上有一条 `note` 墓碑 —— 那说的是**一篇笔记**，不是这个节点
        let mine = nd("r", "中心主题", vec![nd("x", "节点X", vec![])]);
        let other_kind = GraveMeta {
            id: "x".into(),
            kind: KIND_NOTE.into(),
            deleted_at: T2.into(),
        };
        let merged = merge_trees(Some(&mine), None, &[other_kind]);
        assert_eq!(shape_of(merged.root.as_ref().unwrap()), vec!["中心主题", "  节点X"]);

        // ⚠️ 墓碑的 kind 是协议字段：改成别的字，老墓碑就认不出来了（这条是钉子）
        assert_eq!(KIND_TREE_NODE, "treenode");
    }

    #[test]
    fn 树_同一节点文字不同保留本地并把对方那段留成冲突副本() {
        let mine = nd("r", "中心主题", vec![nd("a", "电脑改成的话", vec![])]);
        let theirs = nd("r", "中心主题", vec![nd("a", "手机改成的话", vec![])]);
        let merged = merge_trees(Some(&mine), Some(&theirs), &[]);

        let a = &merged.root.as_ref().unwrap().children[0];
        assert_eq!(a.text, "电脑改成的话", "规则 §3：文字冲突保留本地文字");
        assert_eq!(a.children.len(), 1, "对方那段要留成一条子节点（绝不静默丢内容）");
        assert_eq!(a.children[0].text, format!("手机改成的话{COPY_SUFFIX}"));
        assert_ne!(a.children[0].id, "a", "副本必须是新生成的 uuid（不能和正本撞 id）");
        assert!(!a.children[0].collapsed, "副本的折叠按本地（新节点就是默认不折叠）");
        assert!(a.children[0].asset_path.is_none(), "副本不带图片");

        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(merged.conflicts[0].node_id, "a");
        assert_eq!(merged.conflicts[0].mine_text, "电脑改成的话");
        assert_eq!(merged.conflicts[0].theirs_text, "手机改成的话");
        assert!(merged.conflicts[0].copy_title.contains(COPY_SUFFIX));
    }

    #[test]
    fn 树_合并两遍结果一模一样() {
        // 规则 §6（幂等）：同一份输入合两遍，结果树必须**一模一样**，冲突副本也不许越长越多。
        // 这条挡的是"每同步一次就多一份（冲突副本）"那种荒唐事。
        let mine = nd(
            "r",
            "中心主题",
            vec![nd("a", "电脑改的", vec![nd("a1", "我加的孩子", vec![])])],
        );
        let theirs = nd(
            "r",
            "中心主题",
            vec![
                nd("a", "手机改的", vec![nd("b", "他加的孩子", vec![])]),
                nd("c", "他全新的一枝", vec![]),
            ],
        );
        let graves = vec![node_grave("gone")];

        let once = merge_trees(Some(&mine), Some(&theirs), &graves);
        let twice = merge_trees(once.root.as_ref(), Some(&theirs), &graves);
        assert_eq!(
            as_json(once.root.as_ref().unwrap()),
            as_json(twice.root.as_ref().unwrap()),
            "同一份输入合两遍，结果树必须一字不差"
        );
        assert_eq!(once.conflicts.len(), 1, "第一遍该留一份副本");
        assert!(twice.conflicts.is_empty(), "第二遍不许再造副本（否则账单会虚涨）");
    }

    #[test]
    fn 树_折叠与图片与联动来源都以本地为准() {
        // 同一个节点：本地折叠着、没图；对方展开、有图、还带着联动来源
        let mut local_a = nd("a", "甲", vec![]);
        local_a.collapsed = true;
        let mut remote_a = nd("a", "甲", vec![]);
        remote_a.collapsed = false;
        remote_a.asset_path = Some("assets/他的图.png".into());
        remote_a.source_info_id = Some("info-9".into());

        let merged = merge_trees(
            Some(&nd("r", "中心主题", vec![local_a])),
            Some(&nd("r", "中心主题", vec![remote_a.clone()])),
            &[],
        );
        let a = &merged.root.as_ref().unwrap().children[0];
        assert!(a.collapsed, "折叠用本地的（对方展开不算数）");
        assert_eq!(a.asset_path.as_deref(), Some("assets/他的图.png"), "本地没图 → 采纳对方的");
        assert_eq!(a.source_info_id.as_deref(), Some("info-9"), "本地没有联动来源 → 采纳对方的");

        // 本地有图 / 有来源 → 一个字都不许动
        let mut mine_a = nd("a", "甲", vec![]);
        mine_a.asset_path = Some("assets/我的图.png".into());
        mine_a.source_info_id = Some("info-1".into());
        let mine_a = {
            let mut one = mine_a;
            one.collapsed = true;
            one
        };
        let kept = merge_trees(
            Some(&nd("r", "中心主题", vec![mine_a])),
            Some(&nd("r", "中心主题", vec![remote_a])),
            &[],
        );
        let a = &kept.root.as_ref().unwrap().children[0];
        assert_eq!(a.asset_path.as_deref(), Some("assets/我的图.png"), "本地有图就不动");
        assert_eq!(a.source_info_id.as_deref(), Some("info-1"), "本地有来源就不动");
        assert!(a.collapsed);
    }

    #[test]
    fn 树_父被删了就挂到最近的现存祖先() {
        // 对方：根 → 爷 → 父（有墓碑）→ 孩子；我这边只有 根 → 爷
        let mine = nd("r", "中心主题", vec![nd("g", "爷", vec![])]);
        let theirs = nd(
            "r",
            "中心主题",
            vec![nd("g", "爷", vec![nd("p", "父", vec![nd("c", "孩子", vec![])])])],
        );
        let under_grandpa = merge_trees(Some(&mine), Some(&theirs), &[node_grave("p")]);
        assert_eq!(
            shape_of(under_grandpa.root.as_ref().unwrap()),
            vec!["中心主题", "  爷", "    孩子"],
            "最近的**现存**祖先就是爷 → 挂到爷下面"
        );

        // 祖先链整段都断了（爷和父都被删）→ 挂到根下面
        let under_root = merge_trees(Some(&mine), Some(&theirs), &[node_grave("p"), node_grave("g")]);
        assert_eq!(
            shape_of(under_root.root.as_ref().unwrap()),
            vec!["中心主题", "  孩子"]
        );
    }

    #[test]
    fn 树_根节点永远保留_就算墓碑盖到它() {
        // 红线：根没了整棵树就没了。就算墓碑（坏数据/别处手写的）盖到根 id 上，也不摘。
        let mine = nd("r", "中心主题", vec![nd("a", "A", vec![])]);
        let merged = merge_trees(Some(&mine), None, &[node_grave("r")]);
        assert_eq!(
            shape_of(merged.root.as_ref().unwrap()),
            vec!["中心主题", "  A"],
            "🔴 根节点必须保留（绝不许拿笔记正文重建根节点）"
        );
    }

    #[test]
    fn 树_本地没有根时采纳对方的整棵() {
        let theirs = nd("r", "中心主题", vec![nd("a", "A", vec![nd("a1", "A1", vec![])])]);
        let merged = merge_trees(None, Some(&theirs), &[]);
        assert_eq!(
            shape_of(merged.root.as_ref().unwrap()),
            vec!["中心主题", "  A", "    A1"]
        );
        // 两边都没有根 → 结果是"没有根"，**绝不凭空造一个**（造根那条路是红线）
        assert!(merge_trees(None, None, &[]).root.is_none());
    }

    #[test]
    fn 树_对方那棵的根id和本地不一样时挂到本地根下面() {
        // 极端情况（本地文件坏过、对方重建过根）：两边的根 id 不同。
        // 取本地那个当根（红线：本地根不许被换），对方那棵**整枝挂到它下面** —— 内容一个不丢。
        let mine = nd("r1", "我的中心主题", vec![]);
        let theirs = nd("r2", "他的中心主题", vec![nd("a", "A", vec![])]);
        let merged = merge_trees(Some(&mine), Some(&theirs), &[]);
        let root = merged.root.as_ref().unwrap();
        assert_eq!(root.id, "r1", "根还是本地那个");
        assert_eq!(
            shape_of(root),
            vec!["我的中心主题", "  他的中心主题", "    A"]
        );
    }

    #[test]
    fn 树_采纳的子树里被墓碑盖住的节点也不跟着过来() {
        let mine = nd("r", "中心主题", vec![]);
        let theirs = nd(
            "r",
            "中心主题",
            vec![nd("n", "新枝", vec![nd("n1", "枝里已经删掉的", vec![])])],
        );
        let merged = merge_trees(Some(&mine), Some(&theirs), &[node_grave("n1")]);
        assert_eq!(
            shape_of(merged.root.as_ref().unwrap()),
            vec!["中心主题", "  新枝"],
            "采纳整枝时也要按墓碑筛一遍"
        );
    }
}

#[cfg(test)]
mod award_sync_tests {
    use super::*;

    fn rec(kind: &str, id: &str, at: &str) -> Rec {
        Rec { kind: kind.into(), id: id.into(), updated_at: at.into(), json: serde_json::json!({ "id": id }) }
    }
    fn grave(id: &str, at: &str) -> Grave {
        Grave { id: id.into(), deleted_at: at.into(), kind: KIND_AWARD.into() }
    }

    const T0: &str = "2026-10-21T10:00:00+08:00";
    const T1: &str = "2026-10-21T11:00:00+08:00";

    #[test]
    fn 奖状_对方较新_我采纳() {
        let p = plan(&[rec(KIND_AWARD, "a", T0)], &[rec(KIND_AWARD, "a", T1)], &[], &[]);
        assert_eq!(p.take_theirs, vec!["a".to_string()]);
        assert!(p.conflicts.is_empty(), "奖状不该生成冲突副本");
    }

    #[test]
    fn 奖状_我较新_传给对方() {
        let p = plan(&[rec(KIND_AWARD, "a", T1)], &[rec(KIND_AWARD, "a", T0)], &[], &[]);
        assert_eq!(p.send_mine, vec!["a".to_string()]);
    }

    #[test]
    fn 奖状_时间一样_什么都不做() {
        let p = plan(&[rec(KIND_AWARD, "a", T0)], &[rec(KIND_AWARD, "a", T0)], &[], &[]);
        assert!(p.take_theirs.is_empty() && p.send_mine.is_empty() && p.conflicts.is_empty());
    }

    #[test]
    fn 奖状_对面删了_我也删() {
        let p = plan(&[rec(KIND_AWARD, "a", T0)], &[], &[], &[grave("a", T1)]);
        assert!(p.apply_graves.iter().any(|g| g.id == "a"));
    }

    #[test]
    fn 奖状_我删了_把墓碑传过去() {
        let p = plan(&[], &[rec(KIND_AWARD, "a", T0)], &[grave("a", T1)], &[]);
        assert!(p.send_graves.iter().any(|g| g.id == "a"));
        assert!(p.take_theirs.is_empty(), "被删的奖状不许被对面拉回来");
    }

    #[test]
    fn 奖状_墓碑也参与墓碑互传() {
        let p = plan(&[], &[], &[], &[grave("a", T1)]);
        assert!(p.apply_graves.iter().any(|g| g.id == "a"));
    }
}
