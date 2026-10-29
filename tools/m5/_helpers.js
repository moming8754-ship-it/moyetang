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
  el.dispatchEvent(
    new WheelEvent('wheel', {
      deltaY,
      deltaX: 0,
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
 * 关掉上一步可能还开着的弹窗。
 *
 * ⚠️⚠️ **这条是踩出来的**：M5 的 `realgesture.ps1` 第一版 6 条失败、
 * 其中"真实单击勾选框没反应"看起来像产品 bug，其实是**上一步（06）留下的 ⚙ 弹窗没关**。
 * `Modal` 的背景是 `fixed inset-0 z-40`，它会把**后面所有真实鼠标输入**吃掉：
 * `cdp.ps1 -Action mouse` 点哪都点在弹窗上，而页面上只是背景暗了一点，极难看出来。
 *
 * 跟 M4 那条教训正好成一对：M4 是"合成事件给**假绿灯**"，这一条是"残留弹窗给**假红灯**"。
 * 所以每个步骤开头都先清一遍。
 */
async function closeAnyModal() {
  for (let i = 0; i < 4; i += 1) {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return true;
    // Modal 是在 window 上听 Escape 的原生监听器，合成 keydown 也能触发
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(220);
    // 万一没关掉（比如焦点在别的输入框里），直接点右上角那个 ✕
    const still = document.querySelector('[role="dialog"]');
    if (still) {
      const close = still.querySelector('button[aria-label="关闭"]');
      if (close) close.click();
      await sleep(220);
    }
  }
  return !document.querySelector('[role="dialog"]');
}

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
  // 上一步可能留了个弹窗，它会挡住后面所有的真实鼠标输入
  await closeAnyModal();
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
  const items = $$('li button', list);
  const target = items.find((b) => (b.innerText || '').indexOf(noteTitle) >= 0);
  const other = items.find((b) => b !== target);
  if (other) {
    pointerClick(other);
    await sleep(350);
  }
  if (target) {
    pointerClick(target);
    await sleep(800);
  }
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
 * ⚠️⚠️ **绝对不能用 `todo_purge_removed` 一把清**（第一版就是这么写的，翻车了）：
 * 它内部会先做一次"对账"——凡是 `source=note` 但笔记已经不在了的待办一律标成
 * 「来源已移除」再删掉。**脚本认不出哪些是测试数据**，于是把用户自己建的、
 * 来源笔记后来被删掉的待办也一起删了（首次跑就误删了 4 条）。
 * 删用户的东西必须由**用户点那个「清理」按钮并确认**，脚本只能删自己认得出来的。
 *
 * 所以这里的规矩是：**只删能明确认出是 M5 造的**（标题前缀 / 来源是 M4·M5 的测试信息），
 * 其余一概不碰。笔记与信息也只删 M4/M5 前缀的。
 */
async function cleanupTestData() {
  const notes = await invoke('note_list', {});
  const infos = await invoke('info_list', {});

  // ① 先删待办（要在删信息之前 —— 信息删了就认不出来源了）
  const testInfoIds = new Set(
    infos.filter((one) => /^(M4|M5) /.test(one.text || '')).map((one) => one.id),
  );
  let todosRemoved = 0;
  for (const todo of await invoke('todo_list', {})) {
    // ⚠️ 前缀要把 03 里造的**树节点待办**和**随笔记一起失去来源**那条也覆盖上。
    //    漏掉它们的话：上一轮结尾删了那篇树笔记 → 待办被标「来源已移除」而不是删除
    //    → 这一轮 `find(title===...)` 会先命中那条**旧的**，
    //    于是 03 的"来源记的是那棵树"莫名其妙失败（真踩到了）。
    const mine =
      /^(笔记来的|手工建的|树里冒出来的|这条会随笔记一起失去来源)/.test(todo.title || '') ||
      (todo.source.kind === 'info' && testInfoIds.has(todo.source.infoId));
    if (mine) {
      await invoke('todo_delete', { id: todo.id });
      todosRemoved += 1;
    }
  }

  // ② 笔记
  let notesRemoved = 0;
  for (const note of notes) {
    if (/^(M4 (验收树|回归文本笔记|长文字验证树)|M5 (待办源笔记|树里的待办|临时笔记))$/.test(note.title)) {
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

  // ③ 信息
  let infosRemoved = 0;
  for (const info of infos) {
    if (/^(M4|M5) /.test(info.text || '')) {
      await invoke('info_delete', { id: info.id });
      infosRemoved += 1;
    }
  }

  await refreshUi();
  return { todosRemoved, notesRemoved, infosRemoved };
}

// ─────────────────── M5：执行区 ───────────────────

/** 待办卡片（按 id） */
function todoCard(id) {
  return $('[data-todo-id="' + id + '"]');
}

/** 待办卡片（按标题找 —— 界面上人能认的只有标题） */
function todoCardByTitle(title) {
  return $$('[data-todo-id]').find((el) => (el.getAttribute('data-todo-title') || '') === title) || null;
}

/** 卡片上那个勾选框 */
function todoCheck(id) {
  return $('[data-todo-check="' + id + '"]');
}

/**
 * 让某张卡片出现在 DOM 里（M9-4 起要绕一下）。
 *
 * ⚠️ 标完成之后卡片会**移进收起的「已完成归档」区**，那张卡上的勾选框
 * 于是从 DOM 里消失了 —— 直接 `pointerClick(todoCheck(id))` 会拿到 null，
 * 报 `Cannot read properties of null (reading 'getBoundingClientRect')`
 * （2026-09-21 全量回归真踩到，一度以为是待办功能坏了）。
 *
 * 找不到卡片就把归档展开。**展开状态不还原** —— 还原反而会让"这一步之后卡片在不在
 * DOM 里"变得难以预测；而归档区在 `[data-todo-set]` 之外，不影响"待办集里有几张卡"这类断言。
 */
async function ensureCardVisible(id) {
  if (todoCard(id)) return true;
  const toggle = $('[data-archive-toggle]');
  if (!toggle) return false;
  toggle.click();
  await sleep(500);
  return !!todoCard(id);
}

/** 取消完成：先确保卡片在 DOM 里（可能已经进了归档），再点那个勾选框 */
async function uncheckTodo(id) {
  await ensureCardVisible(id);
  const box = todoCheck(id);
  if (!box) throw new Error('找不到可取消完成的勾选框（归档里也没有）：' + id);
  pointerClick(box);
  return box;
}

/** 进执行区并等卡片渲染出来（先清掉上一步可能留下的弹窗） */
async function enterTodos() {
  await ready();
  await closeAnyModal();
  await nav('执行区');
  await waitFor(() => $('[data-todo-set]'), 8000);
  await sleep(300);
  return $('[data-todo-set]');
}

/** 执行区那个真正会滚的容器（待办集长起来之后，卡片和十字待办不可能同屏） */
function todoScroller() {
  return $('[data-todo-set]')?.closest('.overflow-y-auto') ?? null;
}

/** 把滚动容器拉到顶/拉到底 —— 真实拖拽要求**起点和终点同时在屏幕上** */
async function scrollTodos(where) {
  const scroller = todoScroller();
  if (!scroller) return false;
  scroller.scrollTop = where === 'bottom' ? scroller.scrollHeight : 0;
  await sleep(500);
  return true;
}

/** 从磁盘读一条待办（真源，不听界面自报） */
async function todoOnDisk(id) {
  const items = await invoke('todo_list', {});
  return items.find((one) => one.id === id) || null;
}

/** 从磁盘按标题找待办（标题是人唯一认得出的东西） */
async function todoByTitle(title) {
  const items = await invoke('todo_list', {});
  return items.find((one) => one.title === title) || null;
}

/** 让界面重新拉一次数据（执行区的写操作都会广播 data-changed，这里是兜底） */
async function refreshTodos() {
  await refreshUi();
}

