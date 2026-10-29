// 05 · 折叠 / 展开（M4-5）；顺带验键盘 ←/→ 也能收起展开
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 5000);

  const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;

  // 先保证「第二枝」下面有子节点（上一步留下的结构可能已经被删改了）
  let root = (await invoke('note_get', { id: noteId })).root;
  let branch = root.children.find((c) => c.text === '第二枝') || root.children.find((c) => c.children.length > 0);
  if (!branch) {
    branch = root.children[0];
  }
  check('找到一个用来折叠的分支', !!branch, root.children.map((c) => c.text).join(' | '));

  if (branch.children.length === 0) {
    pointerClick(nodeById(branch.id));
    await sleep(200);
    pointerClick(byTitle('加子节点'));
    await sleep(700);
    const ta = $('[data-tree-canvas] textarea');
    if (ta) {
      setValue(ta, '折起来看');
      key(ta, 'Escape');
      await sleep(800);
    }
  }

  root = (await invoke('note_get', { id: noteId })).root;
  const target = root.children.find((c) => c.id === branch.id);
  check('分支下面有子节点了', target && target.children.length > 0, target && String(target.children.length));
  const hidden = countAll(target) - 1;
  const visibleBefore = $$('[data-node-id]').length;

  // ── 折叠小圆点必须出现（在折叠之前，它是"−"）
  const badge = await waitFor(() => $('[data-fold-badge="' + target.id + '"]'), 3000);
  check('有子节点的卡片上有折叠小圆点', !!badge, badge && txt(badge));

  // ── 点它 → 收起来
  pointerClick(badge);
  await sleep(800);

  const collapsedBadge = $('[data-fold-badge="' + target.id + '"]');
  check('折叠后小圆点显示藏了几个（+N）', collapsedBadge && txt(collapsedBadge) === '+' + hidden, collapsedBadge && txt(collapsedBadge));
  const visibleAfter = $$('[data-node-id]').length;
  check('折叠后画布上少了一批节点', visibleAfter === visibleBefore - hidden, visibleAfter + ' vs ' + (visibleBefore - hidden));
  check('折起来的分支文字还在（父节点没跟着消失）', !!nodeById(target.id));
  check('折起来的子节点确实不在画布上', !nodeById(target.children[0].id));

  const stored = (await invoke('note_get', { id: noteId })).root;
  check('折叠状态落到盘上了', stored.children.find((c) => c.id === target.id).collapsed === true);
  check('折叠不删数据（子节点还在文件里）', stored.children.find((c) => c.id === target.id).children.length === target.children.length);

  // ── 再点 → 展开，节点必须一个不少地回来
  pointerClick($('[data-fold-badge="' + target.id + '"]'));
  await sleep(800);
  check('展开后节点数量恢复', $$('[data-node-id]').length === visibleBefore, String($$('[data-node-id]').length));
  check('展开后小圆点变回「−」', txt($('[data-fold-badge="' + target.id + '"]')) === '−');
  const reopened = (await invoke('note_get', { id: noteId })).root;
  check('展开状态也落盘', reopened.children.find((c) => c.id === target.id).collapsed === false);

  // ── 键盘：← 收起、→ 展开
  pointerClick(nodeById(target.id));
  await sleep(200);
  const cv = canvas();
  key(cv, 'ArrowLeft');
  await sleep(700);
  check('按 ← 收起了这一枝', $$('[data-node-id]').length === visibleBefore - hidden, String($$('[data-node-id]').length));
  key(cv, 'ArrowRight');
  await sleep(700);
  check('按 → 又展开了', $$('[data-node-id]').length === visibleBefore, String($$('[data-node-id]').length));

  return report({ visible: visibleBefore, hidden });
})();
