// 02 · 来源标注点了能跳回去（PRD 10.4 第 2 条）
//
// "来源标注为那篇笔记，点击能跳回去" —— 两种来源都要能跳：
//   笔记来的 → 认知区并打开那篇；信息区来的 → 信息区并高亮那一条。
(async () => {
  await ready();
  await enterTodos();

  const todos = await invoke('todo_list', {});
  const jia = todos.find((one) => one.title === '笔记来的甲');
  const fromInfo = todos.find((one) => one.source.kind === 'info' && (one.title || '').indexOf('M5 ') === 0);
  if (!jia || !fromInfo) return report({ why: '先跑 00 准备数据' });

  // ── ① 笔记来的：点来源 → 认知区打开那篇笔记 ──
  const noteLink = await waitFor(() => $('[data-todo-source-link="' + jia.id + '"]'), 6000);
  check('卡片上来源标注是可点的按钮', !!noteLink, noteLink && noteLink.innerText);
  pointerClick(noteLink);
  await sleep(900);

  const titleInput = await waitFor(() => $('input[placeholder="笔记标题"]'), 8000);
  check('跳过去之后到的是认知区（右栏标题框在）', !!titleInput);
  check(
    '打开的就是来源那篇笔记',
    titleInput && titleInput.value === 'M5 待办源笔记',
    titleInput && titleInput.value,
  );

  // ── ② 信息区来的：点来源 → 信息区并高亮那条 ──
  await enterTodos();
  const infoLink = await waitFor(() => $('[data-todo-source-link="' + fromInfo.id + '"]'), 6000);
  check('信息区来的待办也有可点的来源标注', !!infoLink, infoLink && infoLink.innerText);
  check(
    '来源标注写的是「来自信息区」',
    infoLink && infoLink.innerText.indexOf('来自信息区') >= 0,
    infoLink && infoLink.innerText,
  );

  pointerClick(infoLink);
  const infoEl = await waitFor(() => document.getElementById('info-' + fromInfo.source.infoId), 8000);
  check('跳到信息区并定位到了那条信息', !!infoEl, infoEl && (infoEl.innerText || '').slice(0, 40));
  check(
    '定位到的是"建为待办"的那条（原信息还在）',
    infoEl && (infoEl.innerText || '').indexOf('M5 验收信息') >= 0,
    infoEl && (infoEl.innerText || '').slice(0, 60),
  );
  check(
    '原信息上还挂着「已联动 → 待办」的去向',
    infoEl && (infoEl.innerText || '').indexOf('待办') >= 0,
    infoEl && (infoEl.innerText || '').slice(0, 80),
  );

  return report({ noteId: jia.source.noteId, infoId: fromInfo.source.infoId });
})();
