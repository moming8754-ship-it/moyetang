// M4 验收脚手架：`run.ps1` 会把它拼在每个步骤前面，两段在同一个 eval 里执行。
// 所以步骤文件可以直接用这里的 `$` / `pointerClick` / `check` 等。
//
// ⚠️ 教训（进度.md 第五节记过）：
// - `window.confirm/prompt` 在 Tauri WebView 里不生效 → 一律用页面里的自建弹窗
// - 用 DOM Range 设的选区 CodeMirror 不认 → 驱动 CM6 要用合成键盘事件
// - 对象键不要用 `☐` 这类符号 → 用 out["点☐后..."]

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");

const results = [];
/** 记一条断言。`detail` 只在失败时看，但都留着方便排查 */
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/** 等一个条件成立（默认 5 秒）—— 后端写盘是异步的，不能立刻断言。
 *  `fn` 可以是同步的，也可以返回 Promise（`await` 会处理两种情况）。 */
async function waitFor(fn, timeout = 5000, step = 60) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

/** 整棵子树的节点数（含自己）—— 和 Rust `tree::count_nodes` 一个算法 */
function countAll(node) {
  return (node.children || []).reduce((sum, child) => sum + countAll(child), 1);
}

// ─────────────────── 指针 / 键盘 / 输入 ───────────────────
//
// ⚠️ 关键：树状画的选中走的是 **pointerdown**，`el.click()` 不会触发它。
// 所以必须派发真实的 PointerEvent 序列，否则"点了节点但没选中"。

function pev(type, el, opts) {
  const o = opts || {};
  const rect = el.getBoundingClientRect();
  const clientX = o.clientX !== undefined ? o.clientX : rect.left + rect.width / 2;
  const clientY = o.clientY !== undefined ? o.clientY : rect.top + rect.height / 2;
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: o.button !== undefined ? o.button : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: o.pointerId || 1,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
}

/** 完整的"点一下"：pointerdown → pointerup → click */
function pointerClick(el, opts) {
  const o = opts || {};
  pev('pointerdown', el, o);
  pev('pointerup', el, o);
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: o.clientX !== undefined ? o.clientX : rect.left + rect.width / 2,
      clientY: o.clientY !== undefined ? o.clientY : rect.top + rect.height / 2,
    }),
  );
}

function dblClick(el) {
  el.dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window }),
  );
}

function key(el, k, extra) {
  const init = Object.assign(
    { key: k, code: k, bubbles: true, cancelable: true, composed: true, view: window },
    extra || {},
  );
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

function wheel(el, deltaY, clientX, clientY) {
  // ⚠️ 2026-10-25（反馈·1022 #3）：画布改成**必须按 Ctrl 才缩放**，所以这里要带 ctrlKey，
  //    否则等于"滚了一下什么都没发生"（旧断言会假红）。
  el.dispatchEvent(
    new WheelEvent('wheel', {
      deltaY,
      deltaX: 0,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
    }),
  );
}

/** 给受控输入框赋值并让 React 收到 onChange（直接改 .value 是不行的） */
function setValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ─────────────────── 页面导航 / 查找 ───────────────────

/**
 * 等应用真的起来了（导航栏在）。
 *
 * 每个步骤开头都调一次：窗口可能刚重载过、或者上一步把它留在了别的状态，
 * 不先等一等就去找元素，只会得到一堆莫名其妙的"找不到"。
 */
async function ready() {
  const ok = await waitFor(
    () =>
      $$('button').some(
        (b) =>
          (b.innerText || '').indexOf('认知区') >= 0 || b.getAttribute('title') === '认知区',
      ),
    15000,
  );
  if (!ok) throw new Error('应用没起来：导航栏找不到（等了 15 秒）');
  await sleep(300);
  return true;
}

/**
 * 切页面。
 *
 * ⚠️ 两个坑：
 * 1. 导航按钮的 innerText 里带 emoji 和换行 → 用 indexOf 而不是 ===；
 * 2. **侧边栏可以收起**，收起后按钮里只剩 emoji、文字挪到了 `title` 上 ——
 *    只按文字找会在"收起"状态下直接找不到（M4 验收时真踩到了）。所以文字和 title 都要试。
 */
async function nav(name) {
  const btn = await waitFor(() => {
    const all = $$('button');
    return (
      all.find((b) => (b.innerText || '').indexOf(name) >= 0) ||
      all.find((b) => b.getAttribute('title') === name) ||
      null
    );
  }, 10000);
  if (!btn) throw new Error('找不到导航按钮：' + name);
  btn.click();
  await sleep(650);
  return btn;
}

/** 按 title 找按钮（三图标就是靠 title 定位的，稳） */
function byTitle(title, root) {
  return $$('[title]', root).find((el) => el.getAttribute('title') === title) || null;
}

/** 画布上的节点（按文字找；空节点用 data-node-id） */
function nodeByText(text) {
  return $$('[data-node-id]').find((el) => (el.getAttribute('data-node-text') || '') === text) || null;
}
function nodeById(id) {
  return $('[data-node-id="' + id + '"]');
}
/** 当前画布上所有节点的文字（自上而下 = DOM 顺序 = 布局的阅读顺序） */
function nodeTexts() {
  return $$('[data-node-id]').map((el) => el.getAttribute('data-node-text') || '');
}

function canvas() {
  return $('[data-tree-canvas]');
}

/** 直连后端命令（读真源，不听界面自报） */
function invoke(cmd, args) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
}

/**
 * 让界面重新拉一次数据。
 *
 * ⚠️ 为什么需要它：树操作是**有意不广播** `data-changed` 的
 * （见 `commands.rs` 里那一大段注释：点一下改一处，全量重拉四个文件太浪费）。
 * 所以脚本用 `invoke` 直接改完数据后，界面并不知道。
 * `note_tree_ensure_root` 幂等（有根就原样返回）而且**无条件广播**，拿它当刷新开关最省事。
 *
 * 不传 id 就随便找一篇树状图笔记当开关。
 */
async function refreshUi(anyTreeNoteId) {
  let id = anyTreeNoteId;
  if (!id) {
    const notes = await invoke('note_list', {});
    const one = notes.find((n) => n.kind === 'tree');
    id = one && one.id;
  }
  if (id) {
    await invoke('note_tree_ensure_root', { noteId: id });
  } else {
    // 一篇树状图都没有的时候（比如刚被 cleanup 删光），ensure_root 没地方使 ——
    // 退而用"建一条信息再删掉"当刷新开关：这两条命令都会广播 data-changed。
    // 信息建了就删，磁盘上不留痕。
    const tmp = await invoke('info_create', {
      text: '__m4_refresh_switch__',
      kind: 'text',
      categories: [],
      assetPath: null,
    });
    await invoke('info_delete', { id: tmp.id });
  }
  await sleep(700);
}

/**
 * 逼某个面板重新挂载。
 *
 * 认知区右栏是按 `note.id` 做 key 的，所以"同一篇笔记"再点一次**不会**重建组件；
 * 而 `DocNotePane` 的正文是挂载时从 props 抄进 `useState` 的 ——
 * 脚本用 invoke 改了正文之后，得先切到别的笔记再切回来，编辑器才会读到新正文。
 *
 * ⚠️ 「别的笔记」是**自动挑的**（列表里任意一篇不是目标的）。
 * 上一版写死了另一篇的标题，结果那篇标题没保存成功时这里静默失效，
 * 后面的检查一连串跟着挂 —— 不要依赖别的测试数据的名字。
 */
async function remountPane(noteTitle) {
  const list = noteList();
  if (!list) return;
  // ⚠️ 2026-09-21 修：原来挑"别的笔记"用的是 `$$('li button', list)` 里**第一个不是目标**的按钮，
  //    这在 M8-A 之后会挑中**同一行的 ⋮ 按钮**（一行有两个按钮：打开 + 移分组）——
  //    于是"先切走再切回来"变成了"点开菜单 + 再点一次当前笔记"，**根本没重挂载**，
  //    编辑器还留着挂载时抄进去的旧正文（实测症状：`面板重挂载后编辑器读到了新正文 :: -[]`，
  //    后面 11 条断言跟着一起挂，看着像 M3 的编辑器坏了）。
  //    现在按**行**（`data-note-row`）挑，再点行里的 `data-note-open`，语义明确。
  async function openRow(row) {
    if (!row) return false;
    const btn = row.querySelector('[data-note-open]') || row.querySelector('button');
    if (!btn) return false;
    pointerClick(btn);
    return true;
  }
  let rows = $$('[data-note-row]', list);
  let target = rows.find((r) => (r.innerText || '').indexOf(noteTitle) >= 0);
  if (!target) {
    // 可能是被收起来的分组藏住了：把收着的组都展开再找一次
    $$('[data-group-toggle]', list)
      .filter((b) => (b.innerText || '').indexOf('▸') >= 0)
      .forEach((b) => b.click());
    await sleep(500);
    rows = $$('[data-note-row]', list);
    target = rows.find((r) => (r.innerText || '').indexOf(noteTitle) >= 0);
  }
  const other = rows.find((r) => r !== target && !r.contains(target));
  if (await openRow(other)) await sleep(350);
  if (await openRow(target)) await sleep(800);
}

/** 找一个"画布空白处"的屏幕坐标（用来测平移 / 取消选中） */
function findEmptySpot(cv) {
  const rect = cv.getBoundingClientRect();
  for (let i = 0; i < 300; i += 1) {
    const x = rect.left + 8 + Math.random() * (rect.width - 16);
    const y = rect.top + 8 + Math.random() * (rect.height - 16);
    const el = document.elementFromPoint(x, y);
    if (!el) continue;
    if (el.closest('[data-node-id]') || el.closest('button') || el.closest('[data-tree-toolbar]')) {
      continue;
    }
    return { x, y, el };
  }
  return null;
}

/** 当前选中的那篇笔记（认知区右栏标题框里的那篇） */
async function currentNote() {
  const notes = await invoke('note_list', {});
  return notes[0];
}

/**
 * 认知区左栏那个笔记列表。
 *
 * ⚠️ 不要用 `$('aside')` —— 左边那个全局导航 `Sidebar` 也是个 `<aside>`，
 * 而且它在 DOM 里更靠前，`querySelector` 会先命中它。
 * 笔记列表的特征是里面有 `<ul><li>`（导航栏没有 li）。
 */
function noteList() {
  return $$('aside').find((a) => a.querySelector('li')) || null;
}

/** 按标题找笔记并选中它（认知区左栏列表） */
async function pickNote(title) {
  const list = noteList();
  if (!list) return null;
  const li = $$('li button', list).find((b) => (b.innerText || '').indexOf(title) >= 0);
  if (!li) return null;
  pointerClick(li);
  await sleep(350);
  return li;
}

/** 报告：所有断言 + 返回值 */
function report(extra) {
  const failed = results.filter((r) => !r.ok);
  return JSON.stringify(
    Object.assign(
      {
        ok: failed.length === 0,
        failed: failed.length,
        passed: results.length - failed.length,
        results,
      },
      extra || {},
    ),
    null,
    1,
  );
}

/**
 * 清掉上一次跑验收留下的测试数据（让整套脚本**可以重复跑**）。
 *
 * 笔记删除走 `note_delete`（挪到 `notes/_trash/`，不是硬删，和界面上那个一样）。
 * 信息只删文本里带 `M4 ` 前缀的，绝不碰用户自己录的东西。
 */
async function cleanupTestData() {
  const notes = await invoke('note_list', {});
  let notesRemoved = 0;
  for (const note of notes) {
    if (/^M4 (验收树|回归文本笔记|长文字验证树)$/.test(note.title)) {
      await invoke('note_delete', { id: note.id });
      notesRemoved += 1;
      continue;
    }
    // 上一次跑崩在中途时，会留下一堆没改上名字的树状图（只有个「中心主题」的空壳）。
    // 不清掉的话，步骤 00 会误把**它**当成刚建的那篇（标题都是「未命名笔记」），
    // 于是在一个没聚焦的输入框上 blur()，标题一个字都存不进去 —— 这个坑真踩到了。
    // 只删"确实没被用过"的：只有一个节点、那个节点还是默认的「中心主题」，
    // 而且标题还是默认名 / 明显是诊断脚本留下的。
    if (
      note.kind === 'tree' &&
      note.root &&
      note.root.text === '中心主题' &&
      (note.root.children || []).length === 0 &&
      /^(未命名笔记|.*改名|诊断.*)$/.test(note.title)
    ) {
      await invoke('note_delete', { id: note.id });
      notesRemoved += 1;
    }
  }

  const infos = await invoke('info_list', {});
  let infosRemoved = 0;
  for (const info of infos) {
    if ((info.text || '').indexOf('M4 ') === 0) {
      await invoke('info_delete', { id: info.id });
      infosRemoved += 1;
    }
  }

  await refreshUi();
  return { notesRemoved, infosRemoved };
}
