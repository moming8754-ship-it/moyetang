// 09 · 联动信息进树状图 → 生成节点 + 来源标记（M4-6）
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 5000);

  const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;
  const before = countAll((await invoke('note_get', { id: noteId })).root);

  // ── 造一条信息，联动进这篇树状图
  const info = await invoke('info_create', {
    text: 'M4 联动进树的想法',
    kind: 'text',
    categories: ['主动冒出·突然想起'],
    assetPath: null,
  });
  check('信息建好了', !!info && !!info.id);

  const linked = await invoke('info_link_note', {
    infoId: info.id,
    noteId,
    noteTitle: null,
    noteKind: null,
  });
  check('联动到了这篇树状图', linked && linked.noteId === noteId, linked && linked.noteTitle + '/' + linked.noteKind);
  await sleep(900);

  // ── 后端：多了一个节点，而且节点记住了来源
  const root = (await invoke('note_get', { id: noteId })).root;
  const node = root.children.find((c) => c.text === 'M4 联动进树的想法');
  check('联动生成了一个节点', !!node, root.children.map((c) => c.text).join(' | '));
  check('节点总数 +1', countAll(root) === before + 1, countAll(root) + ' vs ' + (before + 1));
  check('节点带上了来源 id（M4 新加的字段）', node && node.sourceInfoId === info.id, node && String(node.sourceInfoId));
  check('笔记的 sourceInfoIds 也记了', true);

  const noteNow = await invoke('note_get', { id: noteId });
  check('笔记 sourceInfoIds 里有这条信息', noteNow.sourceInfoIds.indexOf(info.id) >= 0, JSON.stringify(noteNow.sourceInfoIds));

  // ── 画布：卡片上要有〔联动信息〕来源标记，而且能点
  const card = await waitFor(() => nodeById(node.id), 4000);
  check('画布上出现了这个节点', !!card);
  const badge = card && $$('button', card).find((b) => txt(b).indexOf('联动信息') >= 0);
  check('卡片上有〔联动信息〕来源标记', !!badge, card && card.innerText);
  check('带来源的卡片有左边线（和文本笔记的引用块一套视觉语言）',
    card && String(card.className).indexOf('border-l-indigo') >= 0, card && String(card.className).slice(0, 160));

  // 手建的节点不该有来源标记
  const handMade = $$('[data-node-id]').find((el) => el !== card && !el.querySelector('button'));
  check('手建的节点没有〔联动信息〕标记', !!handMade && (handMade.innerText || '').indexOf('联动信息') < 0, handMade && handMade.innerText);

  // ── 点来源标记 → 跳回信息区
  pointerClick(badge);
  await sleep(800);
  const pageText = document.body.innerText;
  check('点来源标记跳到了信息区', pageText.indexOf('信息区') >= 0 && $$('[id^="info-"]').length > 0, pageText.split('\n').slice(0, 6).join(' / '));
  check('信息区里能看到那条信息', pageText.indexOf('M4 联动进树的想法') >= 0);
  check('信息上显示「已联动 → 认知区《M4 验收树》」', pageText.indexOf('认知区《M4 验收树》') >= 0,
    (pageText.match(/已联动[^\n]*/g) || []).slice(0, 3).join(' ~ '));

  // ── 原信息必须保留（PRD：原信息仍在）
  const infos = await invoke('info_list', {});
  const back = infos.find((i) => i.id === info.id);
  check('原信息还在（联动不吞掉来源）', !!back);
  check('原信息被标成已联动', back && back.status === 'linked', back && back.status);
  check('原信息记了指向笔记的去向',
    back && back.links.some((l) => l.targetKind === 'note' && l.targetId === noteId),
    back && JSON.stringify(back.links));

  // ── 幂等：同一条信息再联动一次不该多出一个节点
  const dup = await invoke('info_link_note', { infoId: info.id, noteId, noteTitle: null, noteKind: null });
  await sleep(700);
  const afterDup = (await invoke('note_get', { id: noteId })).root;
  check('重复联动同一条信息不会多出节点', countAll(afterDup) === before + 1, countAll(afterDup) + ' vs ' + (before + 1));
  check('重复联动也没多记 sourceInfoIds',
    (await invoke('note_get', { id: noteId })).sourceInfoIds.filter((x) => x === info.id).length === 1);

  // ── 联动进来的节点是个"普通节点"：能改字、能加子节点
  await nav('认知区');
  await sleep(600);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 4000);
  await refreshUi(noteId);
  const card2 = await waitFor(() => nodeById(node.id), 4000);
  check('回到认知区还能看到联动节点', !!card2);
  if (card2) {
    pointerClick(card2);
    await sleep(250);
    const childBtn = byTitle('加子节点');
    check('联动节点上也能 ⊕ 加子节点', childBtn && !childBtn.disabled);
    pointerClick(childBtn);
    await sleep(800);
    const stored = (await invoke('note_get', { id: noteId })).root;
    const linked2 = stored.children.find((c) => c.id === node.id);
    check('联动节点长出了子节点（它就是个普通节点）', linked2 && linked2.children.length === 1,
      linked2 && JSON.stringify(linked2.children.map((c) => c.text)));
    check('加子节点不会把来源标记弄丢', linked2 && linked2.sourceInfoId === info.id);
  }

  return report({ infoId: info.id, nodeId: node.id });
})();
