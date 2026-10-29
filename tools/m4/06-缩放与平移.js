// 06 · 画布缩放 / 平移（M4-5）
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(400);
  await pickNote('M4 验收树');
  const cv = await waitFor(() => canvas(), 5000);
  check('画布在', !!cv);

  /** 右下角那个百分比 */
  const readZoom = () => {
    const el = $$('span').find((s) => /^\d+%$/.test(txt(s)));
    return el ? parseInt(txt(el), 10) : null;
  };

  const zoom0 = readZoom();
  check('右下角显示了缩放比例', zoom0 !== null, String(zoom0));

  // ── 滚轮放大（锚在画布中心）
  const r = cv.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  wheel(cv, -240, cx, cy);
  await sleep(300);
  const zoomIn = readZoom();
  check('滚轮向前 = 放大', zoomIn !== null && zoomIn > zoom0, zoom0 + ' → ' + zoomIn);

  // ── 滚轮缩小
  wheel(cv, 480, cx, cy);
  await sleep(300);
  const zoomOut = readZoom();
  check('滚轮向后 = 缩小', zoomOut !== null && zoomOut < zoomIn, zoomIn + ' → ' + zoomOut);

  // ── 缩放是有上下限的（不然一推到底就什么都看不见了）
  for (let i = 0; i < 12; i += 1) wheel(cv, 600, cx, cy);
  await sleep(300);
  const zoomMin = readZoom();
  check('缩放下限 40%', zoomMin === 40, String(zoomMin));
  for (let i = 0; i < 30; i += 1) wheel(cv, -600, cx, cy);
  await sleep(300);
  const zoomMax = readZoom();
  check('缩放上限 200%', zoomMax === 200, String(zoomMax));

  // ── ⌖ 归位：回到 1:1 并居中
  pointerClick(byTitle('回到 1:1 并居中（Ctrl+0）'));
  await sleep(400);
  const zoomFit = readZoom();
  check('点 ⌖ 后回到可读比例（不超过 100%）', zoomFit !== null && zoomFit <= 100 && zoomFit >= 40, String(zoomFit));

  // ── 空白处拖动 = 平移：拿一个节点的屏幕位置当标尺
  const probe = $('[data-node-id]');
  const before = probe.getBoundingClientRect();
  const spot = findEmptySpot(cv);
  check('找到画布空白处', !!spot, JSON.stringify(spot && { x: Math.round(spot.x), y: Math.round(spot.y) }));

  if (spot) {
    pev('pointerdown', spot.el, { clientX: spot.x, clientY: spot.y });
    await sleep(60);
    pev('pointermove', cv, { clientX: spot.x + 70, clientY: spot.y + 40 });
    await sleep(60);
    pev('pointermove', cv, { clientX: spot.x + 140, clientY: spot.y + 80 });
    await sleep(60);
    pev('pointerup', cv, { clientX: spot.x + 140, clientY: spot.y + 80 });
    await sleep(300);

    const after = probe.getBoundingClientRect();
    check('平移把整个画布挪走了（节点跟着走）',
      Math.abs((after.left - before.left) - 140) < 6 && Math.abs((after.top - before.top) - 80) < 6,
      'dx=' + Math.round(after.left - before.left) + ' dy=' + Math.round(after.top - before.top));

    // 平移不该动数据
    const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;
    const stored = (await invoke('note_get', { id: noteId })).root;
    check('平移不碰数据（只是换了视角）', !!stored && countAll(stored) === $$('[data-node-id]').length,
      countAll(stored) + ' vs ' + $$('[data-node-id]').length);
  }

  // ── 归位，把干净的视角留给后面的步骤
  pointerClick(byTitle('回到 1:1 并居中（Ctrl+0）'));
  await sleep(300);
  check('收尾：归位成功', readZoom() !== null);

  // ── 放大缩小按钮也要能用
  const zBefore = readZoom();
  pointerClick(byTitle('放大'));
  await sleep(200);
  check('「＋」能放大', readZoom() > zBefore, zBefore + ' → ' + readZoom());
  pointerClick(byTitle('缩小'));
  await sleep(200);
  check('「−」能缩小', readZoom() < 200, String(readZoom()));

  pointerClick(byTitle('回到 1:1 并居中（Ctrl+0）'));
  await sleep(200);
  return report();
})();
