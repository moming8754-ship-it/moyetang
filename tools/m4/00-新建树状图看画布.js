// 00 · 新建一篇树状图，确认真画布起来了（PRD 10.3 第 1 条）
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(500);

  // 上次跑验收留下的测试笔记先清掉 —— 整套脚本要能重复跑
  const cleaned = await cleanupTestData();
  await sleep(500);

  // 「新建笔记 ▾」→ 树状图
  const newBtn = $$('button').find((b) => (b.innerText || '').indexOf('新建笔记') >= 0);
  check('左栏有「新建笔记」', !!newBtn);
  pointerClick(newBtn);
  await sleep(200);

  const treeOpt = $$('button').find((b) => (b.innerText || '').indexOf('🌳 树状图') >= 0);
  check('下拉里能选「🌳 树状图」', !!treeOpt, txt($('aside')));
  pointerClick(treeOpt);

  // ── 先等**刚建那篇**的面板真正挂上来，再断言画布内容。
  //
  // ⚠️ 顺序很重要，踩过：`canvas()` 一出现就往下断言，但那时右栏可能还停在
  // **上一篇**（新建是异步的：createNote → refresh → setPickedId）。
  // 之前一直没露馅，是因为上一轮留下的恰好也是个 1 节点的空树；
  // 用户自己那篇「密码学联系」一在列表里，断言立刻读到它的 12 个节点。
  //
  // 可靠的信号是**焦点**：刚建的笔记 `autoFocusTitle` 会把标题框聚焦并全选，
  // 别处的标题框不会（第一版直接在 `$('input[placeholder=笔记标题]')` 上打字，
  // 事件发给了随即被卸载的旧面板 → 标题一个字都没存上）。
  const titleInput = await waitFor(() => {
    const el = $('input[placeholder="笔记标题"]');
    return el && document.activeElement === el ? el : null;
  }, 8000);
  check('等到了新笔记的标题框（且它已获得焦点）', !!titleInput, titleInput && titleInput.value);
  if (!titleInput) return report({ why: '新笔记的标题框没拿到焦点' });

  const cv = await waitFor(() => canvas(), 6000);
  check('画布出现了（[data-tree-canvas]）', !!cv);

  // 根节点必须是「中心主题」，而且只该有一个
  const rootNode = await waitFor(() => $$('[data-node-id]')[0], 4000);
  check('画布上有一个根节点', !!rootNode);
  check(
    '根节点文字是「中心主题」',
    rootNode && rootNode.getAttribute('data-node-text') === '中心主题',
    rootNode && rootNode.getAttribute('data-node-text'),
  );
  check('刚建好只该有 1 个节点', $$('[data-node-id]').length === 1, nodeTexts().join(' | '));

  // 连线层要在（现在还没边，但 svg 得有）
  check('有连线层 svg', !!$('[data-tree-canvas] svg'));

  // 起个能认出来的名字，后面几步都用它

  setValue(titleInput, 'M4 验收树');
  key(titleInput, 'Enter');
  const renamed = await waitFor(async () => {
    const list = await invoke('note_list', {});
    return list.some((n) => n.title === 'M4 验收树');
  }, 6000);
  check('在标题框里改名能落盘（Enter 提交）', !!renamed);

  const notes = await invoke('note_list', {});
  const mine = notes.find((n) => n.title === 'M4 验收树');
  check('标题已落盘', !!mine, notes.map((n) => n.title + '/' + n.kind).join(', '));
  check('后端认得这是树状图', mine && mine.kind === 'tree', mine && mine.kind);
  check('落盘后根节点还在', mine && mine.root && mine.root.text === '中心主题');
  check('节点有 id（后端生成的 uuid）', !!(mine && mine.root && mine.root.id));

  return report({ noteId: mine && mine.id, cleaned });
})();
