// 04 · 🗑 删除**整个分支**，而且必须二次确认（用户明确指定的交互）
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 5000);

  const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;

  // ── 先搭一枝出来：选中「第一枝」→ ⊕ → 加两个子节点
  let root = (await invoke('note_get', { id: noteId })).root;
  const first = root.children.find((c) => c.text === '第一枝');
  check('找到「第一枝」', !!first, root.children.map((c) => c.text).join(' | '));

  pointerClick(nodeById(first.id));
  await sleep(200);
  const childBtn = byTitle('加子节点');
  check('非根节点上的 ⊕ 可用', childBtn && !childBtn.disabled);
  pointerClick(childBtn);
  await sleep(700);

  let ta = $('[data-tree-canvas] textarea');
  if (ta) {
    setValue(ta, '要删的子节点');
    key(ta, 'Escape');
    await sleep(800);
  }

  root = (await invoke('note_get', { id: noteId })).root;
  const target = root.children.find((c) => c.text === '第一枝');
  check('「第一枝」下面有 1 个子节点了', target && target.children.length === 1, target && String(target.children.length));
  const totalBefore = countAll(root);

  // ── 选中「第一枝」，点 🗑
  pointerClick(nodeById(target.id));
  await sleep(250);
  const trash = byTitle('删除这个节点和它的整个分支');
  check('非根节点上 🗑 的说明是"删除这个节点和它的整个分支"', !!trash,
    $$('[title]').map((e) => e.getAttribute('title')).join(' | '));
  check('非根节点上 🗑 可用', trash && !trash.disabled);
  pointerClick(trash);

  // ── 必须弹二次确认，而且要说清"会连带删几个"
  const dlg = await waitFor(() => $('[role="dialog"]'), 3000);
  check('弹出二次确认框', !!dlg);
  const dlgText = txt(dlg);
  check('确认框里说了会连整个分支一起删', dlgText.indexOf('分支') >= 0, dlgText);
  check('确认框里给了会删几个节点', dlgText.indexOf('2') >= 0, dlgText);

  // 先点取消 → 一个节点都不能少
  const cancel = $$('button', dlg).find((b) => txt(b).indexOf('取消') >= 0);
  check('确认框有「取消」', !!cancel);
  pointerClick(cancel);
  await sleep(400);
  const afterCancel = (await invoke('note_get', { id: noteId })).root;
  check('取消后节点一个没少', countAll(afterCancel) === totalBefore, countAll(afterCancel) + ' vs ' + totalBefore);
  check('取消后弹窗关掉了', !$('[role="dialog"]'));

  // ── 再来一次，这次确认
  pointerClick(nodeById(target.id));
  await sleep(250);
  pointerClick(byTitle('删除这个节点和它的整个分支'));
  const dlg2 = await waitFor(() => $('[role="dialog"]'), 3000);
  check('第二次也弹确认框', !!dlg2);
  const confirmBtn = $$('button', dlg2).find((b) => txt(b) === '删除');
  check('确认框有「删除」按钮', !!confirmBtn);
  pointerClick(confirmBtn);

  await waitFor(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
    const now = (await invoke('note_get', { id: noteId })).root;
    return !now.children.some((c) => c.text === '第一枝');
  }, 4000);

  const after = (await invoke('note_get', { id: noteId })).root;
  check('「第一枝」没了', !after.children.some((c) => c.text === '第一枝'), after.children.map((c) => c.text).join(' | '));
  check('它的子节点跟着一起没了（整枝删除）', countAll(after) === totalBefore - 2, countAll(after) + ' vs ' + (totalBefore - 2));
  check('画布上也不见了', nodeTexts().indexOf('第一枝') < 0, nodeTexts().join(' | '));
  check('剩下的节点没被误伤', after.children.length >= 1, after.children.map((c) => c.text).join(' | '));

  // ── 根节点上的 🗑 点了不该删（后端也拦一道）
  pointerClick($('[data-node-id]'));
  await sleep(250);
  const rootTrash = byTitle('中心主题不能删（它是整棵树的根）');
  check('根节点的 🗑 置灰', rootTrash && rootTrash.disabled === true);

  // 绕过界面直接调命令，后端也必须拒绝
  let rejected = false;
  try {
    await invoke('note_tree_remove', { noteId, nodeId: after.id });
  } catch (e) {
    rejected = String(e).indexOf('不能删') >= 0;
  }
  check('后端也拦住了删根节点（不只靠前端置灰）', rejected);
  const stillThere = (await invoke('note_get', { id: noteId })).root;
  check('根节点还在', !!stillThere && stillThere.id === after.id);

  return report({ after: countAll(stillThere) });
})();
