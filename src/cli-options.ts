export interface NumberOptionConstraints {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function numberOption(
  value: string | undefined,
  name: string,
  fallback: number,
  constraints: NumberOptionConstraints = {},
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  if (constraints.integer && !Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  if (constraints.min !== undefined && parsed < constraints.min) {
    throw new Error(`${name} must be at least ${String(constraints.min)}.`);
  }
  if (constraints.max !== undefined && parsed > constraints.max) {
    throw new Error(`${name} must be at most ${String(constraints.max)}.`);
  }
  return parsed;
}
