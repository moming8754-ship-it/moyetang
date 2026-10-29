// 05 · 番茄钟（PRD 10.4 第 6、7 条）
//
// 三条硬要求：
//   ① 三种模式 **正计时 / 倒计时 / 不计时** 都能切；
//   ② 能写**备注**、能看到**来源文本**；
//   ③ **结束 → 待办被标为完成，但依然存在（未删除）**，记录进 `pomodoros`。
//
// ⚠️ 倒计时**不在这里等真实的 25 分钟**（进度.md 第七节给 M5 的建议）：
//    只验"表盘真的在走"（选 1 分钟档、看到它从 01:00 往下掉），
//    计时边界交给 Rust 单测（`store/todo.rs` 的番茄钟那几条）。
//    真正的"倒计时走完自动标完成"由第 ③ 步手动点结束来覆盖同样的收尾逻辑。
//
// 🔴 **B 批（2026-10-02）改了流程，这里跟着改**：
//    用户实测反馈「开启待办后右下角的『结束』，说结束就结束有点搞笑，应该加个确认键」
//    → 现在点 `[data-pomodoro-finish]` **只出确认条**，要再点
//      `[data-pomodoro-confirm-finish]` 才真收尾。
//    ⚠️ 这不是测试放宽，是**产品行为按用户要求变了**；两条都验（先确认、再收尾）。
(async () => {
  await ready();
  await enterTodos();

  const yi = await todoByTitle('笔记来的乙');
  if (!yi) return report({ why: '先跑 00 准备数据' });

  // ── 打开番茄钟 ──
  const start = await waitFor(() => $('[data-todo-start="' + yi.id + '"]'), 6000);
  check('卡片右上角有【开始】', !!start, start && start.innerText);
  pointerClick(start);
  const clock = await waitFor(() => $('[data-pomodoro-clock]'), 5000);
  check('点【开始】打开了番茄钟', !!clock);

  // ── ① 三种模式 ──
  for (const mode of ['countup', 'countdown', 'free']) {
    check('有「' + mode + '」模式按钮', !!$('[data-pomodoro-mode-btn="' + mode + '"]'));
  }
  check(
    '三个按钮的文字是正计时/倒计时/不计时',
    ['countup', 'countdown', 'free']
      .map((m) => (($('[data-pomodoro-mode-btn="' + m + '"]') || {}).innerText || '').trim())
      .join('/') === '正计时/倒计时/不计时',
    ['countup', 'countdown', 'free']
      .map((m) => (($('[data-pomodoro-mode-btn="' + m + '"]') || {}).innerText || '').trim())
      .join('/'),
  );
  check('有备注输入框', !!$('[data-pomodoro-note]'));
  check('显示了来源文本', !!$('[data-pomodoro-source]'), ($('[data-pomodoro-source]') || {}).innerText);
  check(
    '来源文本写的是那篇笔记',
    ($('[data-pomodoro-source]') || {}).innerText?.indexOf('M5 待办源笔记') >= 0,
    ($('[data-pomodoro-source]') || {}).innerText,
  );

  // ── ② 切到倒计时，验表盘真的在走 ──
  $('[data-pomodoro-mode-btn="countdown"]').click();
  await sleep(200);
  check('倒计时模式下出现时长档位', !!$('[data-pomodoro-duration="1"]'));
  $('[data-pomodoro-duration="1"]').click();
  await sleep(200);
  const firstClock = ($('[data-pomodoro-clock]') || {}).innerText;
  check('选了 1 分钟 → 表盘从 01:00 开始', firstClock === '01:00', firstClock);
  await sleep(2600);
  const secondClock = ($('[data-pomodoro-clock]') || {}).innerText;
  check('★ 表盘真的在往下走（不是个死数字）', secondClock !== firstClock, firstClock + ' -> ' + secondClock);
  check('走的方向是"变小"', (function () {
    const secs = (t) => { const p = String(t).split(':'); return Number(p[0]) * 60 + Number(p[1]); };
    return secs(secondClock) < secs(firstClock);
  })(), firstClock + ' -> ' + secondClock);

  // 正计时也要能走（表盘改成往上数）
  $('[data-pomodoro-mode-btn="countup"]').click();
  await sleep(2200);
  const upClock = ($('[data-pomodoro-clock]') || {}).innerText;
  check('正计时模式下表盘从 00:00 往上走', upClock !== '00:00', upClock);

  // ── ③ 关掉不记录 ──
  // 🔴 B 批（2026-10-02）改名了：这个按钮原来叫「关闭（不记录）」、属性 `data-pomodoro-cancel`，
  //    现在叫「**收起面板**」、属性 `data-pomodoro-minimize`（语意见 `Pomodoro.tsx` 的注释：
  //    面板不再是模态弹窗，收起来**不影响计时**，所以"关闭"这个词会误导）。
  const closeBtn = await waitFor(() => $('[data-pomodoro-minimize]'), 4000);
  check('面板上有「收起面板」按钮（B 批改名 + 换属性）', !!closeBtn);
  const beforeCount = (await invoke('todo_list', {})).find((one) => one.id === yi.id).pomodoros.length;
  closeBtn?.click();
  await sleep(600);
  check('点「收起面板」面板收起了', !$('[data-pomodoro-clock]'));
  check(
    '★ 收起面板不会记一笔',
    (await invoke('todo_list', {})).find((one) => one.id === yi.id).pomodoros.length === beforeCount,
  );

  // ── ④ 不计时 + 备注 + 结束并标完成 ──
  // ⚠️ 再开一场：面板收起来之后卡片上的【开始】还在，点它就回来
  const start2 = await waitFor(() => $('[data-todo-start="' + yi.id + '"]'), 6000);
  check('收起后卡片的【开始】还在', !!start2);
  start2?.click();
  const reopened = await waitFor(() => $('[data-pomodoro-mode-btn="free"]'), 6000);
  check('★ 再点【开始】面板又回来了', !!reopened);
  $('[data-pomodoro-mode-btn="free"]')?.click();
  await sleep(200);
  setValue($('[data-pomodoro-note]'), '被手机打断了一次');
  await sleep(200);
  check('备注打进框里了', ($('[data-pomodoro-note]') || {}).value === '被手机打断了一次', ($('[data-pomodoro-note]') || {}).value);

  // B 批（2026-10-02）：点「结束」**先出确认条**，再点确认才真收尾 —— 两步都验
  // ⚠️ 用可选链（`?.`）+ 先确认元素在：找不到就报红，别让整条脚本抛 TypeError 崩掉
  //    （2026-10-02 就是这么崩的：`$('[data-pomodoro-finish]').click()` 在 null 上取 click）
  const finishBtn = await waitFor(() => $('[data-pomodoro-finish]'), 4000);
  check('面板上有「结束并标完成」按钮', !!finishBtn);
  finishBtn?.click();
  const confirmBar = await waitFor(() => $('[data-pomodoro-confirm]'), 4000);
  check('★ 点「结束」先出确认条（B 批新增的二次确认）', !!confirmBar);
  const notYetDone = await todoOnDisk(yi.id);
  check('★★ 还没确认时**什么都不落盘**（待办没被标完成）', !!(notYetDone && notYetDone.status !== 'done'), notYetDone && notYetDone.status);

  const confirmOk = await waitFor(() => $('[data-pomodoro-confirm-finish]'), 4000);
  check('确认条上有「✓ 结束并标完成」', !!confirmOk);
  confirmOk?.click();
  const finished = await waitFor(async () => {
    const one = await todoOnDisk(yi.id);
    return one && one.status === 'done' ? one : null;
  }, 6000);
  check('★ 结束 → 待办被标为完成', !!finished, finished && finished.status);
  check('★ 完成时间也盖上了', !!(finished && finished.doneAt), finished && finished.doneAt);

  const stillThere = (await invoke('todo_list', {})).find((one) => one.id === yi.id);
  check('★★ 结束 ≠ 删除：待办依然存在（PRD 10.4 第 7 条）', !!stillThere, stillThere && stillThere.title);
  check('★★ 记录进了 pomodoros', !!(stillThere && stillThere.pomodoros.length === beforeCount + 1), stillThere && String(stillThere.pomodoros.length));
  const record = stillThere && stillThere.pomodoros[stillThere.pomodoros.length - 1];
  check('记录里模式是 free（不计时）', record && record.mode === 'free', record && record.mode);
  check('记录里带着备注', record && record.note === '被手机打断了一次', record && record.note);
  check('记录里有时间戳', !!(record && record.at), record && record.at);
  check('记录里有秒数', record && typeof record.seconds === 'number', record && String(record.seconds));

  check('弹窗收起了', !$('[data-pomodoro-clock]'));

  // 界面上番茄数量徽标跟着变
  await refreshTodos();
  await enterTodos();
  // ⚠️ M9-4 起：番茄钟结束顺手标完成 → 卡片**移进收起的归档区**，
  //    不先把它弄回 DOM 里，这里必然拿不到那个徽标（2026-09-21 全量回归踩到）。
  await ensureCardVisible(yi.id);
  check(
    '卡片上显示了番茄钟次数',
    !!$('[data-todo-pomodoro-count="' + yi.id + '"]'),
    ($('[data-todo-pomodoro-count="' + yi.id + '"]') || {}).innerText,
  );

  return report({ todoId: yi.id, pomodoros: stillThere && stillThere.pomodoros.length });
})();
