import { useState } from "react";
import Modal from "./Modal";
import { CATEGORY_SEP, CATEGORY_TREE, categoryValue } from "../features/types";

interface CategoryPickerProps {
  value: string[];
  onCancel: () => void;
  onSave: (values: string[]) => void;
}

/**
 * 信息分类选择：两级（组 · 细项）、**可多选**（PRD 5.1.2）。
 * 存进去的值形如 `主动冒出·突然想起`；组上也能勾（等于把这组全勾上）。
 */
export default function CategoryPicker({ value, onCancel, onSave }: CategoryPickerProps) {
  const [picked, setPicked] = useState<string[]>(value);

  const toggle = (item: string) => {
    setPicked((prev) =>
      prev.includes(item) ? prev.filter((one) => one !== item) : [...prev, item],
    );
  };

  const groupValues = (group: string) =>
    CATEGORY_TREE.find((node) => node.group === group)!.leaves.map((leaf) =>
      categoryValue(group, leaf),
    );

  const toggleGroup = (group: string) => {
    const values = groupValues(group);
    const allPicked = values.every((item) => picked.includes(item));
    setPicked((prev) =>
      allPicked
        ? prev.filter((item) => !values.includes(item))
        : [...prev.filter((item) => !values.includes(item)), ...values],
    );
  };

  return (
    <Modal
      title="信息分类（可多选）"
      onClose={onCancel}
      maxWidth="max-w-xl"
      footer={
        <>
          <button
            type="button"
            onClick={() => setPicked([])}
            className="mr-auto rounded-xl px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            清空
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(picked)}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            保存（{picked.length}）
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {CATEGORY_TREE.map((node) => {
          const values = groupValues(node.group);
          const count = values.filter((item) => picked.includes(item)).length;
          return (
            <section key={node.group}>
              <button
                type="button"
                onClick={() => toggleGroup(node.group)}
                className="flex w-full items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-left text-sm font-medium hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700"
              >
                <span className="flex-1">
                  {node.group}
                  <span className="ml-2 text-xs font-normal text-slate-400">
                    {count}/{values.length}
                  </span>
                </span>
                <span className="text-xs text-slate-400">
                  {count === values.length ? "取消整组" : "整组选中"}
                </span>
              </button>

              <div className="mt-2 flex flex-wrap gap-2 pl-1">
                {node.leaves.map((leaf) => {
                  const item = categoryValue(node.group, leaf);
                  const active = picked.includes(item);
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => toggle(item)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        active
                          ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-500/15 dark:text-indigo-300"
                          : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                      }`}
                    >
                      {active ? "✓ " : ""}
                      {leaf}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        {picked.length > 0 && (
          <p className="text-xs text-slate-400">
            已选：{picked.map((item) => item.replace(CATEGORY_SEP, " › ")).join("，")}
          </p>
        )}
      </div>
    </Modal>
  );
}
