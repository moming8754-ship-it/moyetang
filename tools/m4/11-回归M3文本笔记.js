// 11 · 回归 M3：树状图的改动不能碰坏文本笔记
//      （PRD 10.3 第 2、3、4 条）
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(500);

  // ── 建一篇新的文本笔记
  const newBtn = $$('button').find((b) => (b.innerText || '').indexOf('新建笔记') >= 0);
  pointerClick(newBtn);
  await sleep(250);
  const docOpt = $$('button').find((b) => (b.innerText || '').indexOf('📝 文本笔记') >= 0);
  check('下拉里还能选「📝 文本笔记」', !!docOpt);
  pointerClick(docOpt);
  await sleep(900);

  const titleInput = $('input[placeholder="笔记标题"]');
  check('文本笔记面板起来了（有标题框）', !!titleInput);
  setValue(titleInput, 'M4 回归文本笔记');
  // ⚠️ 文本笔记的标题框**没有 Enter 处理**（树状图那个有），只靠 900ms 防抖保存。
  // 所以必须主动 blur 再等够 —— 上一版只 sleep 800ms，笔记还没改名就去找它，
  // `doc` 是 undefined，后面直接 TypeError: reading 'id'。
  titleInput.blur();
  await sleep(1500);

  const doc = (await invoke('note_list', {})).find((n) => n.title === 'M4 回归文本笔记');
  check('文本笔记落盘了', !!doc && doc.kind === 'doc', doc && doc.kind);
  if (!doc) return report({ why: '文本笔记没建起来，后面的检查跳过' });

  // ── 编辑器起来了（CodeMirror 6）
  const cm = await waitFor(() => $('.cm-content'), 4000);
  check('CodeMirror 编辑器起来了', !!cm);

  // ── 辅助栏：点 ☐ 应该插入 -[]（M3-3 的按钮还在、还能用）
  const boxBtn = $$('button').find((b) => txt(b) === '☐');
  check('辅助栏里还有 ☐ 按钮', !!boxBtn, $$('button').map((b) => txt(b)).slice(0, 26).join('|'));
  if (cm && boxBtn) {
    cm.focus();
    await sleep(150);
    pointerClick(boxBtn);
    // ⚠️ 编辑器是**防抖 900ms 自动保存**的，必须等它落盘再断言，否则读到的是空正文
    await sleep(1700);
    const inserted = await invoke('note_get', { id: doc.id });
    check('点 ☐ 真的插进了 -[] 标记', (inserted.content || '').indexOf('-[]') >= 0, JSON.stringify(inserted.content));

    // 「-[] 后面必须有文字」是写进约定的硬规则（进度.md 四）：
    // 光一个 `-[]` 不算标记，执行区**不该**为它生成待办 —— 否则普通列表会莫名变待办。
    const bareTodos = (await invoke('todo_list', {})).filter(
      (t) => t.source && String(t.source.markerKey).indexOf(doc.id + '#') === 0,
    );
    check('光是 -[]（后面没文字）不算标记、不生成待办', bareTodos.length === 0,
      bareTodos.map((t) => t.title).join(' | '));
  } else {
    check('点 ☐ 真的插进了 -[] 标记', false, '没有编辑器或 ☐ 按钮');
  }

  // ── 通过命令写一条确定的标记（验"变勾选框 + 生成待办"这条完整闭环）
  //
  // ⚠️ 这一步踩过一个坑：上一版点完 ☐ 只等 600ms 就 invoke 改正文，
  // 那时编辑器**还脏着**（自动保存没落盘），于是它随后把自己那份旧正文 `-[]`
  // 写了回去，把我的 `-[]M4 回归待办` 盖掉了 —— 因为 `-[]` 后面没文字，
  // 不算合法标记，勾选框和待办全没了，后面 5 条检查跟着一起挂。
  // 这正是树状图**故意不走"整篇覆盖"**的那个覆盖竞态的现场演示。
  // 修法：等编辑器保存完、不脏了，再动正文。
  let note = await invoke('note_get', { id: doc.id });
  note = await invoke('note_save', {
    note: Object.assign({}, note, { content: '-[]M4 回归待办' }),
  });
  check('正文写进去了', note.content === '-[]M4 回归待办', note.content);

  // 逼面板重新挂载（正文是挂载时抄进 state 的，见 _helpers 里的说明）
  await refreshUi();
  await remountPane('M4 回归文本笔记');
  check('面板重挂载后编辑器读到了新正文',
    ($('.cm-content') && $('.cm-content').innerText.indexOf('M4 回归待办') >= 0) === true,
    $('.cm-content') && $('.cm-content').innerText.replace(/\s+/g, ' ').slice(0, 140));

  // ── 编辑器里那一行前面要有能点的勾选框（M3 的 widget）
  const widget = await waitFor(() => $('.cm-marker-box'), 4000);
  check('编辑器里 -[] 那行前面出现了勾选框', !!widget);
  check('勾选框是个真的 checkbox', widget && widget.type === 'checkbox', widget && widget.type);
  check('勾选框旁边还显示原始 -[] 文本（诚实显示 Markdown）',
    ($('.cm-content') && $('.cm-content').innerText.indexOf('-[]M4 回归待办') >= 0) === true,
    $('.cm-content') && $('.cm-content').innerText.replace(/\s+/g, ' ').slice(0, 140));

  // ── 执行区自动生成了待办
  const todos = await invoke('todo_list', {});
  const todo = todos.find((t) => (t.source && String(t.source.markerKey).indexOf(doc.id + '#') === 0));
  check('执行区自动生成了对应待办', !!todo, todos.map((t) => t.title).join(' | '));
  check('待办标题就是标记文字', todo && todo.title === 'M4 回归待办', todo && todo.title);
  check('待办来源指向这篇笔记', todo && todo.source.noteId === doc.id);
  check('待办用的是 markerKey 去重键', todo && todo.source.markerKey === doc.id + '#M4 回归待办',
    todo && todo.source.markerKey);

  // ── 勾上 → 状态记在待办上，正文一个字不改（M3-4 的核心约定）
  if (widget && todo) {
    widget.checked = true;
    widget.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);
    const done = (await invoke('todo_list', {})).find((t) => t.id === todo.id);
    check('勾上之后待办变成已完成', done && done.status === 'done', done && done.status);
    const text = await invoke('note_get', { id: doc.id });
    check('正文一个字没改（勾选状态不写回正文）',
      text.content === '-[]M4 回归待办', JSON.stringify(text.content));
  } else {
    check('勾上之后待办变成已完成', false, '没有待办或勾选框');
  }

  // ── 预览里联动信息还是"斜体 + 来源标记 + 可跳回"（M3-5）
  const info = await invoke('info_create', {
    text: 'M4 回归用的联动信息',
    kind: 'text',
    categories: [],
    assetPath: null,
  });
  await invoke('info_link_note', { infoId: info.id, noteId: doc.id, noteTitle: null, noteKind: null });
  await sleep(1000);
  await remountPane('M4 回归文本笔记');

  const previewBtn = $$('button').find((b) => txt(b) === '预览');
  check('还有「预览」切换', !!previewBtn);
  pointerClick(previewBtn);
  await sleep(700);

  const previewText = document.body.innerText;
  check('预览里有联动信息', previewText.indexOf('M4 回归用的联动信息') >= 0);
  check('预览里有〔联动信息〕来源标记', previewText.indexOf('〔联动信息〕') >= 0);
  // 斜体是用 CSS 类做的（`<p class="… italic …">`），不是 `<em>` 标签 ——
  // 所以查**计算样式**才靠谱，看标签名会误判。
  const block = $$('p').find((p) => (p.innerText || '').indexOf('M4 回归用的联动信息') >= 0);
  const style = block ? getComputedStyle(block) : null;
  check('联动信息是斜体（计算样式 font-style=italic）', !!style && style.fontStyle === 'italic',
    style && style.fontStyle + ' | ' + (block && String(block.className).slice(0, 80)));
  // 左边线画在**外层包裹**上（里层那个 <p> 只负责斜体），所以要往上找
  let borderHost = block;
  let borderWidth = 0;
  while (borderHost && borderHost !== document.body) {
    const width = parseFloat(getComputedStyle(borderHost).borderLeftWidth) || 0;
    if (width >= 2) {
      borderWidth = width;
      break;
    }
    borderHost = borderHost.parentElement;
  }
  check('联动信息有左边线（border-left）', borderWidth >= 2,
    borderWidth + 'px @ ' + (borderHost && String(borderHost.className).slice(0, 60)));
  const jump = $$('button').find((b) => txt(b).indexOf('去信息区') >= 0);
  check('有「去信息区 →」的跳转', !!jump, previewText.indexOf('去信息区') >= 0 ? '有文字' : '没找到');

  // ── 点「去信息区」能跳过去并高亮
  if (jump) {
    pointerClick(jump);
    await sleep(900);
    check('点「去信息区」跳到了信息区', $$('[id^="info-"]').length > 0);
    check('信息区里高亮了那条信息', !!$('[id^="info-"]'),
      (document.body.innerText.match(/M4 回归用的联动信息/g) || []).length + ' 处');
  } else {
    check('点「去信息区」跳到了信息区', false, '没有跳转按钮');
  }

  // ── 左栏列表还显示类型图标 + 标题 + 时间
  await nav('认知区');
  await sleep(700);
  const aside = txt(noteList());
  check('笔记列表还能看到两篇笔记的标题', aside.indexOf('M4 验收树') >= 0 && aside.indexOf('M4 回归文本笔记') >= 0, aside);
  check('列表里有类型图标（🌳 / 📝）', aside.indexOf('🌳') >= 0 && aside.indexOf('📝') >= 0);
  check('列表里有「N 节点」/「待办 N」这类摘要', /节点|待办/.test(aside), aside.split('\n').slice(0, 12).join(' / '));

  // ── 搜索能找到笔记（M3-1）
  const search = $('input[placeholder="搜索标题或正文…"]');
  check('搜索框还在', !!search);
  if (search) {
    setValue(search, 'M4 验收树');
    await sleep(400);
    const filtered = txt(noteList());
    check('搜索能按标题筛出笔记', filtered.indexOf('M4 验收树') >= 0, filtered);
    check('搜索把不匹配的筛掉了', filtered.indexOf('M4 回归文本笔记') < 0, filtered);
    setValue(search, '');
    await sleep(300);
  }

  return report({ docId: doc.id, todoId: todo && todo.id, infoId: info.id });
})();
