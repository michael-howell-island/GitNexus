/**
 * Append all elements from `src` into `target` without using spread.
 * `target.push(...src)` calls `Function.prototype.apply` under the hood,
 * which blows V8's call stack when `src` has >~65K elements.
 */
export const appendAll = <T>(target: T[], src: readonly T[]): void => {
  for (let i = 0; i < src.length; i++) target.push(src[i]);
};
