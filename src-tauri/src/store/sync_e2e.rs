//! M23 **端到端**测试（`#[cfg(test)]`，不进正式包）：两个真实数据目录 + **真 HTTP**。
//!
//! 这是"双目录端到端"的证据来源（验收里要求的那套）：
//! - **电脑侧**：`sync_server::start(&desk)` 起真服务（只绑局域网 IP + 一次性令牌 + 随机端口）
//! - **手机侧**：`sync_proto::run_client(&phone, base, token)` 走真 HTTP（ureq）
//! - 断言：两边**逐条一致**；冲突**两份都留**；删除**两边都没了**；中断/出错**能回滚**。
//!
//! ⚠️ 测试全程只用临时目录（`temp_store`），**绝不碰用户数据**。

#![cfg(test)]

use crate::models::{now_iso, Todo, TodoSource, TodoStatus};
use crate::store::{sync, sync_apply, sync_merge as merge, sync_proto, sync_server, temp_store, Store};

/// 相对"现在"的时间（ISO）：**测试里别用写死的时间** ——
/// 写死成未来的时刻会让"墓碑盖不盖得住记录"判反（2026-10-06 我就这么坑过自己一轮）。
fn ago(minutes: i64) -> String {
    (chrono::Local::now() - chrono::Duration::minutes(minutes)).to_rfc3339()
}

fn make_todo(id: &str, title: &str, at: &str) -> Todo {
    Todo {
        id: id.to_string(),
        title: title.to_string(),
        order: 0,
        planned_at: None,
        due_at: None,
        status: TodoStatus::Open,
        done_at: None,
        quadrant: None,
        source: TodoSource::default(),
        reminder_at: None,
        pomodoros: vec![],
        subtasks: vec![],
        repeat: None,
        repeat_from: None,
        focus_note: String::new(),
        group: String::new(),
        custom_minutes: None,
        created_at: at.to_string(),
        updated_at: at.to_string(),
    }
}

fn seed(store: &Store, id: &str, title: &str, at: &str) {
    let mut file = crate::store::todo::load(store).expect("读 todos");
    file.items.push(make_todo(id, title, at));
    crate::store::todo::save(store, &file).expect("写 todos");
}

/// 测试锚点的 id —— 只为"让快照有东西可备份"（`sync_server::start` 对空目录会拒绝，这是 M22 的既定行为）
const ANCHOR: &str = "__anchor__";

fn titles(store: &Store) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = crate::store::todo::list(store)
        .expect("列 todos")
        .into_iter()
        .filter(|one| one.id != ANCHOR)
        .map(|one| (one.id, one.title))
        .collect();
    out.sort();
    out
}

/// 起一次真同步（电脑 = desk，手机 = phone）
fn sync_once(desk: &Store, phone: &Store) -> sync_proto::ClientOutcome {
    // 用同步服务的测试**必须串行**（全局单例）—— 否则并发跑会互相抢槽、报"已经有一个同步在等着了"。
    // 注：guard 活到函数结束；测试若 panic 会让锁中毒，所以用 into_inner 兜住。
    let _serial = sync_server::TEST_SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // ⚠️ 服务是**全局单例**：上一个测试要是断言失败（panic）就来不及 cancel →
    //    后面的测试会一律报"已经有一个同步在等着了"。所以每次开场先清一遍。
    let _ = sync_server::cancel(desk);
    // 电脑侧必须有"东西可备份"，否则 `start` 会拒绝（空目录不许默默继续 —— M22 的既定行为）
    if crate::store::todo::list(desk).map(|one| one.is_empty()).unwrap_or(true) {
        seed(desk, ANCHOR, "（测试锚点）", &ago(180));
    }
    let status = sync_server::start(desk).expect("起同步服务");
    let base = format!("http://{}", status.address);
    let outcome = sync_proto::run_client(
        phone,
        &base,
        &sync_proto::Cred::Token(status.qr_text.rsplit('/').next().unwrap().to_string()),
    )
        .expect("跑一次客户端同步");
    sync_server::cancel(desk).expect("关掉服务");
    outcome
}

/// 🔴 2026-10-20（用户反馈「正文延迟」）：**同步落地成功之后，必须通知界面重拉一次**。
///
/// 不通知的后果正是用户那天报的：手机推上来的笔记**躺在 `notes/` 里、界面上看不见**，
/// 得手动刷新才出现（他原话「找到了，的确是没刷新」）。
/// 这条用**真 HTTP 的端到端同步**钉住：落地之后注册的那个回调**一定被调用过**。
///
/// ⚠️ 回调是**全局单例**，而测试是并行跑的 —— 别的用例同步时也会加计数，
/// 所以这里只断言"涨了"（捕获基线在自己这次同步之前），不会误报失败。
#[test]
fn e2e_落地成功后会通知界面重拉() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let desk = temp_store("m23-e2e-applied-desk");
    let phone = temp_store("m23-e2e-applied-phone");
    seed(&phone, "from-phone-applied", "手机上记的，落地后界面要能看见", &ago(130));

    static HITS: AtomicUsize = AtomicUsize::new(0);
    sync_server::set_applied_hook(Box::new(|| {
        HITS.fetch_add(1, Ordering::SeqCst);
    }));
    let before = HITS.load(Ordering::SeqCst);

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "同步应当成功：{}", outcome.message);
    assert!(
        HITS.load(Ordering::SeqCst) > before,
        "★ 落地成功之后必须调一次「数据变了」的回调（不然界面看不见同步来的东西）"
    );
}

#[test]
fn e2e_phone_new_todo_reaches_desktop() {
    let desk = temp_store("m23-e2e-a-desk");
    let phone = temp_store("m23-e2e-a-phone");
    seed(&phone, "from-phone", "手机上记的待办", &ago(120));

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "同步应当成功：{}", outcome.message);
    let on_desk = titles(&desk);
    assert_eq!(on_desk.len(), 1, "电脑上该出现这一条：{on_desk:?}");
    assert_eq!(on_desk[0].1, "手机上记的待办");
    assert!(phone.titles_for_test() >= 1, "手机自己那条要还在（收到电脑的锚点是正常的）");
    // 🔴 P1-1（2026-10-06）回归钉子：**账单数字必须与被传条数一致**。
    //    这里手机往上送了 1 条 → 手机账单的"传过去"就得是 1。
    //    （原来这里读的是电脑端账单的 `sent`＝"手机采纳了多少"→ 方向反了 → 用户看到四个 0。）
    assert_eq!(
        outcome.bill.sent, 1,
        "账单「传过去」该是 1（手机传上去的那条），实际 {}",
        outcome.bill.sent
    );
    // ⚠️ 电脑侧那条 `ANCHOR` 锚点也会走下来（它本来就是为了"让快照有东西可备份"而存在的）→ 所以是 ≥1。
    assert!(
        outcome.message.contains("传过去 1 条"),
        "账单文案也要对上，实际：{}",
        outcome.message
    );
}

#[test]
fn e2e_同步不会洗空电脑的档案笔记目录() {
    let desk = temp_store("m23-e2e-archive-desk");
    let phone = temp_store("m23-e2e-archive-phone");
    let note = crate::store::note::create(
        &desk,
        crate::models::NoteKind::Doc,
        "档案目录保护".to_string(),
    )
    .unwrap();
    crate::store::archive::put(&desk, "note", &note.id, "").unwrap();
    let archived = desk
        .data_dir()
        .join("notes")
        .join("_archive")
        .join(format!("{}.json", note.id));
    assert!(archived.is_file(), "收纳后档案目录应先有文件");
    std::fs::remove_file(&archived).unwrap();

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "同步应当成功：{}", outcome.message);
    assert!(
        archived.is_file(),
        "★ 同步发现档案文件缺失后必须从快照补回：{}",
        archived.display()
    );
    assert!(
        crate::store::archive::list(&desk)
            .unwrap()
            .iter()
            .any(|one| one.id == note.id),
        "档案条目也要还在"
    );
}

#[test]
fn e2e_desktop_new_todo_reaches_phone() {
    let desk = temp_store("m23-e2e-b-desk");
    let phone = temp_store("m23-e2e-b-phone");
    seed(&desk, "from-desk", "电脑上记的待办", &ago(120));

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok);
    let on_phone = titles(&phone);
    assert_eq!(on_phone.len(), 1, "手机上该出现电脑那条：{on_phone:?}");
    assert_eq!(on_phone[0].1, "电脑上记的待办");
    // 🔴 P1-1 回归钉子：这一趟是**电脑往下送** → 「补过来」= 1、「传过去」= 0。
    assert!(outcome.bill.adopted >= 1, "账单「补过来」该 ≥1（电脑那条 + 锚点），实际 {}", outcome.bill.adopted);
    assert_eq!(outcome.bill.sent, 0, "手机没往上送东西 → 「传过去」该是 0");
}

#[test]
fn e2e_newer_wins_whole_record() {
    let desk = temp_store("m23-e2e-c-desk");
    let phone = temp_store("m23-e2e-c-phone");
    seed(&desk, "same", "电脑上的旧标题", &ago(120));
    seed(&phone, "same", "手机上的新标题", &ago(60));

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok);
    let on_desk = titles(&desk);
    assert_eq!(on_desk.len(), 1);
    assert_eq!(on_desk[0].1, "手机上的新标题", "时间新的整条赢");
    let on_phone = titles(&phone);
    assert_eq!(on_phone[0].1, "手机上的新标题");
}

#[test]
fn e2e_same_moment_keeps_both() {
    let desk = temp_store("m23-e2e-d-desk");
    let phone = temp_store("m23-e2e-d-phone");
    let at = &ago(90);
    seed(&desk, "same", "电脑改的", at);
    seed(&phone, "same", "手机改的", at);

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok);
    assert!(outcome.bill.conflicts >= 1, "同一时刻应当算冲突：{}", outcome.message);

    let on_desk = titles(&desk);
    assert_eq!(on_desk.len(), 2, "两份都留（原件 + 冲突副本）：{on_desk:?}");
    let copied: Vec<&str> = on_desk
        .iter()
        .filter(|(_, t)| t.contains(merge::COPY_SUFFIX))
        .map(|(_, t)| t.as_str())
        .collect();
    assert_eq!(copied.len(), 1, "恰好一份副本：{on_desk:?}");
}

#[test]
fn e2e_delete_propagates_and_does_not_revive() {
    let desk = temp_store("m23-e2e-e-desk");
    let phone = temp_store("m23-e2e-e-phone");
    seed(&phone, "to-delete", "手机上这条要删", &ago(120));

    // 第一次同步：把这条搬到电脑
    sync_once(&desk, &phone);
    assert_eq!(titles(&desk).len(), 1);

    // 电脑上删掉（`todo::delete` 会埋墓碑）
    crate::store::todo::delete(&desk, "to-delete").expect("删待办");
    assert!(titles(&desk).is_empty());
    assert!(sync::list(&desk).unwrap().iter().any(|g| g.id == "to-delete"), "删除要留痕迹");

    // 第二次同步：手机那条该跟着没，而且**不许复活**
    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "{}", outcome.message);
    assert!(titles(&phone).is_empty(), "手机上该跟着删：{:?}", titles(&phone));
    assert!(titles(&desk).is_empty(), "电脑上别又被传回来");
}

#[test]
fn e2e_conflict_copy_id_is_new_on_both_sides() {
    let desk = temp_store("m23-e2e-f-desk");
    let phone = temp_store("m23-e2e-f-phone");
    let at = &ago(90);
    seed(&desk, "c1", "电脑版", at);
    seed(&phone, "c1", "手机版", at);
    sync_once(&desk, &phone);
    let desk_ids: Vec<String> = titles(&desk).into_iter().map(|(id, _)| id).collect();
    let phone_ids: Vec<String> = titles(&phone).into_iter().map(|(id, _)| id).collect();
    assert_eq!(desk_ids.len(), 2);
    assert_eq!(phone_ids.len(), 2);
    // 副本的 id 两端不同（各自生成）→ 这没关系；关键是**内容都在**、原件 id 都还在
    assert!(desk_ids.contains(&"c1".to_string()));
    assert!(phone_ids.contains(&"c1".to_string()));
}

#[test]
fn apply_rolls_back_when_a_record_is_bad() {
    // 「要么全成、要么不算」：给一条协议外的记录 → apply 必须失败且**原数据一字不变**
    let store = temp_store("m23-e2e-g-rollback");
    seed(&store, "keep", "原样别动", &ago(120));
    let before = titles(&store);

    let bad = merge::Rec {
        kind: "config".into(), // 协议里不传这个族
        id: "x".into(),
        updated_at: now_iso(),
        json: serde_json::json!({"a": 1}),
    };
    let plan = merge::Plan {
        take_theirs: vec!["x".into()],
        send_mine: vec![],
        conflicts: vec![],
        apply_graves: vec![],
        send_graves: vec![],
        skipped_only_in: vec![],
    };
    let err = sync_apply::apply(&store, &plan, &[bad], &[]).unwrap_err();
    assert!(err.contains("不认识") || err.contains("回滚"), "应当明确失败：{err}");
    assert_eq!(titles(&store), before, "失败后原数据必须一字不变（回滚生效）");
}

#[test]
fn e2e_格言按更新时间双向同步() {
    let desk = temp_store("m23-e2e-h-desk");
    let phone = temp_store("m23-e2e-h-phone");
    // 两边同一条格言、内容不同、时间不同 → 更新时间新的整条赢，两边最终一致
    let desk_json = serde_json::json!({
        "id": "m1", "text": "电脑这版", "from": "", "kind": "motto", "createdAt": &ago(60)
    });
    crate::store::mottos::save(
        &desk,
        &crate::models::MottoFile {
            items: vec![serde_json::from_value(desk_json).unwrap()],
        },
    )
    .unwrap();
    let phone_json = serde_json::json!({
        "id": "m1", "text": "手机这版", "from": "", "kind": "motto", "createdAt": &ago(120)
    });
    crate::store::mottos::save(
        &phone,
        &crate::models::MottoFile {
            items: vec![serde_json::from_value(phone_json).unwrap()],
        },
    )
    .unwrap();

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "{}", outcome.message);
    let desk_text = crate::store::mottos::list(&desk).unwrap()[0].text.clone();
    let phone_text = crate::store::mottos::list(&phone).unwrap()[0].text.clone();
    assert_eq!(desk_text, "电脑这版", "电脑那版更新，应保留");
    assert_eq!(phone_text, "电脑这版", "手机应拿到电脑那版");
}

#[test]
fn e2e_信息按更新时间双向同步() {
    let desk = temp_store("m23-e2e-info-two-way-desk");
    let phone = temp_store("m23-e2e-info-two-way-phone");
    let desk_info = crate::models::Info {
        id: "i1".into(),
        kind: crate::models::InfoKind::Text,
        text: "电脑的新信息".into(),
        asset_path: None,
        created_at: ago(120),
        updated_at: ago(30),
        categories: vec![],
        status: crate::models::InfoStatus::Pending,
        links: vec![],
    };
    let mut phone_info = desk_info.clone();
    phone_info.text = "手机的旧信息".into();
    phone_info.updated_at = ago(90);
    crate::store::info::write_all(&desk, &[desk_info]).unwrap();
    crate::store::info::write_all(&phone, &[phone_info]).unwrap();

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(crate::store::info::list(&desk).unwrap()[0].text, "电脑的新信息");
    assert_eq!(crate::store::info::list(&phone).unwrap()[0].text, "电脑的新信息");
}

#[test]
fn e2e_倒计时按更新时间双向同步() {
    let desk = temp_store("m23-e2e-countdown-two-way-desk");
    let phone = temp_store("m23-e2e-countdown-two-way-phone");
    let desk_one = crate::models::Countdown {
        id: "c1".into(),
        title: "电脑改过的考试".into(),
        date: "2026-12-20".into(),
        note: "新备注".into(),
        on_widget: true,
        updated_at: ago(30),
    };
    let mut phone_one = desk_one.clone();
    phone_one.title = "手机旧标题".into();
    phone_one.updated_at = ago(90);
    crate::store::countdown::save(
        &desk,
        &crate::models::CountdownFile { items: vec![desk_one] },
    )
    .unwrap();
    crate::store::countdown::save(
        &phone,
        &crate::models::CountdownFile { items: vec![phone_one] },
    )
    .unwrap();

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(crate::store::countdown::list(&desk).unwrap()[0].title, "电脑改过的考试");
    assert_eq!(crate::store::countdown::list(&phone).unwrap()[0].title, "电脑改过的考试");
}

#[test]
fn e2e_档案按更新时间双向同步() {
    let desk = temp_store("m23-e2e-archive-two-way-desk");
    let phone = temp_store("m23-e2e-archive-two-way-phone");
    let desk_entry = crate::models::ArchiveEntry {
        id: "a1".into(),
        kind: "free".into(),
        title: "电脑改过的档案".into(),
        summary: "电脑改过的正文".into(),
        snapshot: serde_json::json!({"title":"电脑改过的档案","content":"电脑改过的正文"}),
        archived_at: ago(120),
        updated_at: ago(30),
        note: String::new(),
    };
    let mut phone_entry = desk_entry.clone();
    phone_entry.title = "手机旧档案".into();
    phone_entry.updated_at = ago(90);
    crate::store::archive::save(
        &desk,
        &crate::models::ArchiveFile { items: vec![desk_entry] },
    )
    .unwrap();
    crate::store::archive::save(
        &phone,
        &crate::models::ArchiveFile { items: vec![phone_entry] },
    )
    .unwrap();

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(crate::store::archive::list(&desk).unwrap()[0].title, "电脑改过的档案");
    assert_eq!(crate::store::archive::list(&phone).unwrap()[0].title, "电脑改过的档案");
}

/// 给测试用的小工具（`Store` 本身没有"数几条待办"的方法）
trait TitlesForTest {
    fn titles_for_test(&self) -> usize;
}
impl TitlesForTest for Store {
    fn titles_for_test(&self) -> usize {
        crate::store::todo::list(self).map(|one| one.len()).unwrap_or(0)
    }
}



/// 🔴 P0-1（2026-10-06）**双目录端到端**：手机改过正文同步回来，
/// **电脑侧后加的树节点不许被抹掉**（用户真机验收报的"树在、内容没了"）。
#[test]
fn e2e_手机改正文不能抹掉电脑侧的树节点() {
    let desk = temp_store("m23-p01-desk");
    let phone = temp_store("m23-p01-phone");
    seed(&desk, ANCHOR, "锚点", &ago(120));

    // ① 电脑侧建一篇树笔记（中心主题 → 分支A），同步给手机
    let note =
        crate::store::note::create(&desk, crate::models::NoteKind::Tree, "树笔记".into()).unwrap();
    let mut first = note.clone();
    let mut root = crate::models::TreeNode::new("中心主题");
    root.children.push(crate::models::TreeNode::new("分支A"));
    first.root = Some(root);
    crate::store::note::save(&desk, &first).unwrap();

    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);
    let on_phone = crate::store::note::get(&phone, &note.id).unwrap().expect("手机侧该有这篇");
    assert_eq!(on_phone.root.as_ref().unwrap().children.len(), 1, "手机先拿到 1 个分支");

    // ② 电脑侧**又加了一个节点**（手机当然不知道）
    let mut second = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
    second
        .root
        .as_mut()
        .unwrap()
        .children
        .push(crate::models::TreeNode::new("分支B（电脑后加的）"));
    crate::store::note::save(&desk, &second).unwrap();
    // ⚠️ 把电脑这条的时间**往前挪 30 分钟**：不然"电脑加节点"和"手机改正文"落在 2 分钟容差内，
    //    按协议会被判成"同时改"→ 只留副本、正本不动（那是**正确行为**，但测不到下面这条保险）。
    //    挪旧之后"手机改正文"就是明确的更新 → 走"谁新听谁"→ 正好压到树笔记防丢那道保险上。
    {
        let path = crate::store::note::note_path(&desk, &note.id);
        let mut json = serde_json::to_value(&second).unwrap();
        json["updatedAt"] = serde_json::json!(ago(30));
        crate::store::atomic::atomic_write_json(&path, &json).unwrap();
    }

    // ③ 手机侧**只改标题 + 正文**（模拟手机编辑器自动保存；它手上那份 root 还是旧的）
    crate::store::note::set_text(
        &phone,
        &note.id,
        "手机改的标题".into(),
        "手机改的正文".into(),
    )
    .unwrap();

    // ④ 再同步：电脑侧要**保住分支B**，同时拿到手机改的文字
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    let after = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
    let kids: Vec<String> = after
        .root
        .as_ref()
        .unwrap()
        .children
        .iter()
        .map(|n| n.text.clone())
        .collect();
    assert!(
        kids.iter().any(|t| t.contains("分支B")),
        "🔴 电脑后加的节点被手机那份旧树抹掉了（P0-1 复发）：{kids:?}"
    );
    assert!(kids.iter().any(|t| t == "分支A"), "原来的分支也得在：{kids:?}");
    assert_eq!(after.content, "手机改的正文", "手机改的正文该传回来");
}

/// 🔴 **P1-2**（2026-10-06）回归钉子：**连着同步两次，中间既不重启程序、也不点取消**。
///
/// 用户真机验收撞到的原话是："已经有一个同步在等着了"，而且**界面上根本没地方取消** → 只能重启程序。
/// 根子是"一轮结束后会话还占在槽里"。所以这个测试**故意全程不调用 `cancel`**：
/// 第一轮成功之后状态必须**自己**回到 `idle`（并留着"上一轮完成"的交代）→ 第二轮必须能直接开始。
#[test]
fn e2e_two_syncs_in_a_row_without_restart_or_cancel() {
    let _serial = sync_server::TEST_SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let desk = temp_store("m23-p12-two-desk");
    let phone = temp_store("m23-p12-two-phone");
    seed(&desk, ANCHOR, "锚点", &ago(180));

    for round in 1..=2 {
        // 起一轮（**不提前 cancel**：位置该由上一轮自己让出来）
        let status = sync_server::start(&desk).unwrap_or_else(|e| panic!("第 {round} 轮起不来：{e}"));
        assert_eq!(status.phase, "waiting", "第 {round} 轮该在等手机");
        let base = format!("http://{}", status.address);
        let cred = sync_proto::Cred::Token(status.qr_text.rsplit('/').next().unwrap().to_string());

        // 手机这侧每轮都记一条新待办（内容不同 → 每轮都真有东西要传，能验出"第二轮是不是空跑"）
        seed(&phone, &format!("round-{round}"), &format!("第 {round} 轮记的待办"), &ago(60));
        let outcome = sync_proto::run_client(&phone, &base, &cred).expect("跑客户端同步");
        assert!(outcome.ok, "第 {round} 轮同步应当成功：{}", outcome.message);

        // ① **成功 = 这一轮自动结束**：状态回到 idle，并且留着"上一轮是什么结果"给界面看
        let after = sync_server::status(&desk);
        assert_eq!(after.phase, "idle", "第 {round} 轮成功后必须自己收工（不能还占着入口）：{after:?}");
        assert_eq!(after.last_result, "done", "上一轮结果要留着给界面看：{after:?}");
        assert!(after.last_message.contains("同步完成"), "{}", after.last_message);
        assert!(after.qr_svg.is_empty(), "收工之后二维码要作废");
        assert!(!after.last_sync_at.is_empty(), "同步成功要记下时间（设置页那句'上次同步'）");
    }

    // ② 两轮都真落地了
    let on_desk: Vec<String> = titles(&desk).into_iter().map(|(_, t)| t).collect();
    for round in 1..=2 {
        let want = format!("第 {round} 轮记的待办");
        assert!(on_desk.contains(&want), "第 {round} 轮那条该在电脑上：{on_desk:?}");
    }
    assert!(titles(&phone).len() >= 2, "手机自己那两条要还在：{:?}", titles(&phone));
}

/// 🔴 P0-1（2026-10-06）**双目录端到端**：手机**文本页**写的那行字，
/// 同步回来要**在电脑侧的树里出现成一个节点**（用户点名要的断言：正文要补进树）。
///
/// 与上一条互补：上一条测「不许抹掉电脑已有的节点」，这条测「手机写的字**进得去**」。
/// 走的路径和手机端真实保存**完全一样**（`CognitionZone.flush()` 就是这两步）：
/// `note::set_text`（只改标题/正文，不碰 root）→ `tree::append_text_saved`（把正文里还没进树的行补成节点）。
#[test]
fn e2e_手机正文补进电脑侧的树() {
    let desk = temp_store("m23-p01b-desk");
    let phone = temp_store("m23-p01b-phone");
    seed(&desk, ANCHOR, "锚点", &ago(120));

    // ① 电脑侧建一篇树笔记（中心主题 → 分支A），同步给手机
    let note =
        crate::store::note::create(&desk, crate::models::NoteKind::Tree, "树笔记".into()).unwrap();
    let mut first = note.clone();
    let mut root = crate::models::TreeNode::new("中心主题");
    root.children.push(crate::models::TreeNode::new("分支A"));
    first.root = Some(root);
    crate::store::note::save(&desk, &first).unwrap();
    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);

    // ② 把电脑这条往前挪 30 分钟：否则"手机改正文"落在 2 分钟容差内会被判成"同时改"
    //    → 只留冲突副本、正本不动（协议的正确行为，但那样就测不到下面这条了）。
    {
        let on_desk = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
        let path = crate::store::note::note_path(&desk, &note.id);
        let mut json = serde_json::to_value(&on_desk).unwrap();
        json["updatedAt"] = serde_json::json!(ago(30));
        crate::store::atomic::atomic_write_json(&path, &json).unwrap();
    }

    // ③ 手机侧按**真实保存路径**走：改正文 → 把正文里还没进树的行补成节点
    crate::store::note::set_text(
        &phone,
        &note.id,
        "树笔记".into(),
        "手机上写的一行".into(),
    )
    .unwrap();
    let added = crate::store::tree::append_text_saved(&phone, &note.id, "手机上写的一行").unwrap();
    assert_eq!(added, 1, "手机上这行字该被补成 1 个节点");
    let again = crate::store::tree::append_text_saved(&phone, &note.id, "手机上写的一行").unwrap();
    assert_eq!(again, 0, "同样的字补第二遍不许再长节点（幂等）");

    // ④ 同步：电脑侧的树里要出现这行字，原有的"分支A"一个都不许少
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    let after = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
    let kids: Vec<String> = after
        .root
        .as_ref()
        .unwrap()
        .children
        .iter()
        .map(|n| n.text.clone())
        .collect();
    assert!(
        kids.iter().any(|t| t == "手机上写的一行"),
        "🔴 手机文本页写的字没进电脑的树（P0-1 复发）：{kids:?}"
    );
    assert!(kids.iter().any(|t| t == "分支A"), "电脑原有的节点不许少：{kids:?}");
    assert_eq!(after.content, "手机上写的一行", "正文也该照旧在");
}

/// 用户真机验收里那篇 `未命名笔记`（doc）的**真实正文**，一字不改抄自
/// `.spike\recover-2026-10-06\now-未命名笔记.json`：
/// **75 个字**、里面两处 `toc` 写法（`toc第二章嘻嘻哈哈` / `toc 叽里呱啦`）、
/// 末尾「…就是那种markdown语法，很」是**他还没写完**（不是被截断）。
const REAL_CONTENT_75: &str = "toc第二章嘻嘻哈哈\n\n嘿嘿嘿\n\n\n\n\n\ntoc 叽里呱啦\n\n呵呵呵\n\n不对劲\n\ntoc 评测\n\n手机没有快捷键按钮，就是那种markdown语法，很";

/// 🔴 **用户点名要的断言**（2026-10-06）：**手机写的正文，同步回来一个字都不许少**。
///
/// 真机里的情形：电脑上这篇 `未命名笔记` 停在 `toc第二章嘻嘻哈哈`（**10 个字**，2026-09-29），
/// 他在手机上写到了 **75 个字**（末尾那句话还没写完）；同步前快照 `backups\sync-pre\<那一次>\notes\`
/// 里那份仍是 10 字 → 证明**手机上写的完整传过来了**。
/// 这条断言把两件事一起钉死：① 长度与内容**完全一致**（不是截断、不是丢了尾巴）；
/// ② 他手写的 `toc` 写法**原样保留**（同步只搬不改）。
#[test]
fn e2e_手机写的正文长度与内容必须一字不差地到电脑() {
    let desk = temp_store("m23-p13-len-desk");
    let phone = temp_store("m23-p13-len-phone");
    seed(&desk, ANCHOR, "锚点", &ago(240));
    // 钉住夹具本身：75 字（免得以后有人「顺手」改了这段字符串还不知道）
    assert_eq!(
        REAL_CONTENT_75.chars().count(),
        75,
        "这条钉子用的就是他真机那篇笔记的正文（75 字，含空白）"
    );

    // ① 电脑侧先有这篇（内容 10 字，时间停在 2026-09-29 —— 用「7 天前」表示很旧）
    let note = crate::store::note::create(&desk, crate::models::NoteKind::Doc, "未命名笔记".into()).unwrap();
    crate::store::note::set_text(&desk, &note.id, "未命名笔记".into(), "toc第二章嘻嘻哈哈".into())
        .unwrap();
    {
        let on_desk = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
        let path = crate::store::note::note_path(&desk, &note.id);
        let mut json = serde_json::to_value(&on_desk).unwrap();
        json["updatedAt"] = serde_json::json!(ago(60 * 24 * 7));
        crate::store::atomic::atomic_write_json(&path, &json).unwrap();
    }

    // ② 先同步一次：让手机也拿到这篇（同一 id）
    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);
    let on_phone = crate::store::note::get(&phone, &note.id).unwrap().expect("手机该有这篇");
    assert_eq!(on_phone.content, "toc第二章嘻嘻哈哈", "先给手机的是那 10 字旧版");

    // ③ 手机上把它写到 75 字（就是他在手机上写的那段）
    crate::store::note::set_text(&phone, &note.id, "未命名笔记".into(), REAL_CONTENT_75.to_string())
        .unwrap();

    // ④ 再同步：电脑侧必须是**手机那一整段**，一个字不多一个字不少
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    let after = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
    assert_eq!(
        after.content.chars().count(),
        REAL_CONTENT_75.chars().count(),
        "🔴 手机上写的正文长度和电脑侧不一致（截断/丢字）：电脑 {} 字、手机 {} 字",
        after.content.chars().count(),
        REAL_CONTENT_75.chars().count()
    );
    assert_eq!(after.content, REAL_CONTENT_75, "🔴 正文内容必须一字不差（含空白行）");
    assert!(
        after.content.ends_with("很"),
        "他「还没写完」的那半句结尾也得在：{:?}",
        &after.content[after.content.len().saturating_sub(12)..]
    );
    // 他手写的两种 toc 写法都要**原样保留**（同步只搬不改）
    assert!(after.content.contains("toc第二章嘻嘻哈哈"), "无空格的 toc 写法不许被改");
    assert!(after.content.contains("toc 叽里呱啦"), "带空格的 toc 写法不许被改");
}

/// 🔴 **红线钉子**（2026-10-06，上层点名要的）：树笔记的**正文可能是空的**，而树里有 8 个节点
/// （真实例子：`基础密码学的学习规划`＝`content` 空 + 8 个节点）。
///
/// 所以 P0-1 的修法只能是「**把正文里的新行追加进树**」，
/// **绝不能是「按 `content` 重建 `root`」** —— 重建会把这 8 个节点清光。
/// 这条断言就是专门拿来挡「重建」那种改法的：一旦有人改成重建，它会立刻红。
#[test]
fn e2e_树笔记正文是空的_手机加一行_原有八个节点一个不少() {
    let desk = temp_store("m23-p01c-desk");
    let phone = temp_store("m23-p01c-phone");
    seed(&desk, ANCHOR, "锚点", &ago(240));

    // ① 电脑侧：树笔记，**正文空**，树里 8 个分支（照他那篇的形状）
    let note =
        crate::store::note::create(&desk, crate::models::NoteKind::Tree, "基础密码学的学习规划".into()).unwrap();
    let mut first = note.clone();
    let mut root = crate::models::TreeNode::new("基础密码学的学习规划");
    for i in 1..=8 {
        root.children.push(crate::models::TreeNode::new(&format!("分支{i}")));
    }
    first.root = Some(root);
    crate::store::note::save(&desk, &first).unwrap();
    let before = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
    assert_eq!(before.content, "", "这篇的正文本来就是空的（这正是「重建」会出事的场景）");
    assert_eq!(before.root.as_ref().unwrap().children.len(), 8);

    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);
    let on_phone = crate::store::note::get(&phone, &note.id).unwrap().expect("手机该有这篇");
    assert_eq!(on_phone.root.as_ref().unwrap().children.len(), 8, "手机上先拿到 8 个分支");

    // ② 电脑这条往前挪 30 分钟（避开 2 分钟容差，理由同上面那条测试）
    {
        let on_desk = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
        let path = crate::store::note::note_path(&desk, &note.id);
        let mut json = serde_json::to_value(&on_desk).unwrap();
        json["updatedAt"] = serde_json::json!(ago(30));
        crate::store::atomic::atomic_write_json(&path, &json).unwrap();
    }

    // ③ 手机端按**真实保存路径**：文本页写一行 → 补进树
    crate::store::note::set_text(&phone, &note.id, "基础密码学的学习规划".into(), "手机上写的新一行".into())
        .unwrap();
    let added = crate::store::tree::append_text_saved(&phone, &note.id, "手机上写的新一行").unwrap();
    assert_eq!(added, 1, "手机上这行该补成 1 个节点");

    // ④ 同步：电脑侧 = 原 8 个 + 新的 1 个（**绝不许被「重建」清成 1 个**）
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    let after = crate::store::note::get(&desk, &note.id).unwrap().unwrap();
    let kids: Vec<String> = after.root.as_ref().unwrap().children.iter().map(|n| n.text.clone()).collect();
    for i in 1..=8 {
        assert!(
            kids.iter().any(|t| t == &format!("分支{i}")),
            "🔴 原有节点被清掉了（就是「按 content 重建 root」那种改法干的）：{kids:?}"
        );
    }
    assert!(kids.iter().any(|t| t == "手机上写的新一行"), "手机写的字要进树：{kids:?}");
    assert_eq!(kids.len(), 9, "应当是 8 个原有 + 1 个新的：{kids:?}");
}

// ───────────────────── M26：图片（`assets/`）也同步 ─────────────────────
//
// 协议附录四：**只增不删的并集**。这几条测试就是那份附录的可执行版本。

/// 造一张"长得像图"的字节（落盘不验魔数，但用真 PNG 头更像回事）
fn fake_png(tag: &str) -> Vec<u8> {
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    out.extend_from_slice(tag.as_bytes());
    out
}

#[test]
fn e2e_图片两边互相补齐_且没有新图时不再重复传() {
    use crate::store::assets::{self, Incoming};
    let desk = temp_store("m26-e2e-img-desk");
    let phone = temp_store("m26-e2e-img-phone");

    let desk_name = "11111111-1111-1111-1111-111111111111.png";
    let phone_name = "22222222-2222-2222-2222-222222222222.jpg";
    let desk_img = fake_png("desktop-image");
    let phone_img = fake_png("phone-image");
    assert_eq!(assets::save_incoming(&desk, desk_name, &desk_img).unwrap(), Incoming::Saved);
    assert_eq!(assets::save_incoming(&phone, phone_name, &phone_img).unwrap(), Incoming::Saved);

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "同步应当成功：{}", outcome.message);

    // ① 电脑那张到了手机（**字节一模一样**）
    assert_eq!(
        assets::read(&phone, desk_name).unwrap(),
        desk_img,
        "电脑那张图该补到手机上"
    );
    // ② 手机那张传回了电脑
    assert_eq!(
        assets::read(&desk, phone_name).unwrap(),
        phone_img,
        "手机那张图该传回电脑"
    );
    // ③ 手机视角的账单：补过来 1 张 / 传过去 1 张
    assert_eq!(outcome.bill.assets_adopted, 1, "手机账单「图片补过来」：{}", outcome.message);
    assert_eq!(outcome.bill.assets_sent, 1, "手机账单「图片传过去」：{}", outcome.message);

    // ④ **再同步一次**：两边清单已经一样 → 一张都不该再传（"不重复传"这条钉子）
    let again = sync_once(&desk, &phone);
    assert!(again.ok, "{}", again.message);
    assert_eq!(again.bill.assets_adopted, 0, "没有新图就不该再补：{}", again.message);
    assert_eq!(again.bill.assets_sent, 0, "没有新图就不该再传：{}", again.message);
}

#[test]
fn e2e_图片同名不同大小_两边各自留着并且报一句() {
    use crate::store::assets;
    let desk = temp_store("m26-e2e-clash-desk");
    let phone = temp_store("m26-e2e-clash-phone");
    let name = "33333333-3333-3333-3333-333333333333.png";
    let desk_img = fake_png("DESKTOP-ONE");
    let phone_img = fake_png("PHONE-ONE-LONGER");
    assert_ne!(desk_img.len(), phone_img.len(), "这条测试要靠长度不同");
    assets::save_incoming(&desk, name, &desk_img).unwrap();
    assets::save_incoming(&phone, name, &phone_img).unwrap();

    let outcome = sync_once(&desk, &phone);
    assert!(outcome.ok, "{}", outcome.message);
    // 谁也没覆盖谁
    assert_eq!(assets::read(&desk, name).unwrap(), desk_img, "电脑那张不能被动");
    assert_eq!(assets::read(&phone, name).unwrap(), phone_img, "手机那张不能被动");
    assert_eq!(outcome.bill.assets_adopted, 0);
    assert_eq!(outcome.bill.assets_sent, 0);
    // 而且**手机上也看得到这句提示**（冲突清单跟着账单下来）
    assert_eq!(outcome.bill.assets_clash, vec![name.to_string()], "要报出是哪张：{}", outcome.message);
    assert!(outcome.message.contains("内容不一样"), "手机上要有这句：{}", outcome.message);
}

// ───────────────────── 树 B：两端都能改树（逐节点合并）─────────────────────
//
// 这三条是《树 B》的端到端证据（双数据目录 + 真 HTTP，写法照上面的 `sync_once`）。
// 要钉住的那句话是：**树笔记不再"整棵树谁赢"** —— 两端各自的改动都得留住。

/// 造一篇树笔记：`中心主题 → 参数里那几个分支`。返回（笔记 id, 根 id, 各分支 id）
fn seed_tree(store: &Store, texts: &[&str]) -> (String, String, Vec<String>) {
    let note = crate::store::note::create(store, crate::models::NoteKind::Tree, "两端都能改的树".into())
        .expect("建树笔记");
    let mut root = crate::models::TreeNode::new("中心主题");
    for text in texts {
        root.children.push(crate::models::TreeNode::new(*text));
    }
    let mut saved = note.clone();
    saved.root = Some(root);
    crate::store::note::save(store, &saved).expect("写树笔记");
    let root = saved.root.as_ref().expect("树笔记一定有根");
    (
        note.id,
        root.id.clone(),
        root.children.iter().map(|one| one.id.clone()).collect(),
    )
}

/// 一篇树笔记里所有节点的文字（含所有层级）—— 断言"谁在谁不在"用它最直观
fn tree_texts(store: &Store, note_id: &str) -> Vec<String> {
    fn walk(node: &crate::models::TreeNode, out: &mut Vec<String>) {
        out.push(node.text.clone());
        for child in &node.children {
            walk(child, out);
        }
    }
    let mut out = Vec::new();
    if let Some(note) = crate::store::note::get(store, note_id).expect("读树笔记") {
        if let Some(root) = note.root.as_ref() {
            walk(root, &mut out);
        }
    }
    out
}

/// ① **两端各往同一个父节点下加一个** → 同步后两边都得有**这两个**（不是"谁赢"）。
///
/// 时序上刻意让两次编辑落在同一分钟内：协议对这种"两边都改过"给的就是**两边互相交换内容**
/// （`same_moment` 冲突），正好是"两端都能改树"的真实场景（他在电脑画布上加、又在手机上加）。
#[test]
fn e2e_两端各往同一个父节点下加一个_同步后两边都有() {
    let desk = temp_store("m23-tree-b-a-desk");
    let phone = temp_store("m23-tree-b-a-phone");
    seed(&desk, ANCHOR, "锚点", &ago(180));

    // ① 电脑侧建树（中心主题 → 分支A），同步一次：两端从此握着**同一批节点 id**
    let (note_id, _root, kids) = seed_tree(&desk, &["分支A"]);
    let same_parent = kids[0].clone();
    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);
    assert_eq!(tree_texts(&phone, &note_id).len(), 2, "手机先拿到 中心主题 + 分支A");

    // ② 两端**都**改这棵树：各自往同一个父节点下加一个（互不知情）
    crate::store::tree::add_child_saved(&desk, &note_id, &same_parent, Some("电脑加的".into()))
        .expect("电脑加子节点");
    crate::store::tree::add_child_saved(&phone, &note_id, &same_parent, Some("手机加的".into()))
        .expect("手机加子节点");

    // ③ 同步：两台机器上都得有**这两个**节点
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    for (who, store) in [("电脑", &desk), ("手机", &phone)] {
        let texts = tree_texts(store, &note_id);
        assert!(texts.contains(&"电脑加的".to_string()), "🔴 {who}侧少了「电脑加的」：{texts:?}");
        assert!(texts.contains(&"手机加的".to_string()), "🔴 {who}侧少了「手机加的」：{texts:?}");
        assert!(texts.contains(&"分支A".to_string()), "{who}侧原有的分支A不许少：{texts:?}");
        assert_eq!(texts.len(), 4, "{who}侧节点数不对（少了=丢节点、多了=重复采纳）：{texts:?}");
        assert!(
            !texts.iter().any(|one| one.contains(merge::COPY_SUFFIX)),
            "{who}侧不该冒出冲突副本（两边加的是**不同**的节点，不是改同一个）：{texts:?}"
        );
    }

    // ④ 再同步一次：**合并必须幂等**（不许越长越多、不许每趟多一份副本）
    let r3 = sync_once(&desk, &phone);
    assert!(r3.ok, "{}", r3.message);
    for (who, store) in [("电脑", &desk), ("手机", &phone)] {
        let texts = tree_texts(store, &note_id);
        assert_eq!(texts.len(), 4, "🔴 {who}侧再同步一次就变了（不幂等）：{texts:?}");
    }
}

/// ② **手机删掉一个节点** → 同步后两边都没了，而且**再同步一次也不会复活**。
#[test]
fn e2e_手机删掉一个节点_两边都没了且再同步也不会复活() {
    let desk = temp_store("m23-tree-b-b-desk");
    let phone = temp_store("m23-tree-b-b-phone");
    seed(&desk, ANCHOR, "锚点", &ago(180));

    // ① 电脑侧建树（中心主题 → 要删掉的 / 留着的），同步给手机
    let (note_id, _root, kids) = seed_tree(&desk, &["要删掉的", "留着的"]);
    let doomed = kids[0].clone();
    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);
    assert_eq!(tree_texts(&phone, &note_id).len(), 3);

    // ② 电脑这条时间往前挪 30 分钟：让"手机删节点"是**明确的新改动**（避开 2 分钟容差，
    //    这样走的是"谁新听谁"+ 墓碑那条路，而不是"两边都改过"的冲突那条路）
    {
        let on_desk = crate::store::note::get(&desk, &note_id).unwrap().unwrap();
        let path = crate::store::note::note_path(&desk, &note_id);
        let mut json = serde_json::to_value(&on_desk).unwrap();
        json["updatedAt"] = serde_json::json!(ago(30));
        crate::store::atomic::atomic_write_json(&path, &json).unwrap();
    }

    // ③ 手机上删掉那个节点（走真实命令 → 会埋墓碑）
    let removed = crate::store::tree::remove_saved(&phone, &note_id, &doomed).expect("删节点");
    assert_eq!(removed.removed, 1, "「要删掉的」是叶节点，正好删 1 个");
    assert!(
        sync::list(&phone)
            .unwrap()
            .iter()
            .any(|one| one.id == doomed && one.kind == "treenode"),
        "🔴 删节点必须留墓碑（kind = treenode），否则对面会把它原样传回来复活"
    );

    // ④ 同步：**两边都没了**，别的节点一个不许少
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    for (who, store) in [("电脑", &desk), ("手机", &phone)] {
        let texts = tree_texts(store, &note_id);
        assert!(!texts.contains(&"要删掉的".to_string()), "{who}侧那个节点该没了：{texts:?}");
        assert!(texts.contains(&"留着的".to_string()), "{who}侧别的节点不许少：{texts:?}");
        assert!(texts.contains(&"中心主题".to_string()), "{who}侧根节点必须还在：{texts:?}");
    }

    // ⑤ 再同步一次：**不许复活**（墓碑还在，两端都不许把它传回来）
    let r3 = sync_once(&desk, &phone);
    assert!(r3.ok, "{}", r3.message);
    for (who, store) in [("电脑", &desk), ("手机", &phone)] {
        let texts = tree_texts(store, &note_id);
        assert!(
            !texts.contains(&"要删掉的".to_string()),
            "🔴 {who}侧那个已删的节点复活了：{texts:?}"
        );
    }
}

/// ③ **两端改同一个节点的文字** → 同步后**两段文字都在**（一段成了「（冲突副本）」子节点）。
#[test]
fn e2e_两端改同一个节点的文字_两段都留着_一段成冲突副本() {
    let desk = temp_store("m23-tree-b-c-desk");
    let phone = temp_store("m23-tree-b-c-phone");
    seed(&desk, ANCHOR, "锚点", &ago(180));

    // ① 电脑侧建树（中心主题 → 原来那句话），同步给手机
    let (note_id, _root, kids) = seed_tree(&desk, &["原来那句话"]);
    let node = kids[0].clone();
    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);

    // ② 两端**都**改这一个节点的文字（同一分钟内 → 两边都改过）
    crate::store::tree::set_text_saved(&desk, &note_id, &node, "电脑改成的话".into())
        .expect("电脑改文字");
    crate::store::tree::set_text_saved(&phone, &note_id, &node, "手机改成的话".into())
        .expect("手机改文字");

    // ③ 同步：两段文字都要在，而且有一段是「（冲突副本）」
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    // 某一段文字在不在：正本上就是它本身，成了副本就是"它 + （冲突副本）"
    // （两端各自"保留本地文字"，所以哪一段当正本、哪一段当副本，两台机器上正好相反）
    let has = |texts: &[String], want: &str| {
        texts
            .iter()
            .any(|one| one == want || one == &format!("{want}{}", merge::COPY_SUFFIX))
    };
    for (who, store) in [("电脑", &desk), ("手机", &phone)] {
        let texts = tree_texts(store, &note_id);
        assert!(has(&texts, "电脑改成的话"), "🔴 {who}侧少了电脑那段文字：{texts:?}");
        assert!(has(&texts, "手机改成的话"), "🔴 {who}侧少了手机那段文字：{texts:?}");
        assert!(
            texts.iter().any(|one| one.ends_with(merge::COPY_SUFFIX)),
            "{who}侧该有一段被留成「（冲突副本）」子节点：{texts:?}"
        );
        // 正本还是**原来那个节点 id**（冲突没有把它换成两个新节点）
        let found = crate::store::note::get(store, &note_id).unwrap().unwrap();
        assert!(
            crate::store::tree::find(found.root.as_ref().unwrap(), &node).is_some(),
            "{who}侧正本节点不见了（id 被换掉了）：{texts:?}"
        );
    }

    // ④ 再同步一次：**不许越长越多**（副本已经留过了就不再留第二份）
    let r3 = sync_once(&desk, &phone);
    assert!(r3.ok, "{}", r3.message);
    for (who, store) in [("电脑", &desk), ("手机", &phone)] {
        let texts = tree_texts(store, &note_id);
        assert!(has(&texts, "电脑改成的话"), "🔴 {who}侧第二趟把电脑那段弄丢了：{texts:?}");
        assert!(has(&texts, "手机改成的话"), "🔴 {who}侧第二趟把手机那段弄丢了：{texts:?}");
        assert!(
            texts.iter().filter(|one| one.ends_with(merge::COPY_SUFFIX)).count() <= 2,
            "🔴 {who}侧的冲突副本越滚越多（幂等破了）：{texts:?}"
        );
    }
}

// ───────────── 树 B 补：**一趟就得收敛**（时间差超出容差时内容原来只往一个方向流）─────────────
//
// 缺陷现场（上一轮实测确认）：两端各给同一篇树笔记加一个节点、两边的改动时间**差得超过 2 分钟**
// （超出时钟容差）时，这一趟走的是"谁新听谁"，于是**内容只往一个方向流**：
//   · 输的那一端：采纳了赢的那份 → 本地逐节点合并 → 两个节点都有 ✓；
//   · 可回给它的 `records` 里没有"合并结果"（只装 `send_mine` + 冲突）→ 赢的那一端拿不到对方的节点 ✗；
//   · 再同步一趟 `mark_synced` 之后 `since` 闸门又判"两边都没动过" → 还是拿不到 ✗。
// 这三条按"一趟就收敛 / 不再滚雪球 / 反向也一趟收敛"钉死。

/// 把一篇笔记的 `updatedAt` 直接改成指定时刻。
///
/// ⚠️ **不能走 `note::save`**（它会把时间盖成"现在"），而这几条测试要的正是"两端改动差 20 分钟"。
fn set_note_time(store: &Store, note_id: &str, at: &str) {
    let note = crate::store::note::get(store, note_id).expect("读树笔记").expect("这篇树笔记该在");
    let path = crate::store::note::note_path(store, note_id);
    let mut json = serde_json::to_value(&note).expect("序列化");
    json["updatedAt"] = serde_json::json!(at);
    crate::store::atomic::atomic_write_json(&path, &json).expect("改笔记时间");
}

/// 把"上次同步时间"挪到 `at`。
///
/// 为什么非挪不可（踩过的坑）：`plan_with` 的 `since` 闸门会把"两边都没在上次同步之后改过"的记录
/// 整条跳过。而"把 `updatedAt` 设成 10 / 30 分钟前"在**刚同步完**的测试里正好落在闸门之后 →
/// 这趟**什么都不做**（测出来的就不是合并了）。挪到 1 小时前 = "这两笔改动确实是上次同步之后做的"，
/// 这才是真机上"改完就同步"的样子（改动时间 ≈ 现在 > 上次同步时间）。
fn rewind_last_sync(store: &Store, at: &str) {
    sync::mark_synced(store, at).expect("挪上次同步时间");
}

/// 造出缺陷现场：两端各加一个节点、各自的时间由调用方给定（`desk_at` / `phone_at`），然后同步一趟。
///
/// 返回（电脑目录, 手机目录, 树笔记 id, 那一趟的结果）。两端加的文字固定是「电脑加的」「手机加的」。
fn 两端各加一个节点并同步(
    tag: &str,
    desk_at: &str,
    phone_at: &str,
) -> (Store, Store, String, sync_proto::ClientOutcome) {
    let desk = temp_store(&format!("m23-tree-b-{tag}-desk"));
    let phone = temp_store(&format!("m23-tree-b-{tag}-phone"));
    seed(&desk, ANCHOR, "锚点", &ago(180));

    // ① 电脑侧建树（中心主题 → 分支A），同步一次：两端从此握着**同一批节点 id**
    let (note_id, _root, kids) = seed_tree(&desk, &["分支A"]);
    let same_parent = kids[0].clone();
    let r1 = sync_once(&desk, &phone);
    assert!(r1.ok, "第一次同步应当成功：{}", r1.message);
    assert_eq!(tree_texts(&phone, &note_id).len(), 2, "手机先拿到 中心主题 + 分支A");

    // ② 两端**都**改这棵树：各自往同一个父节点下加一个（互不知情）
    crate::store::tree::add_child_saved(&desk, &note_id, &same_parent, Some("电脑加的".into()))
        .expect("电脑加子节点");
    crate::store::tree::add_child_saved(&phone, &note_id, &same_parent, Some("手机加的".into()))
        .expect("手机加子节点");

    // ③ 把两端的改动时间改成"差 20 分钟"（超出 2 分钟容差 → 走"谁新听谁"，不是"两边都改过"）
    set_note_time(&desk, &note_id, desk_at);
    set_note_time(&phone, &note_id, phone_at);
    // ④ 把"上次同步时间"挪到 1 小时前（理由见 `rewind_last_sync`）；两端都挪 = "上次同步是很久以前"
    rewind_last_sync(&desk, &ago(60));
    rewind_last_sync(&phone, &ago(60));

    // ⑤ 就同步**这一趟**
    let r2 = sync_once(&desk, &phone);
    assert!(r2.ok, "第二次同步应当成功：{}", r2.message);
    (desk, phone, note_id, r2)
}

/// 两端都同时有「电脑加的」和「手机加的」，而且**没有**冒出冲突副本、节点数正好 4
fn 断言两端节点齐全(desk: &Store, phone: &Store, note_id: &str) {
    for (who, store) in [("电脑", desk), ("手机", phone)] {
        let texts = tree_texts(store, note_id);
        assert!(texts.contains(&"电脑加的".to_string()), "🔴 {who}侧少了「电脑加的」：{texts:?}");
        assert!(texts.contains(&"手机加的".to_string()), "🔴 {who}侧少了「手机加的」：{texts:?}");
        assert!(texts.contains(&"分支A".to_string()), "{who}侧原有的分支A不许少：{texts:?}");
        assert!(texts.contains(&"中心主题".to_string()), "{who}侧根节点必须还在：{texts:?}");
        assert_eq!(texts.len(), 4, "{who}侧节点数不对（少了=丢节点、多了=重复采纳）：{texts:?}");
        assert!(
            !texts.iter().any(|one| one.contains(merge::COPY_SUFFIX)),
            "{who}侧冒出「（冲突副本）」了（两边加的是**不同**的节点，不该有副本）：{texts:?}"
        );
    }
}

/// ④ **一趟就收敛**：电脑加 A（`ago(10)`）、手机加 B（`ago(30)`）—— 差 20 分钟。
///
/// 🔴 这条是缺陷的正面钉子：修之前，赢的那一端（这里是电脑，它的改动更新）拿不到手机那个节点
///    —— 手机采纳了电脑那份、可电脑的"合并结果"没有回传（再同步一趟又被 `since` 挡住）。
#[test]
fn e2e_两端各加一个节点_时间差超出容差_一趟同步两边都有() {
    let (desk, phone, note_id, _r2) = 两端各加一个节点并同步("g", &ago(10), &ago(30));
    断言两端节点齐全(&desk, &phone, &note_id);
}

/// ⑤ **不再重复、不再滚雪球**：收敛之后再同步一趟 → 两边节点数**不变**、冲突 0、没生成任何副本。
///
/// 钉的是"回传合并结果"这件事**不许**引出新的毛病：不能每趟都重复采纳、不能越长越多，
/// 更不能因为回传而互相判成"都改过"（那就会生副本、笔记滚雪球）。
#[test]
fn e2e_收敛之后再同步一趟_节点数不变且没有新的冲突副本() {
    let (desk, phone, note_id, _r2) = 两端各加一个节点并同步("h", &ago(10), &ago(30));
    断言两端节点齐全(&desk, &phone, &note_id);
    let before_desk = tree_texts(&desk, &note_id).len();
    let before_phone = tree_texts(&phone, &note_id).len();

    // 紧接着再来一趟
    let r3 = sync_once(&desk, &phone);
    assert!(r3.ok, "第三趟同步应当成功：{}", r3.message);
    assert_eq!(r3.bill.conflicts, 0, "两边内容已经一样了 → 不该再有冲突：{}", r3.message);
    // 🔴 这一趟**一条都不该再传**：闸门（`since`）+ "只在真并出差异时才夹带"两条都得站得住，
    //    否则就是白烧流量、账单虚涨（上一轮点名的红线）。
    assert_eq!(
        (r3.bill.adopted, r3.bill.sent),
        (0, 0),
        "两边已经一样了，第三趟不该再搬东西（白烧流量/账单虚涨）：{}",
        r3.message
    );
    for (who, store, before) in [("电脑", &desk, before_desk), ("手机", &phone, before_phone)] {
        let texts = tree_texts(store, &note_id);
        assert_eq!(texts.len(), before, "🔴 {who}侧再同步一趟节点数就变了：{texts:?}");
        assert_eq!(texts.len(), 4, "{who}侧节点数不对：{texts:?}");
        assert!(
            !texts.iter().any(|one| one.contains(merge::COPY_SUFFIX)),
            "🔴 {who}侧第二趟冒出了「（冲突副本）」（滚雪球的前兆）：{texts:?}"
        );
    }
}

/// ⑥ **反向也一趟收敛**：时间反过来（手机那笔是 `ago(10)`、电脑那笔是 `ago(30)`）——
///    这一趟是**手机赢**，走的正是"电脑采纳对方的记录 + 逐节点合并"那条路：
///    电脑这侧两个节点都有（一直如此 ✓），缺的是**回给手机的合并结果**（修好了 ✗→✓）。
#[test]
fn e2e_反向_手机赢的那一趟也要把合并结果回传() {
    let (desk, phone, note_id, _r2) = 两端各加一个节点并同步("i", &ago(30), &ago(10));
    断言两端节点齐全(&desk, &phone, &note_id);

    // 再同步一趟：两边已经一样 → 节点数不变、没有冲突、没有副本
    let before = tree_texts(&desk, &note_id).len();
    let r3 = sync_once(&desk, &phone);
    assert!(r3.ok, "{}", r3.message);
    assert_eq!(r3.bill.conflicts, 0, "{}", r3.message);
    for (who, store) in [("电脑", &desk), ("手机", &phone)] {
        let texts = tree_texts(store, &note_id);
        assert_eq!(texts.len(), before, "🔴 {who}侧再同步一趟节点数就变了：{texts:?}");
        assert_eq!(texts.len(), 4, "{who}侧节点数不对：{texts:?}");
        assert!(
            !texts.iter().any(|one| one.contains(merge::COPY_SUFFIX)),
            "🔴 {who}侧第二趟冒出了「（冲突副本）」：{texts:?}"
        );
    }
}


