// 06 · 今日时间轴雏形（PRD 10.4 第 8 条）
//
// PRD §5.3：左侧把**当日**待办按**设定时间**排成一条竖线。
// 10.4 那条特别点明：**无设定时间的不进入时间轴**。
//
// 所以这里要验四件：
//   ① 没设时间的待办不进时间轴；
//   ② 设了今天的时间 → 进时间轴，时间显示对；
//   ③ 多条按时间先后排（不是按创建顺序）；
//   ④ 不是今天的（昨天/明天）也不进来（"不跨天"）。
(async () => {
  await ready();
  await enterTodos();

  const jia = await todoByTitle('笔记来的甲');
  const bing = await todoByTitle('笔记来的丙');
  if (!jia || !bing) return report({ why: '先跑 00 准备数据' });

  check('左侧有今日时间轴', !!$('[data-timeline]'));

  /** 通过卡片左下角那个按钮设时间（走界面，不直连后端） */
  const setPlanned = async (id, value) => {
    const plannedBtn = await waitFor(() => $('[data-todo-planned="' + id + '"]'), 5000);
    pointerClick(plannedBtn);
    const input = await waitFor(() => $('[data-todo-planned-input]'), 4000);
    if (!input) return false;
    setValue(input, value);
    await sleep(150);
    $('[data-todo-planned-save]').click();
    await sleep(600);
    return true;
  };

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  const yday = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;

  // ── ① 先确认"没设时间的不在时间轴里" ──
  const clean = await invoke('todo_list', {});
  const jiaClean = clean.find((one) => one.id === jia.id);
  check('前置：甲本来没设时间', !jiaClean.plannedAt, jiaClean && String(jiaClean.plannedAt));
  check(
    '① 没设时间的待办不进时间轴',
    !$('[data-timeline-item="' + jia.id + '"]'),
  );

  // ── ② 设今天 09:00 → 进时间轴 ──
  const okSet = await setPlanned(jia.id, `${day}T09:00`);
  check('通过卡片左下角把设定时间设成了今天 09:00', okSet);
  const onDiskJia = await waitFor(async () => {
    const one = await todoOnDisk(jia.id);
    return one && one.plannedAt ? one : null;
  }, 6000);
  check('设定时间落盘了', !!onDiskJia, onDiskJia && onDiskJia.plannedAt);

  const item = await waitFor(() => $('[data-timeline-item="' + jia.id + '"]'), 6000);
  check('② 设了今天的时间 → 出现在时间轴上', !!item, item && item.innerText);
  check(
    '时间轴上显示的是 09:00',
    item && (item.innerText || '').indexOf('09:00') >= 0,
    item && item.innerText,
  );
  check(
    '时间轴上有那条待办的标题',
    item && (item.innerText || '').indexOf('笔记来的甲') >= 0,
    item && item.innerText,
  );

  // ── ③ 再加一条 14:00，排序要按时间而不是创建顺序 ──
  const okSet2 = await setPlanned(bing.id, `${day}T14:00`);
  check('丙也设成今天 14:00', okSet2);

  const ordered = await waitFor(() => {
    const items = $$('[data-timeline-item]').map((el) => ({
      id: el.getAttribute('data-timeline-item'),
      text: el.innerText || '',
    }));
    return items.length >= 2 ? items : null;
  }, 6000);
  check('③ 时间轴上有两条', !!ordered && ordered.length >= 2, ordered && ordered.map((o) => o.text.replace(/\s+/g, ' ').trim()).join(' | '));
  if (ordered) {
    const idxJia = ordered.findIndex((one) => one.id === jia.id);
    const idxBing = ordered.findIndex((one) => one.id === bing.id);
    check(
      '★ 09:00 排在 14:00 前面（按设定时间排，不是按创建顺序）',
      idxJia >= 0 && idxBing >= 0 && idxJia < idxBing,
      '甲@' + idxJia + ' 丙@' + idxBing,
    );
  }

  // ── ④ 不是今天的不进时间轴 ──
  await setPlanned(jia.id, `${yday}T09:00`);
  const goneFromTimeline = await waitFor(() => (!$('[data-timeline-item="' + jia.id + '"]') ? true : null), 6000);
  check('④ 设成昨天之后就不在时间轴里了（不跨天）', !!goneFromTimeline);
  check(
    '昨天的设定时间照样存着（只是不进时间轴）',
    !!(await todoOnDisk(jia.id)).plannedAt,
    (await todoOnDisk(jia.id)).plannedAt,
  );

  // ── ⑤ 清掉设定时间 ──
  pointerClick($('[data-todo-planned="' + jia.id + '"]'));
  await waitFor(() => $('[data-todo-planned-clear]'), 4000);
  $('[data-todo-planned-clear]').click();
  const clearedPlanned = await waitFor(async () => {
    const one = await todoOnDisk(jia.id);
    return one && !one.plannedAt ? one : null;
  }, 6000);
  check('⑤ 点「清掉」能把设定时间清掉', !!clearedPlanned);
  check(
    '卡片左下角回到「没设时间」',
    (($('[data-todo-planned="' + jia.id + '"]') || {}).innerText || '').indexOf('没设时间') >= 0,
    ($('[data-todo-planned="' + jia.id + '"]') || {}).innerText,
  );

  // 收尾：把丙的时间也清掉，给后面步骤留干净状态
  pointerClick($('[data-todo-planned="' + bing.id + '"]'));
  await waitFor(() => $('[data-todo-planned-clear]'), 4000);
  $('[data-todo-planned-clear]').click();
  await sleep(400);

  // ⚠️ 走之前**必须把 ⚙ 弹窗关掉**：点「清掉」不会自动关面板，
  //    留着的这层 `fixed inset-0` 会把下一步所有真实鼠标输入吃掉
  //    （realgesture.ps1 第一版就是这么被坑出一堆假失败的）。
  await closeAnyModal();
  check('收尾：弹窗已经关掉，不挡后面的真实鼠标输入', !$('[role="dialog"]'));

  return report({ jia: jia.id, bing: bing.id });
})();
