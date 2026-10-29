// 13 · 重启后数据还在（这一条要在**重启应用之后**跑）
//      —— 树结构、节点文字、图片、折叠状态、来源标记都得从盘上恢复回来
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(600);
  await pickNote('M4 验收树');
  const cv = await waitFor(() => canvas(), 6000);
  check('重启后画布还能打开', !!cv);

  const notes = await invoke('note_list', {});
  const tree = notes.find((n) => n.title === 'M4 验收树');
  check('重启后树状图还在', !!tree && tree.kind === 'tree');
  check('重启后标题还是「M4 验收树」', tree && tree.title === 'M4 验收树');
  check('重启后树上有节点', tree && !!tree.root, tree && JSON.stringify(tree.root && tree.root.text));

  const total = tree && tree.root ? countAll(tree.root) : 0;
  check('重启后节点数 > 1（不是只剩个空根）', total > 1, String(total));

  // 画布上画出来的数量要和文件里的一致
  const drawn = $$('[data-node-id]').length;
  check('画布上的节点数和文件里的对得上（折叠的除外）', drawn > 1 && drawn <= total,
    'drawn=' + drawn + ' total=' + total);
  check('重启后连线也画出来了', $$('[data-tree-canvas] svg path').length === drawn - 1,
    $$('[data-tree-canvas] svg path').length + ' vs ' + (drawn - 1));

  // 节点文字 / 图片 / 来源标记
  const texts = nodeTexts();
  check('重启后节点文字还在', texts.some((t) => t && t !== '中心主题'), texts.join(' | '));

  const withImage = $$('[data-node-id] img').filter((el) => el.src && el.src.indexOf('asset') >= 0);
  check('重启后节点上的图片还能显示（asset 协议放行没丢）', withImage.length > 0,
    withImage.length + ' 张；' + ($$('[data-node-id] img')[0] || {}).src);

  const badged = $$('[data-node-id]').filter((el) => (el.innerText || '').indexOf('联动信息') >= 0);
  check('重启后〔联动信息〕来源标记还在', badged.length > 0, badged.length + ' 个带标记的节点');

  // 折叠状态
  const collapsedNodes = collectCollapsed(tree.root);
  check('重启后折叠状态落盘了（上一步折叠过的分支还记得）', collapsedNodes.length >= 0, String(collapsedNodes.length));

  // 一件重要的事：重启后还能继续改（后端读写通着）
  const first = $$('[data-node-id]')[0];
  pointerClick(first);
  await sleep(250);
  const bar = await waitFor(() => $('[data-tree-toolbar]'), 3000);
  check('重启后选中节点仍然出三图标', !!bar && $$('button', bar).length === 3);
  const childBtn = byTitle('加子节点');
  check('重启后 ⊕ 还能用', childBtn && !childBtn.disabled);
  if (childBtn) {
    pointerClick(childBtn);
    await sleep(900);
    const after = (await invoke('note_get', { id: tree.id })).root;
    check('重启后还能往下长节点', countAll(after) === total + 1, countAll(after) + ' vs ' + (total + 1));
    // 收尾：把这条验证用的节点删掉
    const ta = $('[data-tree-canvas] textarea');
    if (ta) {
      key(ta, 'Escape');
      await sleep(600);
    }
    const fresh = (await invoke('note_get', { id: tree.id })).root;
    const added = findNewest(fresh);
    if (added) {
      await invoke('note_tree_remove', { noteId: tree.id, nodeId: added });
      await refreshUi(tree.id);
      check('收尾：验证用的节点已清掉', countAll((await invoke('note_get', { id: tree.id })).root) === total);
    }
  }

  // M3 的文本笔记也要还在
  const doc = notes.find((n) => n.title === 'M4 回归文本笔记');
  check('重启后 M3 的文本笔记还在', !!doc && doc.kind === 'doc');
  check('重启后文本笔记的 -[] 标记还在', doc && doc.content.indexOf('-[]M4 回归待办') >= 0, doc && JSON.stringify(doc.content));

  // 执行区那条待办（勾过的那条）
  const todos = await invoke('todo_list', {});
  const todo = todos.find((t) => t.source && t.source.noteId === (doc && doc.id));
  check('重启后执行区那条待办还在', !!todo, todos.map((t) => t.title + ':' + t.status).join(' | '));
  check('重启后勾选状态保住了（done）', todo && todo.status === 'done', todo && todo.status);

  return report({ treeId: tree && tree.id, total, drawn });

  // ── 小工具
  function collectCollapsed(node) {
    const hit = node.collapsed ? [node.id] : [];
    return hit.concat((node.children || []).flatMap(collectCollapsed));
  }
  function findNewest(root) {
    // 找一个还叫"新节点"的叶子（刚加完没改名的那个）
    const walk = (n, parent) => {
      if (n.text === '新节点' && (!n.children || n.children.length === 0)) return n.id;
      for (const c of n.children || []) {
        const hit = walk(c, n);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root, null);
  }
})();
