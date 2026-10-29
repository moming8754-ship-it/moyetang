// 01 · 选中节点 → 三个图标（内联 SVG：垃圾桶 / 加子节点 / 加同级），根节点的删除与加同级置灰
//      2026-09-22：原来是 emoji（🗑 / ⊕ / ⋮＋），按用户要求换成图4那套圆形描边图标
//      —— PRD 10.3「选中节点出现三个图标」
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');

  const cv = await waitFor(() => canvas(), 5000);
  check('画布在', !!cv);

  // ⚠️ 选中走的是 pointerdown，el.click() 不行 —— 必须派发真实指针序列
  const root = $('[data-node-id]');
  check('找到根节点', !!root, nodeTexts().join(' | '));
  pointerClick(root);
  await sleep(250);

  const bar = await waitFor(() => $('[data-tree-toolbar]'), 3000);
  check('选中后出现了三图标工具条', !!bar);
  check(
    '工具条里正好三个按钮',
    bar && $$('button', bar).length === 3,
    bar && String($$('button', bar).length),
  );

  const trash = byTitle('中心主题不能删（它是整棵树的根）');
  const child = byTitle('加子节点');
  const sibling = byTitle('中心主题没有同级节点');
  check('🗑 在（根节点上写着"不能删"）', !!trash);
  check('⊕ 在（加子节点）', !!child);
  check('⋮＋ 在（根节点上写着"没有同级"）', !!sibling, 
    $$('[title]').map((e) => e.getAttribute('title')).join(' | '));

  // 根节点上：🗑 和 ⋮＋ 必须置灰（不是藏起来 —— 藏了用户会以为功能没了）
  check('根节点上 🗑 置灰', trash && trash.disabled === true);
  check('根节点上 ⋮＋ 置灰', sibling && sibling.disabled === true);
  check('根节点上 ⊕ 可用', child && child.disabled === false);

  // 图标顺序必须是用户指定的 删除 → 加子节点 → 加同级
  // ⚠️ 2026-09-22 用户把小改动定了：三个图标从 emoji（🗑 / ⊕ / ⋮＋）换成**内联 SVG**，
  //    所以不能再按 textContent 判（emoji 版那条会红）—— 改判 **aria-label 顺序**
  //    + "每个按钮里真的有一个 <svg>" + "按钮是圆的"。
  const btns = bar ? $$('button', bar) : [];
  const labels = btns.map((b) => (b.getAttribute('aria-label') || '').trim());
  const expect = [
    '中心主题不能删（它是整棵树的根）',
    '加子节点',
    '中心主题没有同级节点',
  ];
  check('三图标顺序是 删除 / 加子节点 / 加同级', labels.join('|') === expect.join('|'), labels.join('|'));
  check(
    '三个图标都是内联 SVG（不再是 emoji 字符）',
    btns.length === 3 && btns.every((b) => !!b.querySelector('svg')),
    btns.map((b) => (b.querySelector('svg') ? 'svg' : '没有 svg：' + (b.textContent || '').trim())).join(' | '),
  );
  check(
    '三个按钮都是圆形（class 里有 rounded-full）',
    btns.length === 3 && btns.every((b) => b.className.indexOf('rounded-full') >= 0),
    btns.map((b) => b.className).join(' || '),
  );

  // 点空白取消选中 → 工具条收起
  pointerClick(cv, { clientX: cv.getBoundingClientRect().left + 12, clientY: cv.getBoundingClientRect().top + 12 });
  await sleep(250);
  check('点空白后工具条收起', !$('[data-tree-toolbar]'));

  return report();
})();
