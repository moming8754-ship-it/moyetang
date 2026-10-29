// 07 · 拖拽调整层级 / 顺序（M4-5），含防环
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 5000);

  const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;

  // ── 用命令铺一个干净的结构：中心主题 → [甲, 乙]（撤销上几步留下的乱七八糟）
  let root = (await invoke('note_get', { id: noteId })).root;
  for (const child of root.children) {
    await invoke('note_tree_remove', { noteId, nodeId: child.id });
  }
  const jia = (await invoke('note_tree_add_child', { noteId, parentId: root.id, text: '甲' })).focusNodeId;
  const yi = (await invoke('note_tree_add_child', { noteId, parentId: root.id, text: '乙' })).focusNodeId;
  const jiaChild = (await invoke('note_tree_add_child', { noteId, parentId: jia, text: '甲的孩子' })).focusNodeId;
  await refreshUi(noteId);

  root = (await invoke('note_get', { id: noteId })).root;
  check('铺好了结构：中心主题 → [甲(甲的孩子), 乙]', root.children.length === 2, root.children.map((c) => c.text).join(' | '));
  check('画布上四个节点都在', $$('[data-node-id]').length === 4, nodeTexts().join(' | '));

  /** 拖一次：从 from 节点拖到 to 节点的相对高度 ratio 处 */
  async function drag(fromId, toId, ratio) {
    const from = nodeById(fromId);
    const to = nodeById(toId);
    if (!from || !to) return { ok: false, why: '找不到节点 ' + fromId + '/' + toId };
    const fr = from.getBoundingClientRect();
    const tr = to.getBoundingClientRect();
    const tx = tr.left + tr.width / 2;
    const ty = tr.top + tr.height * ratio;
    pev('pointerdown', from, { clientX: fr.left + fr.width / 2, clientY: fr.top + fr.height / 2 });
    await sleep(60);
    pev('pointermove', canvas(), { clientX: fr.left + fr.width / 2 + 30, clientY: fr.top + fr.height / 2 + 10 });
    await sleep(60);
    pev('pointermove', canvas(), { clientX: tx, clientY: ty });
    await sleep(120);
    const hint = txt($$('div').find((d) => d.className && String(d.className).indexOf('z-10') >= 0) || null);
    pev('pointermove', canvas(), { clientX: tx, clientY: ty });
    await sleep(120);
    pev('pointerup', canvas(), { clientX: tx, clientY: ty });
    await sleep(900);
    return { ok: true, hint };
  }

  // ── 拖到节点中间 = 变成它的子节点
  let res = await drag(yi, jia, 0.5);
  check('拖拽手势发出去了', res.ok, res.why);
  let after = (await invoke('note_get', { id: noteId })).root;
  const jiaNode = after.children.find((c) => c.id === jia);
  check('「乙」拖到「甲」中间 → 成了甲的子节点',
    jiaNode && jiaNode.children.some((c) => c.id === yi),
    jiaNode && jiaNode.children.map((c) => c.text).join(' | '));
  check('拖拽后节点总数不变（只换位置不丢节点）', countAll(after) === 4, String(countAll(after)));
  check('中心主题下只剩「甲」', after.children.length === 1, after.children.map((c) => c.text).join(' | '));
  // 「乙」现在该画在「甲」右边一层（子节点就是往右长）
  const rectJia = nodeById(jia).getBoundingClientRect();
  const rectYi = nodeById(yi).getBoundingClientRect();
  check('画布上「乙」跑到「甲」右边一层去了', rectYi.left > rectJia.left + 40,
    'jia.left=' + Math.round(rectJia.left) + ' yi.left=' + Math.round(rectYi.left));
  check('画布上四个节点还在', $$('[data-node-id]').length === 4, nodeTexts().join(' | '));

  // ── 拖到节点上沿 = 插到它前面（同级）
  res = await drag(yi, jiaChild, 0.1);
  after = (await invoke('note_get', { id: noteId })).root;
  const jia2 = after.children.find((c) => c.id === jia);
  check('「乙」拖到「甲的孩子」上沿 → 变成甲的同级（插在它孩子前面）',
    jia2 && jia2.children.length === 2 && jia2.children[0].id === yi,
    jia2 && jia2.children.map((c) => c.text).join(' | '));
  check('还是四个节点', countAll(after) === 4, String(countAll(after)));

  // ── 拖到节点下沿 = 插到它后面
  res = await drag(yi, jiaChild, 0.9);
  after = (await invoke('note_get', { id: noteId })).root;
  const jia3 = after.children.find((c) => c.id === jia);
  check('「乙」拖到上沿改成下沿 → 插到孩子后面',
    jia3 && jia3.children.length === 2 && jia3.children[1].id === yi,
    jia3 && jia3.children.map((c) => c.text).join(' | '));

  // ── 防环：把「甲」拖到自己的后代「甲的孩子」上 → 必须拒绝
  const beforeCycle = JSON.stringify((await invoke('note_get', { id: noteId })).root);
  res = await drag(jia, jiaChild, 0.5);
  check('拖到自己后代的浮标里给出了理由', (res.hint || '').indexOf('自己的分支') >= 0, res.hint);
  const afterCycle = (await invoke('note_get', { id: noteId })).root;
  check('防环：树结构一个字没变', JSON.stringify(afterCycle) === beforeCycle, '结构被改了');
  check('防环：节点一个没少', countAll(afterCycle) === 4, String(countAll(afterCycle)));

  // ── 后端也拦一道（不只靠前端预检）
  let rejected = false;
  try {
    await invoke('note_tree_move', { noteId, nodeId: jia, targetId: jiaChild, position: 'child' });
  } catch (e) {
    rejected = String(e).indexOf('自己的分支') >= 0;
  }
  check('后端也拒绝了环（前端漏了也不会丢枝）', rejected);
  check('拒绝之后还是四个节点', countAll((await invoke('note_get', { id: noteId })).root) === 4);

  // ── 根节点不能挪走
  let rootRejected = false;
  try {
    await invoke('note_tree_move', { noteId, nodeId: afterCycle.id, targetId: jia, position: 'child' });
  } catch (e) {
    rootRejected = String(e).indexOf('不能挪走') >= 0;
  }
  check('后端拦住了"把中心主题挪走"', rootRejected);

  return report({ tree: nodeTexts() });
})();
