// 14 · M4.2：节点宽度不再分三档，长文字**一个字都不许截断**
//
// 为什么值得单独一条步骤：三档宽度（132 / 180 / 224）+ `line-clamp-3` 会把长文字裁掉，
// 而这是**纯视觉**的问题 —— 前面十几步的断言（节点在不在、文字落没落盘）全绿，
// 文字照样被裁。所以这里直接量 DOM：文字的 `scrollHeight` 有没有超出它自己的可视高度。
//
// ⚠️ 尺寸断言一律用 `offsetWidth/Height`、`scrollHeight/clientHeight`：
// 卡片外面套着 `transform: scale(k)` 的缩放层，`getBoundingClientRect()` 给的是
// **屏幕像素**（被 zoom 缩过），拿它跟 132/180/224 比会得到一堆假结论。
// 只有"两张卡片有没有重叠"才该用 `getBoundingClientRect()`（那才是视觉问题）。
(async () => {
  await ready();
  await nav('认知区');
  await sleep(400);

  const title = 'M4 长文字验证树';
  // 用自己那篇专用笔记，别动 M4 验收树（00~13 步都在用它）
  const stale = (await invoke('note_list', {})).find((n) => n.title === title);
  if (stale) await invoke('note_delete', { id: stale.id });

  const note = await invoke('note_create', { title, kind: 'tree' });
  check('建出了验证用的树状图', !!(note && note.id && note.root), note && note.title);
  const rootId = note.root.id;

  // ── A. 各种"会撑破卡片"的极端文字
  const CASES = [
    { label: '中·一句', text: '这是一段很长的中文节点文字用来验证树状图的节点不会再被截断掉任何一个字' },
    { label: '中·超长', text: '甲'.repeat(120) },
    { label: '英·超长单词', text: 'SupercalifragilisticexpialidociousAndThenSomeMoreLettersToForceWrapping' },
    { label: '英·句子', text: 'the quick brown fox jumps over the lazy dog and keeps on running for quite a while' },
    { label: 'W·全最宽', text: 'W'.repeat(44) },
    { label: '多行', text: '第一行：短\n第二行：这一行明显比第一行长很多很多很多很多很多\n第三行：短' },
    { label: '短', text: '短' },
    { label: '空', text: '' },
  ];

  // ── B. 纯中文递增序列：宽度必须**随字数连续增长**（这是"不再分三档"的正面证据）
  //    宽度公式 = min(360, max(132, 26 + 字数×13 + 2))，26 = px-3×2 + 左右描边，2 = 余量
  const PROBE_LEN = [1, 3, 8, 9, 12, 16, 20, 25, 26, 30];
  const PROBES = PROBE_LEN.map((n) => ({ n, text: '甲'.repeat(n) }));

  for (const one of CASES) {
    await invoke('note_tree_add_child', { noteId: note.id, parentId: rootId, text: one.text });
  }
  for (const one of PROBES) {
    await invoke('note_tree_add_child', { noteId: note.id, parentId: rootId, text: one.text });
  }

  // ── C. 联动信息节点：它比普通节点多一个〔联动信息〕小标签，
  //    而旧的高度公式**根本没算这个标签**（标签 16 + 间距 6 = 22px），
  //    联动节点的文字会被挤到卡片外面 —— 顺带一起验（同一轮修掉的隐 bug）。
  const info = await invoke('info_create', {
    text: 'M4 长文字联动信息：拿来验来源标签占位高度算得对不对，文字故意写长一点才好看出差别。',
    kind: 'text',
    categories: [],
    assetPath: null,
  });
  await invoke('info_link_note', { infoId: info.id, noteId: note.id });

  await refreshUi(note.id);

  const saved = await invoke('note_get', { id: note.id });
  const idOf = new Map();
  const walk = (node) => {
    idOf.set(node.text, node.id);
    (node.children || []).forEach(walk);
  };
  walk(saved.root);
  check(
    '案例节点都落盘了',
    CASES.every((one) => idOf.has(one.text)),
    '落盘 ' + idOf.size + ' 个节点',
  );
  const linkedNode = (saved.root.children || []).find((c) => c.sourceInfoId);
  check('联动来的节点带 sourceInfoId', !!linkedNode, linkedNode && linkedNode.text);

  // ── 回到界面，量真实的 DOM
  await nav('认知区');
  await sleep(300);
  await pickNote(title);
  const cv = await waitFor(() => canvas(), 6000);
  check('画布起来了', !!cv);

  const expected = CASES.length + PROBES.length + 2; // 8 + 10 + 联动节点 + 根
  await waitFor(() => ($$('[data-node-id]').length >= expected ? true : null), 8000);
  const cards = $$('[data-node-id]');
  check(
    '所有节点都渲染出来了',
    cards.length === expected,
    cards.length + '/' + expected,
  );

  /** 卡片里那个真正装文字的元素 */
  const textSpan = (card) =>
    Array.from(card.children).find(
      (c) => String(c.className || '').indexOf('whitespace-pre-wrap') >= 0,
    ) || null;

  // ── A. 逐个查：不裁、不溢出、原文完整
  let clipped = 0;
  for (const one of CASES) {
    const id = idOf.get(one.text);
    const card = id ? nodeById(id) : null;
    if (!card) {
      check('【' + one.label + '】节点在画布上', false, '找不到 data-node-id=' + id);
      clipped += 1;
      continue;
    }
    const span = textSpan(card);
    if (!span) {
      check('【' + one.label + '】找得到文字元素', false, card.innerHTML.slice(0, 120));
      clipped += 1;
      continue;
    }

    const cs = getComputedStyle(span);
    const boxH = span.clientHeight;
    const contentH = span.scrollHeight;

    // ① 纵向：内容高度不能超出可视高度
    //    —— 原来的 `line-clamp-3` 裁字、以及"高度不够被 flex 压扁后文字溢出"，
    //       两种都会被这一条逮到
    const vOk = contentH <= boxH + 1;
    if (!vOk) clipped += 1;
    check(
      '【' + one.label + '】文字没有被裁/没有压出卡片',
      vOk,
      '内容高 ' + contentH + 'px，可视只有 ' + boxH + 'px（差 ' + (contentH - boxH) + 'px）',
    );

    // ② 横向：最宽的那一行也不能被裁
    check(
      '【' + one.label + '】最宽那行也没被裁',
      span.scrollWidth <= span.clientWidth + 1,
      '内容宽 ' + span.scrollWidth + '，可视宽 ' + span.clientWidth,
    );

    // ③ 根本没上 clamp / overflow:hidden（这是当初截断的元凶，别再被谁加回来）
    check(
      '【' + one.label + '】没有 line-clamp',
      cs.webkitLineClamp === 'none' || cs.webkitLineClamp === '' || cs.webkitLineClamp == null,
      'line-clamp=' + cs.webkitLineClamp,
    );
    check(
      '【' + one.label + '】没有 overflow:hidden 裁字',
      cs.overflowY !== 'hidden',
      'overflowY=' + cs.overflowY,
    );

    // ④ 渲染出来的就是原文（JS 侧一个字符都没漏）
    const needle = one.text.trim() ? one.text : '空节点';
    check(
      '【' + one.label + '】渲染的是完整原文',
      (card.textContent || '').indexOf(needle) >= 0,
      '卡片 textContent = ' + JSON.stringify((card.textContent || '').slice(0, 60)),
    );
  }
  check('逐个检查下来，没有任何节点被裁', clipped === 0, clipped + ' 个节点有问题');

  // ── C. 联动节点：来源标签的高度必须算进去
  if (linkedNode) {
    const card = nodeById(linkedNode.id);
    const span = card && textSpan(card);
    check(
      '【联动节点】来源标签 + 文字都装得下',
      !!span && span.scrollHeight <= span.clientHeight + 1,
      span ? '内容高 ' + span.scrollHeight + ' / 可视高 ' + span.clientHeight : '找不到文字元素',
    );
    // 两行文字(44) + 上下内边距(18) + 标签(16) + 间距(6) = 84
    check(
      '【联动节点】卡片高度把来源标签算进去了',
      !!card && card.offsetHeight >= 84,
      card ? card.offsetHeight + 'px' : '没有卡片',
    );
  }

  // ── B. 递增序列：宽度逐档验证（黄金值，顺带盯住 CSS 与估算常量有没有走偏）
  const probeRows = PROBES.map((one) => {
    const card = nodeById(idOf.get(one.text));
    return {
      n: one.n,
      w: card ? card.offsetWidth : -1,
      want: Math.min(360, Math.max(132, 26 + one.n * 13 + 2)),
    };
  });
  check(
    '宽度随字数连续增长（1→30 字逐档对上公式）',
    probeRows.every((r) => r.w === r.want),
    probeRows.map((r) => r.n + '字=' + r.w + '(期望' + r.want + ')').join(', '),
  );
  check(
    '宽度单调不减',
    probeRows.every((r, i) => i === 0 || r.w >= probeRows[i - 1].w),
    probeRows.map((r) => r.w).join(' → '),
  );

  const widths = cards.map((c) => c.offsetWidth);
  check('短节点不缩成小方块（最小 132）', widths.indexOf(132) >= 0, '宽度：' + widths.join(', '));
  check(
    '出现了 132/180/224 以外的宽度 → 真的连续算了',
    widths.some((w) => w !== 132 && w !== 180 && w !== 224),
    '宽度：' + widths.join(', '),
  );
  check('最长那个节点封顶在 360（没有排成一条长龙）', Math.max.apply(null, widths) === 360, '最宽 ' + Math.max.apply(null, widths));
  check(
    '所有宽度都在 [132, 360] 之间',
    widths.every((w) => w >= 132 && w <= 360),
    '宽度：' + widths.join(', '),
  );

  // ── 卡片之间不许重叠（高度算错最直观的后果就是叠在一起）
  const rects = cards.map((c) => ({ el: c, r: c.getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i].r;
      const b = rects[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
        overlaps.push(
          (rects[i].el.getAttribute('data-node-text') || '').slice(0, 8) +
            ' ✕ ' +
            (rects[j].el.getAttribute('data-node-text') || '').slice(0, 8),
        );
      }
    }
  }
  check('节点卡片之间没有重叠', overlaps.length === 0, overlaps.join(' ;; '));

  return report({ noteId: note.id, widths, probes: probeRows });
})();
