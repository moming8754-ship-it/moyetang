interface ComingSoonProps {
  /** 计划在哪个里程碑做 */
  stage: string;
  /** 计划内容（来自 DEV-PLAN） */
  lines: string[];
}

/** 尚未实现的区：只说明计划，不做假界面 */
export default function ComingSoon({ stage, lines }: ComingSoonProps) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-8 dark:border-slate-700 dark:bg-slate-900/40">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        该区计划在{" "}
        <span className="font-medium text-indigo-600 dark:text-indigo-400">{stage}</span>{" "}
        阶段实现，内容如下：
      </p>
      <ul className="mt-4 space-y-2 text-sm text-slate-600 dark:text-slate-300">
        {lines.map((line) => (
          <li key={line} className="flex gap-2">
            <span className="text-indigo-400">·</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
