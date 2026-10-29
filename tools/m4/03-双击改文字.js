// 03 · 双击改节点文字（M4-3），并且真的落盘
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 5000);

  const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;
  const root = (await invoke('note_get', { id: noteId })).root;
  const first = root.children.find((c) => c.text === '第一枝') || root.children[0];
  check('找到要改的节点「第一枝」', !!first, root.children.map((c) => c.text).join(' | '));

  // ── 双击 → 进入编辑
  dblClick(nodeById(first.id));
  const ta = await waitFor(() => $('[data-tree-canvas] textarea'), 3000);
  check('双击后出现节点输入框', !!ta);
  check('输入框里装的是原文字', ta && ta.value === first.text, ta && ta.value);

  // ── 改文字 + Esc 提交
  setValue(ta, '第一枝（改过）');
  key(ta, 'Escape');
  await sleep(900);

  const after = (await invoke('note_get', { id: noteId })).root;
  const renamed = after.children.find((c) => c.id === first.id);
  check('文字改到盘上了', renamed && renamed.text === '第一枝（改过）', renamed && renamed.text);
  check('改文字没有多出节点', after.children.length === root.children.length, String(after.children.length));
  check('画布上显示的是新文字', nodeTexts().indexOf('第一枝（改过）') >= 0, nodeTexts().join(' | '));

  // ── 再双击 → 改回去。这里验**编辑态防抖自动保存**：
  //    打完字什么都不按，歇一会儿也该自己存住（不依赖失焦）。
  //    ⚠️ 上一版靠 `ta2.blur()` 提交，结果没存上 —— WebView 里程序化 blur()
  //    不一定触发 React 的 onBlur，这正是被脚本逮到的那条真 bug。
  dblClick(nodeById(first.id));
  const ta2 = await waitFor(() => $('[data-tree-canvas] textarea'), 3000);
  check('第二次双击也能进编辑', !!ta2);
  setValue(ta2, '第一枝');
  await sleep(1800);
  const autoSaved = (await invoke('note_get', { id: noteId })).root;
  check(
    '光打字不按任何键，歇一下也会自动存住（防抖兜底）',
    autoSaved.children.some((c) => c.id === first.id && c.text === '第一枝'),
    autoSaved.children.map((c) => c.text).join(' | '),
  );
  check('自动保存不会把编辑框关掉（还停在编辑态）', !!$('[data-tree-canvas] textarea'));

  // ── Esc 提交并退出编辑
  const ta2b = $('[data-tree-canvas] textarea');
  if (ta2b) {
    key(ta2b, 'Escape');
    await sleep(800);
    check('Esc 之后编辑框收起了', !$('[data-tree-canvas] textarea'));
  } else {
    check('Esc 之后编辑框收起了', false, '已经没有编辑框了');
  }

  const back = (await invoke('note_get', { id: noteId })).root;
  check(
    '文字是「第一枝」',
    back.children.some((c) => c.text === '第一枝'),
    back.children.map((c) => c.text).join(' | '),
  );

  // ── 空文字允许（界面显示占位，不崩）
  dblClick(nodeById(first.id));
  const ta3 = await waitFor(() => $('[data-tree-canvas] textarea'), 3000);
  if (ta3) {
    setValue(ta3, '');
    key(ta3, 'Escape');
    await sleep(900);
    const empty = (await invoke('note_get', { id: noteId })).root;
    const target = empty.children.find((c) => c.id === first.id);
    check('允许清空文字（不崩、不丢节点）', target && target.text === '', target && JSON.stringify(target.text));
    const card = nodeById(first.id);
    check('空节点在画布上显示占位而不是空白一片', card && (card.innerText || '').indexOf('空节点') >= 0, card && card.innerText);

    // 改回来，别把空节点留给后面的步骤
    dblClick(nodeById(first.id));
    const ta4 = await waitFor(() => $('[data-tree-canvas] textarea'), 3000);
    if (ta4) {
      setValue(ta4, '第一枝');
      key(ta4, 'Escape');
      await sleep(800);
    }
  } else {
    check('允许清空文字（不崩、不丢节点）', false, '没进编辑态');
  }

  return report();
})();
