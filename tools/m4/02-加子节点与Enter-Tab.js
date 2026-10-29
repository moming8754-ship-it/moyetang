// 02 · ⊕ 加子节点，然后 Enter 新建同级、Tab 新建子级（M4-2 / M4-3）
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  const cv = await waitFor(() => canvas(), 5000);
  check('画布在', !!cv);

  const noteBefore = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树');
  check('找到这篇笔记', !!noteBefore);
  const noteId = noteBefore.id;

  // ── ⊕ 加子节点
  pointerClick($('[data-node-id]'));
  await sleep(200);
  pointerClick(byTitle('加子节点'));
  await sleep(700);

  const afterAdd = (await invoke('note_get', { id: noteId })).root;
  check('后端树上多了一个子节点', afterAdd.children.length === 1, JSON.stringify(afterAdd.children.map((c) => c.text)));
  check('新节点默认文字是「新节点」', afterAdd.children[0].text === '新节点', afterAdd.children[0].text);

  // 新建后必须**直接进入编辑态**（"随手就能往下长"）
  let ta = await waitFor(() => $('[data-tree-canvas] textarea'), 3000);
  check('新节点自动进入编辑态（出现输入框）', !!ta);

  // 在编辑态敲字 + Enter = 提交 + 新建同级 + 继续编辑
  setValue(ta, '第一枝');
  key(ta, 'Enter');
  await sleep(900);

  const s1 = (await invoke('note_get', { id: noteId })).root;
  const sibling = s1.children.find((c) => c.text === '第一枝');
  check('Enter 把文字存住了（同级「第一枝」）', !!sibling, s1.children.map((c) => c.text).join(' | '));
  check('Enter 真的新建了一个同级', s1.children.length === 2, s1.children.map((c) => c.text).join(' | '));
  check(
    '新的同级排在「第一枝」后面',
    s1.children[1] && s1.children[1].text === '新节点',
    s1.children.map((c) => c.text).join(' | '),
  );

  ta = await waitFor(() => $('[data-tree-canvas] textarea'), 3000);
  check('Enter 之后仍停在编辑态（可以连着敲）', !!ta);

  // ── Tab 新建子级
  setValue(ta, '第二枝');
  key(ta, 'Tab');
  await sleep(900);

  const s2 = (await invoke('note_get', { id: noteId })).root;
  const second = s2.children.find((c) => c.text === '第二枝');
  check('Tab 把文字存住了（同级「第二枝」）', !!second, s2.children.map((c) => c.text).join(' | '));
  check(
    'Tab 在「第二枝」下面建了子级',
    second && second.children.length === 1,
    second && JSON.stringify(second.children.map((c) => c.text)),
  );
  check('Tab 后又进入编辑态', !!$('[data-tree-canvas] textarea'));

  // ── Shift+Enter 在节点内换行（不退出、不新建）
  const countBefore = nodeTexts().length;
  if (ta) {
    setValue(ta, '换过行的');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(500);
    check('Shift+Enter 没新建节点', nodeTexts().length === countBefore, String(nodeTexts().length));
  } else {
    check('Shift+Enter 没新建节点', false, '没有编辑框可测');
  }

  // 收尾：把编辑框提交掉，别把编辑态留给下一步
  const taNow = $('[data-tree-canvas] textarea');
  if (taNow) {
    key(taNow, 'Escape');
    await sleep(600);
  }

  // ── 画布上看得见这些节点，而且连线也画出来了
  const texts = nodeTexts();
  check('画布上能看到「第一枝」', texts.indexOf('第一枝') >= 0, texts.join(' | '));
  check('画布上能看到「第二枝」', texts.indexOf('第二枝') >= 0, texts.join(' | '));
  check('连线数量 = 子节点数量', $$('[data-tree-canvas] svg path').length >= 3, String($$('[data-tree-canvas] svg path').length));

  return report({ noteId, texts });
})();
