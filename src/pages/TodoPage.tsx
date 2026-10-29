/**
 * 执行区（M5 完整版）。
 *
 * 页面结构（PRD §5.3）：**左 = 今日时间轴雏形，右 = 待办集**。
 * ⚠️ #8（2026-10-21 · 用户反馈第二批）：原来下面还接一块「十字待办 2×2」——
 * 用户让把它**搬到首页**，执行区不再画；分类入口留在每张卡片的 ⚙「调整分类」里。
 *
 * # 拖动为什么要自己写（不用原生 DnD）
 * 卡片里有按钮、有输入框、有弹窗；原生 DnD 会跟点击打架（M4 在树状图上踩过一模一样的坑：
 * `pointerdown` 落在图片上会开始浏览器原生拖拽，把后续事件全吞掉）。
 * 所以照 M4 的做法来：**pointerdown 记起点 → 越过 5px 才算拖 → 用 `elementFromPoint`
 * 找落点**。另外拖完要抑制随之而来的 `click`，不然一次拖动会顺带把标题点进编辑态。
 *
 * # 卡片归属
 * 每张待办都在待办集里（B3："两边都显示"）；`quadrant` 只是它身上的分类标签，
 * 首页那块四象限板按这个标签分格。拖拽现在只负责**排序 / 换组**，不再改分类。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import PageShell from "../components/PageShell";
import TodoCard from "../features/todos/TodoCard";
import type { TodoActions } from "../features/todos/TodoCard";
import RemovedTodosDialog from "../features/todos/RemovedTodosDialog";
import TodayTimeline from "../features/todos/Timeline";
import { focusText, isToday, monthLabel } from "../features/todos/time";
import { parseQuickInput } from "../features/todos/quickParse";
import type { Todo } from "../features/types";
import { archiveList } from "../features/api";
import { useData } from "../store/data";
import { useFocusSession } from "../store/focusSession";
import { useUi } from "../store/ui";

/** 拖到哪儿了（#8 起**只有"待办集"一种落点**：四象限已搬到首页，没有格子可拖进去了） */
type DropTarget =
  /* D 批：`group` = 落进哪一组（`null` = 鼠标不在任何分组段里；空串 = "未分组"那一组） */
  | { kind: "set"; index: number; group?: string | null }
  | null;

export default function TodoPage() {
  const todos = useData((state) => state.todos);
  const notes = useData((state) => state.notes);
  const infos = useData((state) => state.infos);
  const focusRef = useData((state) => state.focusRef);
  const setFocusRef = useData((state) => state.setFocusRef);
  const setTodoDone = useData((state) => state.setTodoDone);
  const setTodoTitle = useData((state) => state.setTodoTitle);
  const setTodoPlanned = useData((state) => state.setTodoPlanned);
  const setTodoDue = useData((state) => state.setTodoDue);
  const setTodoRepeat = useData((state) => state.setTodoRepeat);
  const addSubtask = useData((state) => state.addSubtask);
  const toggleSubtask = useData((state) => state.toggleSubtask);
  const removeSubtask = useData((state) => state.removeSubtask);
  const setTodoQuadrant = useData((state) => state.setTodoQuadrant);
  /** v1.15.0：这条待办自己的番茄时长（`null` = 恢复跟随设置） */
  const setTodoCustomMinutes = useData((state) => state.setTodoCustomMinutes);
  /** D 批：移到分组（空串 = 移出） */
  const setTodoGroup = useData((state) => state.setTodoGroup);
  const reorderTodos = useData((state) => state.reorderTodos);
  const deleteTodo = useData((state) => state.deleteTodo);
  // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：这里原来是
  //    `/** M15：收进档案库 */ const archiveOne = ...` —— 待办那颗入口去掉后就不用了。
  const scheduleTodoRemind = useData((state) => state.scheduleTodoRemind);
  const deleteReminder = useData((state) => state.deleteReminder);
  const purgeRemovedTodos = useData((state) => state.purgeRemovedTodos);
  const createTodo = useData((state) => state.createTodo);
  const setView = useUi((state) => state.setView);
  const askConfirm = useUi((state) => state.askConfirm);
  /** D 批：移到分组之后给一声"已移到「学业」"（跟认知区那边一致） */
  const toast = useUi((state) => state.toast);
  /** B 批：开始专注（面板本体挂在 `App` 上，这里只负责"开这一场"） */
  const startFocusSession = useFocusSession((state) => state.start);

  const [newTitle, setNewTitle] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** 「来源已移除」那个窗开着没有（A1 决策：点按钮只开窗，不删） */
  const [removedOpen, setRemovedOpen] = useState(false);
  /**
   * M15：**被收进档案库的笔记 id**（收纳 ≠ 删除，来源仍然有效）。
   * 笔记列表一变（收纳 / 取出都会变）就重读一次档案库。
   */
  const [archivedNoteIds, setArchivedNoteIds] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await archiveList();
        if (!cancelled) {
          setArchivedNoteIds(all.filter((one) => one.kind === "note").map((one) => one.id));
        }
      } catch (error) {
        console.error("[东方摩耶堂] 读档案库失败", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notes]);

  /** 刚拖过一把 —— 用来吞掉紧随其后的那个 click */
  const justDragged = useRef(false);
  const wasDragged = useCallback(() => justDragged.current, []);

  /**
   * 搜索 + 按来源筛选（M9-5）。
   *
   * 两个约定：
   * ① **搜索同时覆盖"待办集"和"归档"** —— 用户搜"买牛奶"时脑子里只有"有没有这件事"，
   *    不会先想"它完成了没有"。所以搜索时归档区自动展开并跟着过滤；
   * ② ~~四象限不跟着过滤~~（#8 起四象限在首页，执行区这边没有那块板了）。
   */
  const [todoQuery, setTodoQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "note" | "info" | "manual">("all");
  const searchingTodos = todoQuery.trim().length > 0 || sourceFilter !== "all";
  const matchesQuery = (todo: Todo) => {
    const keyword = todoQuery.trim().toLowerCase();
    if (keyword && !todo.title.toLowerCase().includes(keyword)) return false;
    if (sourceFilter !== "all" && todo.source.kind !== sourceFilter) return false;
    return true;
  };

  const openTodos = todos.filter((todo) => todo.status === "open");
  const doneTodos = todos.filter((todo) => todo.status === "done");
  /**
   * 待办集 = **所有还没完成的待办**。
   *
   * ⚠️ 这里有两个用户决定叠在一起，别只看一半：
   * - **B3（2026-09-21）**："排进象限的也要留在待办集里，两边都显示" —— 所以**不按 quadrant 过滤**；
   * - **M9-4（2026-09-21）**："已完成归档" —— 所以**按 status 过滤**：做完的事挪到下面的
   *   「已完成」折叠区（按月分组），待办集里只剩"还没做的"。
   *   两件事不冲突：象限管"优先级"，归档管"做完了没有"。
   */
  const setTodos = openTodos.filter(matchesQuery);

  // ── D 批（2026-10-04）：待办分组（照认知区那套） ─────────────────────
  /** 哪一条的「移到分组」小菜单开着 */
  const [groupMenuFor, setGroupMenuFor] = useState<string | null>(null);
  /** 小菜单里"新建分组"输入框的内容 */
  const [newGroupName, setNewGroupName] = useState("");
  /** 折叠起来的组名（空串 = "未分组"那一组） */
  const [collapsedTodoGroups, setCollapsedTodoGroups] = useState<string[]>([]);
  const groupMenuRef = useRef<HTMLDivElement | null>(null);

  /** 现在用过的分组名（排序去重；菜单和分组段都用它） */
  const knownTodoGroups = useMemo(() => {
    const names = Array.from(
      new Set(todos.map((todo) => (todo.group ?? "").trim()).filter((name) => name !== "")),
    );
    names.sort();
    return names;
  }, [todos]);

  /**
   * 把待办按分组切成几段。顺序规则跟认知区**一模一样**：
   * 有名字的按名字排（Unicode 码点序，稳定），**"未分组"永远放最后**。
   *
   * 🔴 **一个命名分组都没有时，界面要跟以前完全一样**（平铺、没有"未分组"标题、没有 ⋮）——
   * 用不上分组的人不该被这套 UI 打扰。`groupingActive` 就是这个开关。
   */
  const todoSections = useMemo(() => {
    const buckets = new Map<string, Todo[]>();
    for (const todo of setTodos) {
      const name = (todo.group ?? "").trim();
      const list = buckets.get(name);
      if (list) list.push(todo);
      else buckets.set(name, [todo]);
    }
    const named = Array.from(buckets.keys())
      .filter((name) => name !== "")
      .sort();
    const out = named.map((name) => ({ name, todos: buckets.get(name) ?? [] }));
    const loose = buckets.get("") ?? [];
    if (loose.length > 0) out.push({ name: "", todos: loose });
    return out;
  }, [setTodos]);
  /** 搜索时**平铺**（跟认知区一致：搜东西时脑子里只有"有没有这件事"） */
  const groupingActive = knownTodoGroups.length > 0 && !searchingTodos;
  /**
   * **视觉顺序**的扁平列表 —— 拖拽的落点计算和落盘都用它。
   *
   * ⚠️ 必须等于 `[data-todo-set] [data-todo-id]` 在 DOM 里的顺序，否则
   * `computeTarget` 算出来的"插到第几个之前"跟落盘顺序对不上（M5 那套就是这么定的）。
   */
  const visualTodos = useMemo(
    () => (groupingActive ? todoSections.flatMap((section) => section.todos) : setTodos),
    [groupingActive, todoSections, setTodos],
  );

  const toggleTodoGroup = (name: string) =>
    setCollapsedTodoGroups((old) =>
      old.includes(name) ? old.filter((one) => one !== name) : [...old, name],
    );
  const isTodoGroupCollapsed = (name: string) => collapsedTodoGroups.includes(name);

  /** 移到分组（空串 = 移出）；顺便把折叠的那组展开，不然点了像"卡片没了" */
  const moveTodoToGroup = async (todo: Todo, group: string) => {
    setGroupMenuFor(null);
    setNewGroupName("");
    const saved = await setTodoGroup(todo.id, group);
    if (saved) {
      const name = group.trim();
      setCollapsedTodoGroups((old) => old.filter((one) => one !== name));
      toast(name ? `已移到「${name}」` : "已移出分组", "success");
    }
  };

  // 点别处关掉「移到分组」小菜单（照认知区那一份写的）
  useEffect(() => {
    if (!groupMenuFor) return;
    const onDown = (event: MouseEvent) => {
      if (!groupMenuRef.current?.contains(event.target as Node)) {
        setGroupMenuFor(null);
        setNewGroupName("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [groupMenuFor]);

  /**
   * 已完成归档（M9-4）：按**完成时间的月份**分组，最近的在最前面。
   *
   * 两组规则：
   * ① "今天完成的"单独一组、**默认展开** —— 刚做完的事得看得见，不然点完勾它就"消失"了，
   *    人会以为被删了（番茄钟结束会自动标完成，更容易撞上这个）；
   * ② 更早的月份按「2026 年 9 月」分组、**默认折叠** —— 归档的意义就是"别一直挤在眼前"。
   *
   * ⚠️ #8（2026-10-21）：原先这里上面还有一块 `groups`（四象限分行）—— 那块板已搬到首页，
   *    执行区不再画它；**分类入口仍在卡片 ⚙「调整分类」**，数据与同步一个字没动。
   */
  const archive = useMemo(() => {
    const now = new Date();
    const today: Todo[] = [];
    const months = new Map<string, Todo[]>();
    for (const todo of doneTodos) {
      if (!matchesQuery(todo)) continue;
      if (isToday(todo.doneAt, now)) {
        today.push(todo);
        continue;
      }
      const label = monthLabel(todo.doneAt);
      const bucket = months.get(label);
      if (bucket) bucket.push(todo);
      else months.set(label, [todo]);
    }
    // 月份倒序（新的在前）：标签是「2026 年 9 月」，直接比字符串正好是时间顺序
    const monthGroups = [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
      .map(([label, items]) => ({ label, items }));
    return { today, monthGroups, total: doneTodos.length };
  }, [doneTodos, todoQuery, sourceFilter]);

  /** 归档区展开状态：默认只展开"今天完成的" */
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [openMonths, setOpenMonths] = useState<string[]>([]);
  const toggleMonth = (label: string) =>
    setOpenMonths((old) =>
      old.includes(label) ? old.filter((one) => one !== label) : [...old, label],
    );
  /**
   * 今日专注统计（M9-3）：把每条待办 pomodoros 里**今天**的记录加起来。
   *
   * 数据早就在盘上了（番茄钟每次结束都会记一笔），只是以前没人算过 ——
   * 所以这一项**不动后端、不动数据**，纯前端算。
   */
  const todayPomodoroCount = todos.reduce(
    (sum, todo) => sum + todo.pomodoros.filter((one) => isToday(one.at)).length,
    0,
  );
  const todayFocusSeconds = todos.reduce(
    (sum, todo) =>
      sum +
      todo.pomodoros
        .filter((one) => isToday(one.at))
        .reduce((inner, one) => inner + (one.seconds || 0), 0),
    0,
  );

  /** 今日时间轴：只收"今天 + 设了时间"的（PRD 10.4 那条） */
  const todayTodos = todos.filter((todo) => isToday(todo.plannedAt));

  /**
   * 来源已经没了的待办。
   *
   * 两种都算：① 后端标了 `sourceRemoved`（认知区那条 `-[]` 被删了 / 笔记被删了）；
   * ② **来源本身不存在了** —— M5 之前攒下来的老孤儿是没有标记的
   *    （那时候删笔记还不会标记），只看 ① 的话它们在界面上永远显示不出来，
   *    那个「清理」按钮也就永远不出现。清理由后端 `purge_removed` 负责，
   *    它会先自己对一遍账，所以这里只判断、不改数据。
   */
  const sourceMissing = (todo: Todo): boolean => {
    if (todo.source.kind === "note") {
      // M15：**收进档案库的笔记也算"来源还在"**（收纳 ≠ 删除）。
      // ⚠️ 后端 `mark_orphans_removed` 已经这么判了，界面这边不同步就会"数据是对的、卡片在骗人"
      //    （2026-09-27 验收逮到：卡片标「来源已移除」、还让「清理」入口冒出来）。
      return (
        !notes.some((one) => one.id === todo.source.noteId) &&
        !archivedNoteIds.includes(todo.source.noteId ?? "")
      );
    }
    if (todo.source.kind === "info") {
      return !infos.some((one) => one.id === todo.source.infoId);
    }
    return false;
  };
  const staleIds = new Set(
    todos
      .filter((todo) => todo.source.sourceRemoved === true || sourceMissing(todo))
      .map((todo) => todo.id),
  );
  const staleTodos = todos.filter((todo) => staleIds.has(todo.id));
  const removedCount = staleIds.size;

  // ── 来源标注：把 id 换成给人看的标题，并给出"跳回去"的去向 ──
  const sourceOf = (todo: Todo): { text: string; open?: () => void } => {
    if (todo.source.kind === "note") {
      const note = notes.find((one) => one.id === todo.source.noteId);
      const where = todo.source.nodeId ? "节点" : "自动检测";
      if (!note) return { text: `来自认知区《笔记已删除》·${where}` };
      return {
        text: `来自认知区《${note.title}》·${where}`,
        open: () => {
          setFocusRef({ kind: "note", id: note.id });
          setView("cognition");
        },
      };
    }
    if (todo.source.kind === "info") {
      const info = infos.find((one) => one.id === todo.source.infoId);
      if (!info) return { text: "来自信息区《信息已删除》" };
      const label = info.text.trim() ? info.text.trim().slice(0, 14) : "图片信息";
      return {
        text: `来自信息区《${label}》`,
        open: () => {
          setFocusRef({ kind: "info", id: info.id });
          setView("info");
        },
      };
    }
    return { text: "手动建的" };
  };

  // ── 从别处跳过来定位某条待办（信息区的「→ 待办《XX》」、以后的首页卡片） ──
  useEffect(() => {
    if (focusRef?.kind !== "todo") return;
    const id = focusRef.id;
    setFocusRef(null);
    setHighlightId(id);
    const timer = window.setTimeout(() => {
      document
        .querySelector(`[data-todo-id="${id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    const clear = window.setTimeout(() => setHighlightId(null), 2800);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [focusRef, setFocusRef]);

  // ── 拖动 ──
  /** 鼠标底下是什么：待办集里（插到第几个之前 + 落进哪一组）？
   *  ⚠️ #8 起**没有"拖进象限"这种落点了**（四象限已搬到首页）。 */
  const computeTarget = (x: number, y: number, dragId: string): DropTarget => {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;

    const setHost = element.closest("[data-todo-set]");
    if (setHost) {
      // ⚠️ 排除正在拖的这张：它还在 DOM 里，算进去 index 会差一位
      const cards = Array.from(setHost.querySelectorAll("[data-todo-id]")).filter(
        (one) => one.getAttribute("data-todo-id") !== dragId,
      );
      let index = cards.length;
      for (let i = 0; i < cards.length; i += 1) {
        const rect = cards[i].getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
          index = i;
          break;
        }
      }
      // D 批：落到哪一组里（`data-todo-group=""` = 未分组）→ 拖到哪组就归哪组，
      // 跟"拖进象限 = 改分类"同一个思路（不这么做的话，卡片会自己跳回原来那一组，像卡住了）。
      const groupHost = element.closest("[data-todo-group]");
      const group = groupHost ? (groupHost.getAttribute("data-todo-group") ?? "") : null;
      return { kind: "set", index, group };
    }
    return null;
  };

  /** 松手：落点决定顺序（D 批起还决定"归哪一组"） */
  const applyDrop = (todo: Todo, target: DropTarget) => {
    if (!target) return;
    // D 批：落进别的组 → 顺手改分组（同组里拖就只排序）
    if (typeof target.group === "string") {
      const now = (todo.group ?? "").trim();
      if (target.group.trim() !== now) void setTodoGroup(todo.id, target.group.trim());
    }
    // ⚠️ 用**视觉顺序**那一份算（分组时它才是 DOM 的顺序）
    const ids = visualTodos.map((one) => one.id).filter((id) => id !== todo.id);
    const at = Math.max(0, Math.min(target.index, ids.length));
    ids.splice(at, 0, todo.id);
    if (ids.length > 1) void reorderTodos(ids);
  };

  const onCardPointerDown = (event: ReactPointerEvent<HTMLElement>, todo: Todo) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        moved = true;
        justDragged.current = true;
        setDraggingId(todo.id);
      }
      setDropTarget(computeTarget(ev.clientX, ev.clientY, todo.id));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const target = moved ? computeTarget(ev.clientX, ev.clientY, todo.id) : null;
      setDraggingId(null);
      setDropTarget(null);
      if (moved) applyDrop(todo, target);
      // 让紧随其后的 click 还能看到 justDragged（click 先于这个宏任务）
      window.setTimeout(() => {
        justDragged.current = false;
      }, 0);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── 各种动作 ──
  const actions: TodoActions = {
    toggleDone: (todo, done) => void setTodoDone(todo.id, done),
    setTitle: (todo, title) => void setTodoTitle(todo.id, title),
    setPlanned: (todo, plannedAt) => void setTodoPlanned(todo.id, plannedAt),
    setDue: (todo, dueAt) => void setTodoDue(todo.id, dueAt),
    setRepeat: (todo, repeat) => void setTodoRepeat(todo.id, repeat),
    addSubtask: (todo, text) => void addSubtask(todo.id, text),
    toggleSubtask: (todo, subtaskId, done) => void toggleSubtask(todo.id, subtaskId, done),
    removeSubtask: (todo, subtaskId) => void removeSubtask(todo.id, subtaskId),
    setQuadrant: (todo, quadrant) => void setTodoQuadrant(todo.id, quadrant),
    // v1.15.0：这条待办自己的番茄时长（`null` = 恢复跟随设置里的全局值）
    setCustomMinutes: (todo, minutes) => void setTodoCustomMinutes(todo.id, minutes),
    scheduleRemind: (todo, fireAt, key, note) => void scheduleTodoRemind(todo.id, fireAt, key, note),
    // C 批：删掉某一条提醒（只删点名那条）
    deleteReminder: (reminderId) => void deleteReminder(reminderId),
    startPomodoro: (todo) => {
      // B 批（2026-10-02）：面板搬去 `App` 了（`store/focusSession` 管"谁在专注"）。
      // 原来的 `setPomodoroFor` 会随 TodoPage 一起卸载 → 切个页面计时就断了。
      startFocusSession(todo);
    },
    // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：`archive` 这个动作原来在这儿
    //    （待办 ⚙ 里那颗「收进档案库」用的）—— 那颗按用户要求去掉了。
    remove: (todo) =>
      askConfirm({
        title: "删掉这条待办？",
        message: `《${todo.title}》会被删掉（todos.json 的上一版还在 .bak 里）。`,
        confirmText: "删除",
        danger: true,
        onConfirm: () => void deleteTodo(todo.id),
      }),
  };

  const renderCard = (todo: Todo, withGroupMenu = false) => {
    const source = sourceOf(todo);
    return (
      <TodoCard
        todo={todo}
        actions={actions}
        sourceText={source.text}
        onOpenSource={source.open}
        sourceRemoved={staleIds.has(todo.id)}
        dragging={draggingId === todo.id}
        dropBefore={
          dropTarget?.kind === "set" &&
          // ⚠️ 用**视觉顺序**那一份（分组时它才是 DOM 的顺序），否则插入线会画错行
          dropTarget.index === visualTodos.filter((one) => one.id !== draggingId).indexOf(todo)
        }
        highlight={highlightId === todo.id}
        onCardPointerDown={onCardPointerDown}
        wasDragged={wasDragged}
        /* D 批：归档区（也走 renderCard）**不传**这两个，那边卡片上一个多出来的字都没有 */
        onGroupMenu={
          withGroupMenu
            ? () => {
                setGroupMenuFor(groupMenuFor === todo.id ? null : todo.id);
                setNewGroupName("");
              }
            : undefined
        }
        groupMenuOpen={withGroupMenu && groupMenuFor === todo.id}
        group={(todo.group ?? "").trim() || undefined}
      />
    );
  };

  /**
   * 「移到分组」小菜单（D 批）—— 照认知区那一份写的，规矩也一样：
   * 已有分组点一下就移过去（当前那个打勾）、空串 = 移出、底下能就地新建一个组。
   */
  const renderGroupMenu = (todo: Todo) => {
    if (groupMenuFor !== todo.id) return null;
    const current = (todo.group ?? "").trim();
    return (
      <div
        ref={groupMenuRef}
        data-todo-group-menu={todo.id}
        className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      >
        <p className="px-1 pb-1 text-[11px] text-slate-400">移到分组</p>
        {knownTodoGroups.map((name) => (
          <button
            key={name}
            type="button"
            data-todo-group-pick={name}
            onClick={() => void moveTodoToGroup(todo, name)}
            className={`block w-full truncate rounded-lg px-2 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 ${
              current === name ? "text-indigo-600 dark:text-indigo-300" : ""
            }`}
          >
            {current === name ? "✓ " : ""}
            {name}
          </button>
        ))}
        {current !== "" && (
          <button
            type="button"
            data-todo-group-remove
            onClick={() => void moveTodoToGroup(todo, "")}
            className="mt-1 block w-full rounded-lg px-2 py-1 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10"
          >
            未分组（移出）
          </button>
        )}
        {knownTodoGroups.length === 0 && (
          <p className="px-1 pb-1 text-[11px] text-slate-400">（还没有别的分组）</p>
        )}
        <input
          value={newGroupName}
          onChange={(event) => setNewGroupName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const name = newGroupName.trim();
              if (name) void moveTodoToGroup(todo, name);
            }
          }}
          data-todo-group-new-input
          placeholder="新分组名…（回车）"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
      </div>
    );
  };

  const add = async () => {
    // 快捷语法（M9-9）：`买牛奶 !明天` → 标题「买牛奶」+ 设定时间「明天 09:00」
    // D 批起还认 `#分组`：`买牛奶 #生活` → 建出来就直接放进「生活」组
    const parsed = parseQuickInput(newTitle);
    if (!parsed.title) return;
    const created = await createTodo(parsed.title, parsed.plannedAt ?? undefined);
    if (!created) return;
    setNewTitle("");
    if (parsed.group) {
      // 先建再移：`todo_create` 是老命令（不收 group），建完拿返回的 id 落一次分组
      await setTodoGroup(created.id, parsed.group);
      setCollapsedTodoGroups((old) => old.filter((one) => one !== parsed.group));
      toast(`已建好，并放进「${parsed.group}」`, "success");
    }
  };

  /** 输入框里实时解析一次：让用户**看得见**自己打的时间说法被认成了什么 */
  const quickPreview = parseQuickInput(newTitle);

  return (
    <PageShell
      title="执行区"
      subtitle="即使一切都是摩耶，我仍选择清醒着前行"
      badge={`M5 · 未完成 ${openTodos.length} / 已完成 ${doneTodos.length}`}
    >
      <div className="flex min-h-full gap-6">
        {/* ① 左：今日专注统计 + 今日时间轴 */}
        <aside className="w-56 shrink-0">          {/* 今日专注（M9-3）：把 pomodoros 里"今天"的记录加起来 —— 数据早就在盘上，只是没人算过 */}
          <section
            data-focus-today
            data-focus-seconds={todayFocusSeconds}
            data-focus-count={todayPomodoroCount}
            /* D 批（2026-10-04）：这原来是**一个红框圆角卡**，紧挨着下面"今日时间轴"另一个卡 ——
               左栏一上来就是两个框。现在两节合成一片，中间一条线，红色缩到左边那条色条上。
               ⚠️ `data-focus-today` / `data-focus-seconds` / `data-focus-count` 三个钩子没动（m9 靠它们断言）。 */
            className="border-l-2 border-rose-400 pl-3"
          >
            <h2 className="text-xs font-semibold text-rose-700 dark:text-rose-300">今天的专注</h2>
            <p className="mt-1 text-lg font-semibold tabular-nums text-rose-700 dark:text-rose-300">
              {todayFocusSeconds > 0 ? focusText(todayFocusSeconds) : "还没开始"}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {todayPomodoroCount > 0
                ? `${todayPomodoroCount} 个番茄钟`
                : "点右边那条待办的【开始】就能计时"}
            </p>
          </section>

          <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
            <h2 className="mb-3 text-sm font-semibold">今日时间轴</h2>
            <TodayTimeline
              todos={todayTodos}
              onJump={(todo) => {
                document
                  .querySelector(`[data-todo-id="${todo.id}"]`)
                  ?.scrollIntoView({ block: "center", behavior: "smooth" });
              }}
            />
          </div>
        </aside>

        {/* ② 右：待办集 + 十字待办 */}
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <section>
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-sm font-semibold">待办集</h2>
              <span className="text-xs text-slate-400">
                拖动可以排序（要分四象限：卡片 ⚙ → 调整分类；那块板在首页）
              </span>
              {removedCount > 0 && (
                <button
                  type="button"
                  data-todo-purge
                  title="先看看都是哪些 —— 点开只是查看，不会删任何东西"
                  onClick={() => setRemovedOpen(true)}
                  className="ml-auto rounded-lg border border-amber-300 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10"
                >
                  来源已移除 {removedCount} 条 · 查看
                </button>
              )}
            </div>

            {/* 搜索 + 按来源筛选（M9-5）：搜索同时管待办集和归档，四象限不跟着过滤 */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                data-todo-search
                value={todoQuery}
                onChange={(event) => setTodoQuery(event.target.value)}
                placeholder="搜待办标题…"
                className="w-52 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none placeholder:text-slate-400 focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              {(
                [
                  { key: "all", label: "全部" },
                  { key: "note", label: "来自笔记" },
                  { key: "info", label: "来自信息" },
                  { key: "manual", label: "手动建的" },
                ] as const
              ).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  data-todo-source-filter={option.key}
                  onClick={() => setSourceFilter(option.key)}
                  className={`rounded-lg border px-2.5 py-1 text-xs ${
                    sourceFilter === option.key
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-500/15 dark:text-indigo-300"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {option.label}
                </button>
              ))}
              {searchingTodos && (
                <span data-todo-search-hint className="text-xs text-slate-400">
                  命中 {setTodos.length} 条未完成
                  {archive.total > 0 && ` · 已完成里也有 ${archive.total} 条`}
                  <button
                    type="button"
                    data-todo-search-clear
                    onClick={() => {
                      setTodoQuery("");
                      setSourceFilter("all");
                    }}
                    className="ml-2 rounded px-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/15"
                  >
                    清掉筛选
                  </button>
                </span>
              )}
            </div>

            <div data-todo-set className="flex flex-col">
              {setTodos.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400 dark:border-slate-700">
                  {todos.length === 0
                    ? "还没有待办。可以从信息区点「建为待办」，或者在下面手动加一条。"
                    : "没有符合当前搜索/筛选的待办，换个条件试试。"}
                </p>
              ) : groupingActive ? (
                /* D 批（2026-10-04）：**分组段** —— 组与组之间一条实线，组内行与行细线（见 TodoCard）。
                   搜索时不走这一支（平铺，跟认知区一致）。 */
                <div className="flex flex-col">
                  {todoSections.map((section, index) => (
                    <section
                      key={section.name || "__ungrouped"}
                      data-todo-group={section.name}
                      className={
                        index > 0
                          ? "mt-3 border-t border-slate-200 pt-2 dark:border-slate-800"
                          : ""
                      }
                    >
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          data-todo-group-toggle={section.name}
                          onClick={() => toggleTodoGroup(section.name)}
                          className="flex flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                        >
                          <span className="text-[10px]">
                            {isTodoGroupCollapsed(section.name) ? "▸" : "▾"}
                          </span>
                          <span className="truncate">{section.name || "未分组"}</span>
                          <span className="ml-auto shrink-0 text-slate-400">
                            {section.todos.length}
                          </span>
                        </button>
                      </div>
                      {!isTodoGroupCollapsed(section.name) && (
                        <ul className="mt-1 flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
                          {section.todos.map((todo) => (
                            <li key={todo.id} className="relative">
                              {renderCard(todo)}
                              {renderGroupMenu(todo)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
                  {setTodos.map((todo) => (
                    <li key={todo.id} className="relative">
                      {/* ⚠️ 平铺时**也要**给 ⋮：不然"一个分组都没有"的时候就没法建第一个分组了。
                          规则 ⑨ 因此只保证"没有组标题、没有未分组标题"，不保证"连 ⋮ 都没有"。 */}
                      {renderCard(todo, true)}
                      {renderGroupMenu(todo)}
                    </li>
                  ))}
                </ul>
              )}

              {/* 手动加一条（M2 就有的能力，位置挪到这里）+ M9-9 快捷语法 */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <input
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void add();
                      }
                    }}
                    data-todo-new-input
                    placeholder="手动加一条待办…（回车；可写 !明天 !18:30 !周五 !9-25）"
                    className="min-w-56 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:bg-slate-800"
                  />
                  <button
                    type="button"
                    onClick={() => void add()}
                    disabled={newTitle.trim().length === 0}
                    className="shrink-0 rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    + 加一条
                  </button>
                </div>
                {/* 实时回显：让用户**看见**自己打的说法被认成了什么，不然打错了都不知道 */}
                {(quickPreview.plannedAt || quickPreview.group) && (
                  <p
                    data-quick-hint
                    data-quick-hint-time={quickPreview.plannedAt ?? ""}
                    data-quick-hint-group={quickPreview.group ?? ""}
                    className="px-1 text-xs text-indigo-500 dark:text-indigo-400"
                  >
                    {quickPreview.plannedAt && (
                      <>识别到「{quickPreview.token}」→ 设定时间 {quickPreview.hint}，</>
                    )}
                    {quickPreview.group && <>放进分组「{quickPreview.group}」，</>}
                    标题「{quickPreview.title}」
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* #8（2026-10-21）：十字待办（四象限）已搬到**首页** —— 这里不再画那块板。
             分类入口仍在每张卡片的 ⚙「调整分类」里。 */}

          {/* 已完成归档（M9-4）：整块默认折叠，只有"今天完成的"会自己展开 */}
          {archive.total > 0 && (
            <section data-todo-archive>
              <div className="mb-3 flex items-center gap-3">
                <button
                  type="button"
                  data-archive-toggle
                  onClick={() => setArchiveOpen((open) => !open)}
                  className="flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
                >
                  <span className="text-[10px]">{archiveOpen ? "▾" : "▸"}</span>
                  已完成
                  <span className="font-normal text-slate-400">{archive.total}</span>
                </button>
                <span className="text-xs text-slate-400">
                  {archive.today.length > 0
                    ? `今天完成 ${archive.today.length} 条`
                    : "归档在这里，按完成的月份分组"}
                </span>
              </div>

              {(archiveOpen || searchingTodos) && (
                <div data-archive-body className="flex flex-col gap-4">
                  {/* 今天完成的：默认就在外面（不折叠），刚勾完能立刻看到 */}
                  {archive.today.length > 0 && (
                    <div data-archive-group="__today">
                      <p className="mb-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        今天完成（{archive.today.length}）
                      </p>
                      <ul className="flex flex-col gap-2">
                        {archive.today.map((todo) => (
                          <li key={todo.id}>{renderCard(todo)}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {archive.monthGroups.map((group) => (
                    <div key={group.label} data-archive-group={group.label}>
                      <button
                        type="button"
                        data-archive-month={group.label}
                        onClick={() => toggleMonth(group.label)}
                        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                      >
                        <span className="text-[10px]">
                          {openMonths.includes(group.label) ? "▾" : "▸"}
                        </span>
                        {group.label}
                        <span className="font-normal text-slate-400">{group.items.length}</span>
                      </button>
                      {openMonths.includes(group.label) && (
                        <ul className="flex flex-col gap-2">
                          {group.items.map((todo) => (
                            <li key={todo.id}>{renderCard(todo)}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* B 批（2026-10-02）：番茄钟面板**不再挂在这儿** —— 它搬到 `App.tsx` 上了
          （挂在这里会随页面卸载 → 切个页面计时就断；见 `store/focusSession.ts` 的注释）。 */}

      {/* 「来源已移除」处理窗：**点按钮只是打开它**，删哪条都要单独确认（A1 决策） */}
      {removedOpen && (
        <RemovedTodosDialog
          todos={staleTodos}
          onClose={() => setRemovedOpen(false)}
          onDeleteOne={(todo) =>
            askConfirm({
              title: `删掉「${todo.title}」？`,
              message:
                "它会被从 todos.json 里删掉。删之前程序会把当前的 todos.json 原样存一份到数据目录的 " +
                "backups/ 里，所以删错了还能捞回来 —— 但捞回来要你手动去 backups 里找，麻烦。",
              confirmText: "删掉",
              danger: true,
              onConfirm: () => void deleteTodo(todo.id),
            })
          }
          onDeleteAll={() =>
            askConfirm({
              title: `把这 ${removedCount} 条全删掉？`,
              message:
                "它们的来源都已经不在了。删之前程序会把当前的 todos.json 原样存一份到数据目录的 " +
                "backups/ 里（只留最近 20 份）。留着其实不影响使用，删了就得去 backups 里捞。",
              confirmText: `全删掉（${removedCount} 条）`,
              danger: true,
              onConfirm: () => void purgeRemovedTodos(),
            })
          }
        />
      )}
    </PageShell>
  );
}
