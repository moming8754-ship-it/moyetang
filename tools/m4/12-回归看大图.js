// 12 · 回归 M3.1「点击看大图」—— 因为 InfoPage 改用了抽出来的公共 ImageViewer
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('信息区');
  await sleep(900);

  // 造一条图片信息（界面上的拖图没法用脚本合成，所以走命令把数据备好）
  // ⚠️ 开源版：换成你机器上任意一张图片的绝对路径（同 08 步）。
  const SAMPLE_IMAGE = 'REPLACE_ME\\一张图片.jpg';
  if (SAMPLE_IMAGE.indexOf('REPLACE_ME') === 0) { skip('没配 SAMPLE_IMAGE，跳过看大图这一步'); return; }
  const rel = await invoke('asset_import', { path: SAMPLE_IMAGE });
  check('图片进了 assets/', /^assets\//.test(rel), rel);
  const info = await invoke('info_create', {
    text: 'M4 回归用的图片信息',
    kind: 'image',
    categories: [],
    assetPath: rel,
  });
  check('图片信息建好了', !!info && info.kind === 'image', info && info.kind);

  // 让信息区重新拉一次
  await nav('认知区');
  await sleep(400);
  await refreshUi();
  await nav('信息区');
  await sleep(900);

  // ── 列表里的缩略图
  const thumb = await waitFor(
    () => $$('[id^="info-"] img').find((el) => el.src && el.src.indexOf('asset') >= 0),
    5000,
  );
  check('信息列表里能看到缩略图', !!thumb, $$('[id^="info-"] img').length + ' 张');
  if (!thumb) return report();

  const rect = thumb.getBoundingClientRect();
  pointerClick(thumb, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });

  // ── 大图查看器（公共组件）
  const viewer = await waitFor(() => $('[data-image-viewer]'), 4000);
  check('点击缩略图打开了大图', !!viewer);
  if (!viewer) return report();

  const sizeText = await waitFor(() => {
    const m = document.body.innerText.match(/(\d+)\s*×\s*(\d+)/);
    return m ? m[0] : null;
  }, 4000);
  check('大图顶部显示原始尺寸', !!sizeText, String(sizeText));
  check('尺寸是真实像素（美尔巴 580×428）', sizeText === '580 × 428', String(sizeText));

  // ⚠️ M3.1 修的坑：默认必须"按宽度铺满"，不能用 max-height 把长图压成窄缝
  check('默认按宽度铺满（不是被高度压扁）', viewer.style.maxWidth === '100%', viewer.style.maxWidth);
  check('没有给图片加 max-height（那个坑）',
    !viewer.style.maxHeight && String(viewer.className).indexOf('max-h') < 0,
    viewer.style.maxHeight + ' | ' + viewer.className);
  const scrollHost = viewer.parentElement;
  check('图片外面那层可以滚动（长图能滚着看下半截）',
    scrollHost && String(scrollHost.className).indexOf('overflow-auto') >= 0,
    scrollHost && String(scrollHost.className));

  // ── 1:1 / 适应宽度切换
  const toggle = $$('button').find((b) => txt(b) === '原图 1:1');
  check('有「原图 1:1 / 适应宽度」切换按钮', !!toggle);
  if (toggle) {
    pointerClick(toggle);
    await sleep(250);
    check('切到原图 1:1 生效', $('[data-image-viewer]').style.maxWidth === 'none',
      $('[data-image-viewer]').style.maxWidth);
    const back = $$('button').find((b) => txt(b) === '适应宽度');
    check('按钮文字跟着变', !!back);
    if (back) {
      pointerClick(back);
      await sleep(250);
      check('切回适应宽度', $('[data-image-viewer]').style.maxWidth === '100%');
    }
  }

  // ── 点背景关闭
  const overlay = $('[data-image-viewer]').closest('.fixed');
  pointerClick($$('.fixed').find((el) => el.contains(viewer)) || overlay);
  await sleep(400);
  check('点背景能关掉大图', !$('[data-image-viewer]'));

  // ── 再开一次，用「关闭 ✕」
  const thumb2 = $$('[id^="info-"] img').find((el) => el.src && el.src.indexOf('asset') >= 0);
  if (thumb2) {
    pointerClick(thumb2);
    await waitFor(() => $('[data-image-viewer]'), 3000);
    check('第二次也能打开', !!$('[data-image-viewer]'));
    const closeBtn = $$('button').find((b) => txt(b).indexOf('关闭') >= 0);
    check('有「关闭 ✕」按钮', !!closeBtn);
    pointerClick(closeBtn);
    await sleep(300);
    check('「关闭 ✕」能关掉', !$('[data-image-viewer]'));
  } else {
    check('第二次也能打开', false, '没找到缩略图');
  }

  // ── Esc 也能关（M3 行为）
  const thumb3 = $$('[id^="info-"] img').find((el) => el.src && el.src.indexOf('asset') >= 0);
  if (thumb3) {
    pointerClick(thumb3);
    await waitFor(() => $('[data-image-viewer]'), 3000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(400);
    check('按 Esc 能关掉', !$('[data-image-viewer]'));
  }

  // ── 顺带：信息区其它功能没被抽组件碰坏
  check('信息区列表还在', $$('[id^="info-"]').length > 0, String($$('[id^="info-"]').length));
  check('信息区顶部录入框还在', !!$('textarea'));
  check('信息区还有筛选/分类入口', txt($('main')).indexOf('信息分类') >= 0 || $$('button').some((b) => txt(b).indexOf('分类') >= 0));

  return report({ assetPath: rel });
})();
