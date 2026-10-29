// 08 · 节点插图片（M4-4）—— 用户特意要的"比原版小米笔记多出来的能力"
//
// ⚠️ 说明：原生文件拖放（把图片从资源管理器拖到卡片上）没法用脚本合成
// （那是操作系统级的事件，不是页面事件）。这里验的是**同一条数据链路的另一半**：
// asset_import → note_tree_set_image → 缩略图渲染 → 看大图 → 去掉图。
// 拖放的那一半走的是 `onDragDropEvent`（和 M2 信息区拖图**同一段代码**，
// 那段用户 2026-09-20 已实测通过），差别只在我加的"按 position 命中哪个节点"。
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 5000);

  const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;

  // ⚠️ 开源版：原来用的是作者数据目录里的图；换成你机器上任意一张图片的绝对路径。
  const SAMPLE_IMAGE = 'REPLACE_ME\\一张图片.jpg';
  if (SAMPLE_IMAGE.indexOf('REPLACE_ME') === 0) { skip('没配 SAMPLE_IMAGE，跳过插图这一步'); return; }
  const rel = await invoke('asset_import', { path: SAMPLE_IMAGE });
  check('图片被复制进 assets/ 了', /^assets\//.test(rel), rel);

  let root = (await invoke('note_get', { id: noteId })).root;
  const target = root.children[0];
  check('挑一个节点来插图', !!target, root.children.map((c) => c.text).join(' | '));

  const res = await invoke('note_tree_set_image', { noteId, nodeId: target.id, assetPath: rel });
  check('命令正常返回', !!res && !!res.note);
  await refreshUi(noteId);

  // ── 节点卡片里要看得到缩略图
  const card = nodeById(target.id);
  const img = card && card.querySelector('img');
  check('节点卡片里出现缩略图', !!img, card && card.innerText);
  const rect = img ? img.getBoundingClientRect() : null;
  check('缩略图真的占地方（不是 0 高）', rect && rect.height > 20, rect && Math.round(rect.width) + 'x' + Math.round(rect.height));
  check('缩略图走 asset 协议', img && img.src.indexOf('asset') >= 0, img && img.src.slice(0, 70));

  let stored = (await invoke('note_get', { id: noteId })).root;
  check('图片路径落到节点上了（重启也还在）', stored.children[0].assetPath === rel, stored.children[0].assetPath);

  // 有图的节点卡片该变高（布局要跟着让位，不能和下面的节点叠在一起）
  const layoutCards = $$('[data-node-id]').map((el) => el.getBoundingClientRect());
  const overlap = layoutCards.some((a, i) =>
    layoutCards.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  check('插了图之后节点之间没有重叠（布局把高度算进去了）', !overlap);

  // ── 点缩略图看大图（M3.1 那个"长图被压成窄缝"的坑，这里用的是同一个公共组件）
  pointerClick(img);
  const viewer = await waitFor(() => $('[data-image-viewer]'), 3000);
  check('点缩略图能看大图', !!viewer);
  const sizeText = await waitFor(() => {
    const t = document.body.innerText;
    return /\d+ × \d+/.test(t) ? t.match(/\d+ × \d+/)[0] : null;
  }, 3000);
  check('大图显示了原始尺寸', !!sizeText, String(sizeText));
  check('大图默认按宽度铺满（不是被压成窄缝）', viewer && viewer.style.maxWidth === '100%', viewer && viewer.style.maxWidth);
  const toggle = $$('button').find((b) => txt(b) === '原图 1:1');
  check('有「原图 1:1 / 适应宽度」切换', !!toggle);
  if (toggle) {
    pointerClick(toggle);
    await sleep(200);
    check('切到原图 1:1 生效', $('[data-image-viewer]').style.maxWidth === 'none', $('[data-image-viewer]').style.maxWidth);
  }
  const closeBtn = $$('button').find((b) => txt(b).indexOf('关闭') >= 0);
  pointerClick(closeBtn);
  await sleep(300);
  check('大图能关掉', !$('[data-image-viewer]'));

  // ── 编辑态里有个 × 能去掉图
  dblClick(nodeById(target.id));
  await waitFor(() => $('[data-tree-canvas] textarea'), 3000);
  const removeBtn = byTitle('去掉这张图（assets/ 里的原文件不动）');
  check('编辑态里出现「去掉这张图」', !!removeBtn);
  if (removeBtn) {
    pointerClick(removeBtn);
    await sleep(900);
    stored = (await invoke('note_get', { id: noteId })).root;
    const after = stored.children.find((c) => c.id === target.id);
    check('图片从节点上摘掉了', after && !after.assetPath, after && String(after.assetPath));
    check('节点还在（去掉图不等于删节点）', !!after);
    check('画布上这张卡片没有缩略图了', !(nodeById(target.id) || { querySelector: () => null }).querySelector('img'));
  }

  // 收尾：把编辑态收掉
  const ta = $('[data-tree-canvas] textarea');
  if (ta) {
    key(ta, 'Escape');
    await sleep(500);
  }

  // ── 再插一次，让"节点带图"这个状态留在数据里给重启检查用
  await invoke('note_tree_set_image', { noteId, nodeId: target.id, assetPath: rel });
  await refreshUi(noteId);
  stored = (await invoke('note_get', { id: noteId })).root;
  check('收尾：节点又带上图了（留着给重启复查）', !!stored.children.find((c) => c.id === target.id).assetPath);

  return report({ assetPath: rel });
})();
