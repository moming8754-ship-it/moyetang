// 01 · 标完成 / 取消完成（**M5 第一件事**，用户点名要的）
//
// 关键要求：**来自信息区的待办也必须能标完成** —— M3 过渡期它是条死路
// （信息区建的待办当时没有任何界面能改状态），用户提过两次。
// 所以这一步**三种来源各验一遍**：note / info / manual。
//
// 顺带钉住三条不能破的规矩：
//   ① 标完成 ≠ 删除（PRD 5.3 / 10.4）；
//   ② 只改状态，来源、标题、番茄钟记录一律不许被动；
//   ③ 取消完成要把 doneAt 抹掉（不然界面上会挂着个"已完成"的旧时间）。
(async () => {
  await ready();
  await enterTodos();

  const todos = await invoke('todo_list', {});
  const jia = todos.find((one) => one.title === '笔记来的甲');
  const fromInfo = todos.find((one) => one.source.kind === 'info' && (one.title || '').indexOf('M5 ') === 0);
  const manual = todos.find((one) => one.title === '手工建的丁');

  check('笔记来的待办在', !!jia, todos.map((t) => t.title).join(' | '));
  check('信息区来的待办在（用户点名要的那一种）', !!fromInfo, fromInfo && fromInfo.title);
  check('手动建的待办在', !!manual);
  if (!jia || !fromInfo || !manual) return report({ why: '先跑 00 准备数据' });

  const totalBefore = todos.length;

  /** 对三种来源跑同一套"勾上 → 再取消"的检查 */
  const roundTrip = async (label, target) => {
    const card = await waitFor(() => todoCard(target.id), 6000);
    const box = todoCheck(target.id);
    check(`【${label}】卡片上有勾选框`, !!card && !!box, box && box.innerText);
    if (!card || !box) return;

    // ── 勾上 ──
    check(`【${label}】一开始是未完成`, box.innerText.trim() === '☐', box.innerText);
    pointerClick(box);
    const doneOnDisk = await waitFor(async () => {
      const one = await todoOnDisk(target.id);
      return one && one.status === 'done' ? one : null;
    }, 6000);
    check(`【${label}】勾上之后磁盘上是 done`, !!doneOnDisk, doneOnDisk && doneOnDisk.status);
    check(`【${label}】标完成会自动盖 doneAt`, !!(doneOnDisk && doneOnDisk.doneAt), doneOnDisk && doneOnDisk.doneAt);
    check(
      `【${label}】★ 标完成不等于删除，待办还在`,
      (await invoke('todo_list', {})).some((one) => one.id === target.id),
    );
    check(
      `【${label}】★ 总数没变`,
      (await invoke('todo_list', {})).length === totalBefore,
      String((await invoke('todo_list', {})).length),
    );
    check(
      `【${label}】来源没被动过`,
      (doneOnDisk && doneOnDisk.source.kind) === target.source.kind,
      doneOnDisk && doneOnDisk.source.kind,
    );
    check(`【${label}】标题没被动过`, doneOnDisk && doneOnDisk.title === target.title, doneOnDisk && doneOnDisk.title);

    // 界面跟着变（不是只有磁盘变了）
    // ⚠️ M9-4 起标完成会把卡片移进**收起的**归档区 → 先让它回到 DOM 里再断言
    await ensureCardVisible(target.id);
    const cardAfter = await waitFor(() => {
      const one = todoCard(target.id);
      return one && one.getAttribute('data-todo-done') === '1' ? one : null;
    }, 4000);
    check(`【${label}】卡片上也变成已完成`, !!cardAfter, cardAfter && cardAfter.getAttribute('data-todo-done'));
    check(
      `【${label}】勾选框变成 ☑`,
      (todoCheck(target.id) || {}).innerText?.trim() === '☑',
      (todoCheck(target.id) || {}).innerText,
    );

    // ── 再取消（走 uncheckTodo：卡片此时在展开的归档区里）──
    await uncheckTodo(target.id);
    const openAgain = await waitFor(async () => {
      const one = await todoOnDisk(target.id);
      return one && one.status === 'open' ? one : null;
    }, 6000);
    check(`【${label}】取消完成能退回 open`, !!openAgain, openAgain && openAgain.status);
    check(
      `【${label}】取消完成要把 doneAt 抹掉`,
      !!(openAgain && !openAgain.doneAt),
      openAgain && JSON.stringify(openAgain.doneAt),
    );
    check(
      `【${label}】★ 来回勾不会多出待办`,
      (await invoke('todo_list', {})).length === totalBefore,
    );
  };

  await roundTrip('笔记来的', jia);
  await roundTrip('信息区来的', fromInfo);
  await roundTrip('手动建的', manual);

  // ── 从信息区那边看：信息本身不受影响（联动记录还在） ──
  const linkedInfo = (await invoke('info_list', {})).find((one) => one.id === fromInfo.source.infoId);
  check('原信息还在（标完成不影响它）', !!linkedInfo, linkedInfo && linkedInfo.text);
  check(
    '原信息上「已联动 → 待办」的去向还在',
    linkedInfo && linkedInfo.links.some((one) => one.targetKind === 'todo'),
    linkedInfo && JSON.stringify(linkedInfo.links),
  );

  return report({ jia: jia.id, fromInfo: fromInfo.id, manual: manual.id });
})();
