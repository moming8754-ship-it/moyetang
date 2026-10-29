// 03 · M5-1 自动检测补完（PRD 10.4 第 3 条）
//
// 三件事：
//   ① 同一条标记**不会重复生成**待办（反复保存也不翻倍）；
//   ② 把标记删掉 → 待办标「来源已移除」，**且不崩溃**；
//   ③ 标记加回来 → 撤销标记，还是原来那条（带着勾选状态）。
//
// 另外补两条 M5 新做的：
//   ④ **树节点文字**里的 `-[]` 也建待办（用户 2026-09-21 拍板）；
//   ⑤ 整篇笔记被删掉 → 它的待办全部标「来源已移除」，一条都不删。
//
// ⚠️ 顺便钉死 M4.2 挖出来的那个早退 bug：M3 那版 `sync_markers` 在
//    "正文里一条标记都没有"时直接 return，于是**把标记全删光**这个最常见的动作
//    反而永远不会标「来源已移除」。所以这里专门验"全删光"。
(async () => {
  await ready();
  await enterTodos();

  const note = (await invoke('note_list', {})).find((one) => one.title === 'M5 待办源笔记');
  if (!note) return report({ why: '先跑 00 准备数据' });
  const body = () => invoke('note_get', { id: note.id });

  const findTodo = async (title) =>
    (await invoke('todo_list', {})).find((one) => one.title === title) || null;

  // ── ① 不重复生成 ──
  const before = (await invoke('todo_list', {})).length;
  for (let i = 0; i < 3; i += 1) {
    await invoke('note_save', { note: await body() });
  }
  await sleep(600);
  const after = await invoke('todo_list', {});
  check('同一条标记反复保存不会重复生成待办', after.length === before, before + ' -> ' + after.length);
  check(
    '三条标记还是各自一条',
    after.filter((one) => one.source.noteId === note.id).length === 3,
    after.filter((one) => one.source.noteId === note.id).map((o) => o.title).join(' | '),
  );

  // ── ② 删掉一条标记 → 来源已移除（不删待办） ──
  const yi = await findTodo('笔记来的乙');
  check('删之前「笔记来的乙」那条在', !!yi);
  const countBefore = after.length;

  const kept = await body();
  await invoke('note_save', {
    note: Object.assign({}, kept, { content: '-[]笔记来的甲\n-[]笔记来的丙' }),
  });
  await sleep(800);

  const markedYi = await waitFor(async () => {
    const one = await todoByTitle('笔记来的乙');
    return one && one.source.sourceRemoved ? one : null;
  }, 6000);
  check('删掉标记后该待办被标「来源已移除」', !!markedYi, markedYi && String(markedYi.source.sourceRemoved));
  check('★ 被标的待办没有被删掉', !!(await findTodo('笔记来的乙')));
  check(
    '★ 待办总数没变',
    (await invoke('todo_list', {})).length === countBefore,
    String((await invoke('todo_list', {})).length),
  );
  check(
    '还在正文里的那两条没被误标',
    (await findTodo('笔记来的甲')).source.sourceRemoved !== true &&
      (await findTodo('笔记来的丙')).source.sourceRemoved !== true,
  );
  check('界面没崩（待办集还在）', !!$('[data-todo-set]'));

  // 界面上要看得见那个标记
  await refreshTodos();
  await enterTodos();
  const badTag = await waitFor(() => $('[data-todo-source-removed-tag="' + yi.id + '"]'), 6000);
  check('卡片上显示了「来源已移除」', !!badTag, badTag && badTag.innerText);
  check(
    '卡片上还看得出原来来自哪篇笔记',
    (todoCard(yi.id) || {}).innerText?.indexOf('M5 待办源笔记') >= 0,
    (todoCard(yi.id) || {}).innerText?.slice(0, 60),
  );

  // ── ③ 加回来 → 撤销标记，还是原来那条 ──
  const back = await body();
  await invoke('note_save', {
    note: Object.assign({}, back, { content: '-[]笔记来的甲\n-[]笔记来的乙\n-[]笔记来的丙' }),
  });
  await sleep(800);
  const revived = await waitFor(async () => {
    const one = await todoByTitle('笔记来的乙');
    return one && !one.source.sourceRemoved ? one : null;
  }, 6000);
  check('标记加回来 → 撤销「来源已移除」', !!revived);
  check('★ 撤销后还是原来那条（id 没变）', revived && revived.id === yi.id, revived && revived.id);
  check(
    '★ 没有因此多出一条',
    (await invoke('todo_list', {})).length === countBefore,
    String((await invoke('todo_list', {})).length),
  );

  // ── ④ 全删光也要标上（M4.2 挖出来的早退 bug） ──
  const full = await body();
  await invoke('note_save', { note: Object.assign({}, full, { content: '这次一条标记都不写了' }) });
  await sleep(800);
  const allGone = await invoke('todo_list', {});
  const mine = allGone.filter((one) => one.source.noteId === note.id);
  check('★ 标记全删光之后，三条全被标「来源已移除」', mine.length === 3 && mine.every((one) => one.source.sourceRemoved === true), mine.map((o) => o.title + ':' + o.source.sourceRemoved).join(', '));
  check('★ 一条都没少（只标不删）', mine.length === 3, String(mine.length));

  // ── ⑤ 树节点文字也参与检测 ──
  //    ⚠️ 名字必须和正文那篇**不一样**：上面 `find(title === 'M5 待办源笔记')`
  //       会把两篇都匹配到，随机拿到树那篇，后面全乱
  const tree = await invoke('note_create', { title: 'M5 树里的待办', kind: 'tree' });
  const added = await invoke('note_tree_add_child', {
    noteId: tree.id,
    parentId: tree.root.id,
    text: '-[]树里冒出来的待办',
  });
  await sleep(700);
  // ⚠️ 不能只按标题找：上一轮要是留了同名的旧待办（来源已移除但没删），
  //    会先命中那条旧的，后面的 noteId 断言就莫名其妙失败。**按"这棵树"来认。**
  const treeTodo = await waitFor(async () =>
    (await invoke('todo_list', {})).find(
      (one) => one.title === '树里冒出来的待办' && one.source.noteId === tree.id,
    ) || null, 6000);
  check('★ 树节点里写 -[] 也会生成待办（M5 新做的）', !!treeTodo, treeTodo && treeTodo.title);
  check('来源记的是那棵树', treeTodo && treeTodo.source.noteId === tree.id, treeTodo && treeTodo.source.noteId);
  check('★ 记下了是哪个节点（树里改字靠它认人）', !!(treeTodo && treeTodo.source.nodeId), treeTodo && treeTodo.source.nodeId);
  check('树节点没有行号', treeTodo && treeTodo.source.markerLine === undefined, treeTodo && String(treeTodo.source.markerLine));

  // 删掉那个节点 → 待办标「来源已移除」但不删
  const childId = (added.note.root.children || []).find((c) => c.text === '-[]树里冒出来的待办').id;
  await invoke('note_tree_remove', { noteId: tree.id, nodeId: childId });
  await sleep(800);
  const treeGone = await waitFor(async () => {
    const one = (await invoke('todo_list', {})).find((o) => o.id === (treeTodo && treeTodo.id));
    return one && one.source.sourceRemoved ? one : null;
  }, 6000);
  check('删掉树节点 → 待办标「来源已移除」', !!treeGone);
  check('★ 树节点删了待办也不删', !!((await invoke('todo_list', {})).find((o) => o.id === (treeTodo && treeTodo.id))));

  // ── ⑥ 整篇笔记被删 → 它的待办全部标上 ──
  const doomed = await invoke('note_create', { title: 'M5 临时笔记', kind: 'doc' });
  await invoke('note_save', {
    note: Object.assign({}, doomed, { content: '-[]这条会随笔记一起失去来源' }),
  });
  await sleep(700);
  const doomeTodo = await waitFor(async () =>
    (await invoke('todo_list', {})).find(
      (one) => one.title === '这条会随笔记一起失去来源' && one.source.noteId === doomed.id,
    ) || null, 6000);
  check('临时笔记也能产出待办', !!doomeTodo, doomeTodo && doomeTodo.source.noteId);

  await invoke('note_delete', { id: doomed.id });
  await sleep(800);
  const orphaned = await waitFor(async () => {
    const one = (await invoke('todo_list', {})).find((o) => o.id === (doomeTodo && doomeTodo.id));
    return one && one.source.sourceRemoved ? one : null;
  }, 6000);
  check('★ 笔记被删 → 待办标「来源已移除」', !!orphaned);
  check('★ 笔记被删也不连带删待办', !!((await invoke('todo_list', {})).find((o) => o.id === (doomeTodo && doomeTodo.id))));

  // 清理入口要出现
  await refreshTodos();
  await enterTodos();
  check(
    '待办集上出现了「来源已移除 · 清理」入口',
    !!$('[data-todo-purge]'),
    ($('[data-todo-purge]') || {}).innerText,
  );

  // 把树那篇清掉（它叫 M5 树里的待办，cleanup 的规则里没有它，手工删）
  await invoke('note_delete', { id: tree.id });

  // ── 收尾：把三条标记写回去，给后面的步骤留一份干净数据 ──
  //    （顺带再验一次"撤回来"：待办应该原地复活，而不是新建三条）
  const restore = await body();
  await invoke('note_save', {
    note: Object.assign({}, restore, { content: '-[]笔记来的甲\n-[]笔记来的乙\n-[]笔记来的丙' }),
  });
  await sleep(800);
  const alive = (await invoke('todo_list', {})).filter(
    (one) => one.source.noteId === note.id && !one.source.sourceRemoved,
  );
  check(
    '收尾：三条标记写回去，三条待办原地复活（没新建）',
    alive.length === 3,
    alive.map((o) => o.title).join(' | '),
  );

  return report({ noteId: note.id, treeId: tree.id });
})();
