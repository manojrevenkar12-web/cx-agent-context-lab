import { motion, useReducedMotion } from "motion/react";

export interface Split {
  read: number;
  write: number;
  uncached: number;
  output?: number;
}

const SEGMENTS: Array<{ key: keyof Split; label: string; color: string }> = [
  { key: "read", label: "read from cache", color: "var(--read)" },
  { key: "write", label: "written to cache", color: "var(--write)" },
  { key: "uncached", label: "plain input", color: "var(--uncached)" },
  { key: "output", label: "output", color: "var(--output)" },
];

/**
 * One request's tokens as a horizontal ribbon, drawn to a shared scale so ribbons in a list
 * compare by length. The ribbon is the console's single picture: everything else is text.
 */
export function Ribbon({ split, scale, label }: { split: Split; scale: number; label: string }) {
  const reduce = useReducedMotion();
  const total = SEGMENTS.reduce((n, s) => n + (split[s.key] ?? 0), 0);
  const describe = SEGMENTS.filter((s) => (split[s.key] ?? 0) > 0)
    .map((s) => `${Math.round(split[s.key] ?? 0).toLocaleString("en-US")} ${s.label}`)
    .join(", ");
  return (
    <div className="ribbon" role="img" aria-label={`${label}: ${describe || "no tokens"}`}>
      <motion.div
        className="ribbon__track"
        initial={reduce ? false : { width: 0 }}
        animate={{ width: `${Math.max(0.5, (total / Math.max(1, scale)) * 100)}%` }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        {SEGMENTS.map((s) => {
          const v = split[s.key] ?? 0;
          return v > 0 ? <span key={s.key} className="ribbon__seg" style={{ flexGrow: v, background: s.color }} /> : null;
        })}
      </motion.div>
    </div>
  );
}

export function RibbonKey() {
  return (
    <ul className="ribbon-key" aria-label="Ribbon colours">
      {SEGMENTS.map((s) => (
        <li key={s.key}>
          <span className="ribbon-key__swatch" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
