// 04 · ⚙ 设置：调整分类 + 「再次设定时间提醒」→ 首页动态区（PRD 10.4 第 4 条）
//
// 两个动作都在卡片右下角那个 ⚙ 里：**调整分类（q1~q4）** 与 **再次设定时间提醒**。
// 提醒那条要走完整条链路才算数：
//   点「设定提醒」→ `reminders.json` 里出现 `todo-remind`（pending）
//   → 后台调度线程扫到（30 秒一趟）→ 变 fired
//   → **首页动态区出现它**。
//
// 所以这里把 fireAt 设到"过去"，然后等最多 ~40 秒（调度线程 30 秒一趟）。
// 进度.md 第七节给 M5 的建议就是这么做的：改 fireAt 比等真实时间靠谱。
(async () => {
  await ready();
  await enterTodos();

  const jia = await todoByTitle('笔记来的甲');
  if (!jia) return report({ why: '先跑 00 准备数据' });

  // ── ① 打开 ⚙ ──
  const gear = await waitFor(() => $('[data-todo-gear="' + jia.id + '"]'), 6000);
  check('卡片右下角有 ⚙', !!gear);
  pointerClick(gear);
  await sleep(400);

  const q1Btn = await waitFor(() => $('[data-todo-quadrant-btn="q1"]'), 4000);
  check('⚙ 里有四象限分类按钮', !!q1Btn);
  check(
    '四个象限都在',
    ['q1', 'q2', 'q3', 'q4'].every((key) => !!$('[data-todo-quadrant-btn="' + key + '"]')),
  );
  check('还有「不分」按钮（能清掉分类）', !!$('[data-todo-quadrant-btn="none"]'));
  check('⚙ 里有「再次设定时间提醒」的输入 + 按钮', !!$('[data-todo-remind-input]') && !!$('[data-todo-remind-save]'));

  // ── ② 选 q1 ──
  //    ⚠️ 点了象限之后卡片会**移进那个象限里**（这就是 PRD 要的"该象限内出现它"），
  //    卡片一搬家，它身上那个 ⚙ 弹窗就跟着卸载了 —— 所以后面要**重新打开** ⚙，
  //    不能再指望刚才那个弹窗还开着（第一版就是这么写错的，报 null.click()）。
  q1Btn.click();
  const q1 = await waitFor(async () => {
    const one = await todoOnDisk(jia.id);
    return one && one.quadrant === 'q1' ? one : null;
  }, 6000);
  check('选了「重要且紧急」→ 磁盘上 quadrant=q1', !!q1, q1 && q1.quadrant);
  check('★ 只改了分类，别的字段没动', q1 && q1.status === jia.status && q1.title === jia.title && q1.source.kind === 'note');
  check('★ 待办没被删也没新增', (await invoke('todo_list', {})).some((one) => one.id === jia.id));

  // #8（2026-10-21 · 用户反馈第二批）：四象限板搬到首页了 —— 执行区这里**不该再有格子**。
  // 分类的结果只体现为卡片身上那个象限小标（下面那条断言），板子本身首页见。
  check('★ 执行区不再挂四象限板（已搬到首页）', !$('[data-quadrant]'));
  // ⚠️ 2026-09-21 用户拍板 B3（"两边都显示吧"）：进了象限**不再**从待办集搬走。
  //    所以这条断言从"待办集里已经没有它了"改成"待办集里也还在"，并看一眼那个象限小标。
  const alsoInSet = await waitFor(() => {
    const set = $('[data-todo-set]');
    return set && set.querySelector('[data-todo-id="' + jia.id + '"]') ? set : null;
  }, 4000);
  check('★ 待办集里**也**还在（B3：两边都显示）', !!alsoInSet);
  check(
    '卡片上带了象限小标（知道它排在哪儿）',
    !!$('[data-todo-quadrant-badge="' + jia.id + '"]'),
  );

  // ── 清掉分类（等价于"拖回待办集"） ──
  const gearAgain = await waitFor(() => $('[data-todo-gear="' + jia.id + '"]'), 4000);
  check('卡片搬进象限后 ⚙ 还在', !!gearAgain);
  if (gearAgain) {
    pointerClick(gearAgain);
    await sleep(400);
    const noneBtn = await waitFor(() => $('[data-todo-quadrant-btn="none"]'), 4000);
    check('重新打开 ⚙，里面有「不分」按钮', !!noneBtn);
    if (noneBtn) {
      noneBtn.click();
      const cleared = await waitFor(async () => {
        const one = await todoOnDisk(jia.id);
        return one && !one.quadrant ? one : null;
      }, 6000);
      check('点「不分」能把分类清掉', !!cleared);
      const backInSet = await waitFor(() => {
        const set = $('[data-todo-set]');
        return set && set.querySelector('[data-todo-id="' + jia.id + '"]') ? set : null;
      }, 6000);
      check('★ 清掉分类后卡片回到待办集', !!backInSet);
    } else {
      check('点「不分」能把分类清掉', false, '没找到按钮');
    }
  } else {
    check('点「不分」能把分类清掉', false, '没找到 ⚙');
  }

  // ── ③ 再次设定时间提醒（设到过去，等调度线程扫） ──
  const card = todoCard(jia.id);
  pointerClick($('[data-todo-gear="' + jia.id + '"]'));
  await sleep(400);
  const remindInput = await waitFor(() => $('[data-todo-remind-input]'), 4000);
  check('⚙ 里的提醒输入框在', !!remindInput, card ? '卡片在' : '卡片不在');

  // 设成"1 分钟前"，下一趟扫描就该弹
  const past = new Date(Date.now() - 60_000);
  const pad = (n) => String(n).padStart(2, '0');
  setValue(
    remindInput,
    `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(
      past.getMinutes(),
    )}`,
  );
  await sleep(200);
  const saveBtn = $('[data-todo-remind-save]');
  check('设了时间之后「设定提醒」按钮可点', saveBtn && !saveBtn.disabled);
  saveBtn.click();
  await sleep(600);

  const scheduled = await waitFor(async () => {
    const items = await invoke('reminder_list', {});
    return items.find((one) => one.kind === 'todo-remind' && one.refId === jia.id) || null;
  }, 6000);
  check('reminders.json 里排上了 todo-remind', !!scheduled, scheduled && scheduled.kind);
  check('提醒指向的就是这条待办', scheduled && scheduled.refId === jia.id);
  check('提醒里带着待办标题', scheduled && scheduled.payload.text === jia.title, scheduled && scheduled.payload.text);
  check(
    '待办上也留了一笔"我设过提醒"',
    await waitFor(async () => {
      const one = await todoOnDisk(jia.id);
      return one && one.reminderAt ? one : null;
    }, 4000) !== null,
  );

  // ── ④ 等后台调度线程把它弹出来（30 秒一趟） ──
  const fired = await waitFor(async () => {
    const items = await invoke('reminder_list', {});
    const one = items.find((r) => r.kind === 'todo-remind' && r.refId === jia.id);
    return one && one.status === 'fired' ? one : null;
  }, 45_000, 1000);
  check('★ 到点后后台把它标成 fired（最多等 45 秒）', !!fired, fired && fired.status);

  // ── ⑤ 首页动态区要出现它 ──
  await nav('首页');
  await sleep(700);
  const homeCard = await waitFor(() => $('[data-home-reminder="todo-remind"]'), 8000);
  check('★ 首页动态区出现了这条待办提醒', !!homeCard, homeCard && (homeCard.innerText || '').slice(0, 60));
  check(
    '首页上写的是待办标题（不是"某某信息还没推进"那种信息文案）',
    homeCard && (homeCard.innerText || '').indexOf(jia.title) >= 0,
    homeCard && (homeCard.innerText || '').slice(0, 80),
  );
  check('首页上有【去开始】按钮', !!$('[data-home-reminder-go="' + jia.id + '"]'));

  // ── ⑥ 点【去开始】→ 执行区并定位到它 ──
  if ($('[data-home-reminder-go="' + jia.id + '"]')) {
    $('[data-home-reminder-go="' + jia.id + '"]').click();
    const located = await waitFor(() => {
      const one = todoCard(jia.id);
      if (!one) return null;
      return (one.className || '').indexOf('ring-amber') >= 0 ? one : null;
    }, 8000);
    check('★ 点【去开始】跳到执行区并高亮定位那条待办', !!located);
  } else {
    check('★ 点【去开始】跳到执行区并高亮定位那条待办', false, '首页没有那个按钮');
  }

  // 把这条提醒收掉，免得它在后面几步继续挂在首页上
  const mineReminders = (await invoke('reminder_list', {})).filter(
    (one) => one.kind === 'todo-remind' && one.refId === jia.id,
  );
  for (const one of mineReminders) await invoke('reminder_dismiss', { id: one.id });

  return report({ todoId: jia.id, reminderId: fired && fired.id, dismissed: mineReminders.length });
})();
