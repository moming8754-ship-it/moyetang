// 10 · 单向可见（M4 不能碰坏 M3 的这条）：信息区看不到认知区的节点文字
//
// 这一条在磁盘上另有一道检查（PowerShell 直接读 info.jsonl，见收工报告），
// 这里先验界面这一头。
(async () => {
  // 先确认应用起来了、导航栏在（窗口可能刚重载过）
  await ready();
  await nav('认知区');
  await sleep(500);
  await pickNote('M4 验收树');
  await waitFor(() => canvas(), 5000);

  const noteId = (await invoke('note_list', {})).find((n) => n.title === 'M4 验收树').id;

  // 挑一个节点文字当"指纹"——它只该出现在认知区。
  //
  // ⚠️ 第一版这里挑错了：拿「M4 联动进树的想法」当指纹，可**那正是那条信息自己的原文**
  // （联动时节点文字 = 信息文字），信息区当然看得到。
  // 那是信息自己的内容，不是泄漏 —— 是测试写错了，不是产品有问题。
  //
  // 指纹必须是**用户在树里手打的**文字（「第一枝」「甲」这种），
  // 而且要避开联动去向里那份 titleSnapshot（笔记标题允许出现在信息区）。
  const infos = await invoke('info_list', {});
  const allowed = infos
    .map((i) => i.text || '')
    .concat(infos.flatMap((i) => (i.links || []).map((l) => l.titleSnapshot || '')))
    .concat(['M4 验收树']);
  const visible = nodeTexts().filter(Boolean);
  const fingerprint = visible.find(
    // 「中心主题」另有专门一条检查，这里挑个更有区分度的
    (t) => t.length >= 2 && t !== '中心主题' && !allowed.some((a) => a.indexOf(t) >= 0),
  );
  check('有可用的节点文字做指纹（用户手打的，不是联动来的）', !!fingerprint, visible.join(' | '));
  check('认知区里能看到这个指纹', !!fingerprint && document.body.innerText.indexOf(fingerprint) >= 0, String(fingerprint));

  // ── 切到信息区，指纹必须消失
  await nav('信息区');
  await sleep(900);
  const infoText = document.body.innerText;
  check('信息区里看不到节点文字', infoText.indexOf(fingerprint) < 0, fingerprint);
  check('信息区里也看不到"中心主题"这类节点词', infoText.indexOf('中心主题') < 0);
  check('信息区里能看到的是"已联动 → 认知区《M4 验收树》"这种去向快照',
    infoText.indexOf('认知区《M4 验收树》') >= 0,
    (infoText.match(/认知区《[^》]*》/g) || []).slice(0, 3).join(' ~ '));

  // ── 后端的信息对象里也不该有节点文字
  const leaked = infos.filter((i) => JSON.stringify(i).indexOf(fingerprint) >= 0);
  check('信息对象里没有任何字段藏着节点文字', leaked.length === 0,
    leaked.map((i) => i.text).join(' | '));

  // ── 去向快照是标题，不是正文（标题可以让用户看到，正文不行）
  const mine = infos.filter((i) => i.links.some((l) => l.targetId === noteId));
  check('有信息联动到这篇树状图', mine.length > 0, String(mine.length));
  check('去向里存的是标题快照',
    mine.every((i) => i.links.filter((l) => l.targetId === noteId).every((l) => l.titleSnapshot === 'M4 验收树')),
    JSON.stringify(mine.map((i) => i.links.map((l) => l.titleSnapshot))));

  // ── 回认知区
  await nav('认知区');
  await sleep(500);
  check('回到认知区还能看到节点（指纹又出现了）', document.body.innerText.indexOf(fingerprint) >= 0);

  return report({ fingerprint });
})();
