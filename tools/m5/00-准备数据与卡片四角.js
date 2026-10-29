// 00 · M5 准备数据 + 待办卡片四角 + 来源标注（PRD 10.4 第 1、2 条）
//
// 造出**三种来源**的待办各若干，后面每一步都靠它们：
//   ① `note`   —— 认知笔记正文里写 `-[]` 自动检测出来的
//   ② `info`   —— 信息区点「建为待办」建出来的（用户点名要能标完成的那种）
//   ③ `manual` —— 执行区里手动加的
(async () => {
  await ready();
  await enterTodos();

  // 上次跑留下的先清干净（含"来源已移除"的待办：M5 起删笔记会标它，攒着会干扰计数）
  const cleaned = await cleanupTestData();
  await sleep(500);

  // ── ① 笔记 → 自动检测 ──
  const note = await invoke('note_create', { title: 'M5 待办源笔记', kind: 'doc' });
  await invoke('note_save', {
    note: Object.assign({}, note, {
      content: '-[]笔记来的甲\n-[]笔记来的乙\n-[]笔记来的丙',
    }),
  });
  await sleep(700);

  // ── ② 信息区 → 建为待办 ──
  const info = await invoke('info_create', {
    text: 'M5 验收信息：拿来验信息区来的待办也能标完成',
    kind: 'text',
    categories: ['主动冒出'],
    assetPath: null,
  });
  const infoTodo = await invoke('info_link_todo', { infoId: info.id });
  await sleep(500);

  // ── ③ 手动 ──
  const manual = await invoke('todo_create', { title: '手工建的丁' });
  await sleep(600);

  const todos = await invoke('todo_list', {});
  const find = (id) => todos.find((one) => one.id === id) || null;
  const byTitle = (title) => todos.find((one) => one.title === title) || null;

  check(
    '笔记里的 3 条标记都生成了待办',
    ['笔记来的甲', '笔记来的乙', '笔记来的丙'].every((t) => byTitle(t)),
    todos.map((t) => t.title).join(' | '),
  );
  const jia = byTitle('笔记来的甲');
  check('笔记来源记的是 kind=note', jia && jia.source.kind === 'note', jia && jia.source.kind);
  check(
    '来源里记着是那篇笔记',
    jia && jia.source.noteId === note.id,
    jia && jia.source.noteId,
  );
  const fromInfo = find(infoTodo.id);
  check('信息来源记的是 kind=info', fromInfo && fromInfo.source.kind === 'info', fromInfo && fromInfo.source.kind);
  check('手动来源记的是 kind=manual', (byTitle('手工建的丁') || {}).source?.kind === 'manual');

  // ── 界面：卡片要出现在待办集里 ──
  await refreshTodos();
  await enterTodos();

  const cardJia = await waitFor(() => todoCard(jia.id), 8000);
  check('待办集里出现了那张卡片', !!cardJia);
  if (!cardJia) return report({ why: '卡片没渲染出来', noteId: note.id });

  // 四角（PRD 10.4 第 1 条：标题 / 设定时间 / 【开始】/ ⚙）
  const titleBtn = $('[data-todo-title-btn="' + jia.id + '"]');
  check('左上角：标题（可点，点了改标题）', !!titleBtn, titleBtn && titleBtn.innerText);
  check('标题文字对', titleBtn && titleBtn.innerText.trim() === '笔记来的甲', titleBtn && titleBtn.innerText);

  const plannedBtn = $('[data-todo-planned="' + jia.id + '"]');
  check('左下角：设定时间', !!plannedBtn, plannedBtn && plannedBtn.innerText);
  check(
    '没设时间时显示「没设时间」',
    plannedBtn && plannedBtn.innerText.indexOf('没设时间') >= 0,
    plannedBtn && plannedBtn.innerText,
  );

  const startBtn = $('[data-todo-start="' + jia.id + '"]');
  check('右上角：【开始】', !!startBtn, startBtn && startBtn.innerText);

  const gearBtn = $('[data-todo-gear="' + jia.id + '"]');
  check('右下角：⚙', !!gearBtn, gearBtn && gearBtn.innerText);

  // 🔴 2026-10-04（V2 打磨 D 批）**这条断言按新设计改过一次**：
  //    原来是"卡片是圆角的（rounded-2xl）" —— 但 D 批把待办卡改成了**线分层**：
  //    一屏十几个圆角框会让眼睛没有落点（用户原话"圆角矩形太多了就会眼瞎"），
  //    所以现在卡片是"贴身行 + 左侧色条"，行与行之间靠父级 `divide-y` 的细线分。
  //    断言跟着改成量**新规矩**（左侧色条在 + 不再是圆角框），别把旧的改回去。
  const cs = getComputedStyle(cardJia);
  check(
    '卡片是"线分层"的行（左侧 2px 色条 + 不再各自包圆角框）',
    parseFloat(cs.borderLeftWidth) >= 2 && parseFloat(cs.borderTopLeftRadius) === 0
      && (cardJia.className || '').indexOf('rounded-2xl') < 0,
    cardJia.className,
  );
  const rowList = cardJia.closest('ul');
  check(
    '同一组里的行有"行间细线"（父级带 divide-y）',
    !!rowList && (rowList.className || '').indexOf('divide-y') >= 0,
    rowList ? rowList.className : '找不到父级 ul',
  );

  // 卡片底部：来源标注
  const sourceLink = $('[data-todo-source-link="' + jia.id + '"]');
  check('卡片底部有来源标注', !!sourceLink, sourceLink && sourceLink.innerText);
  check(
    '来源写明了是哪篇笔记',
    sourceLink && sourceLink.innerText.indexOf('M5 待办源笔记') >= 0,
    sourceLink && sourceLink.innerText,
  );
  check(
    '自动检测来的也标出来',
    sourceLink && sourceLink.innerText.indexOf('自动检测') >= 0,
    sourceLink && sourceLink.innerText,
  );

  // 三种来源的卡片都在
  const infoCard = todoCard(fromInfo.id);
  check('信息区来的待办也有卡片', !!infoCard);
  check(
    '信息来源标注也认得出',
    infoCard && (infoCard.innerText || '').indexOf('来自信息区') >= 0,
    infoCard && (infoCard.innerText || '').slice(0, 80),
  );
  const manualCard = todoCard(manual.id);
  check('手动建的待办也有卡片', !!manualCard);
  check(
    '手动来源标注是「手动建的」',
    manualCard && (manualCard.innerText || '').indexOf('手动建的') >= 0,
    manualCard && (manualCard.innerText || '').slice(0, 80),
  );

  return report({
    noteId: note.id,
    infoId: info.id,
    ids: { jia: jia.id, note: note.id, info: info.id, infoTodo: infoTodo.id, manual: manual.id },
    cleaned,
  });
})();
