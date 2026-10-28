import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { type Arm, api, type Bet, type BetRun, formatMetric, METRIC_LABEL, type MetricName, type Verdict } from "./api";
import { Ribbon, RibbonKey } from "./Ribbon";
import { EmptyState, ErrorState, Skeleton } from "./states";

const VERDICT_TEXT: Record<Verdict, string> = { "hand-off": "Hand off", publish: "Publish", iterate: "Iterate", kill: "Kill" };

export function VerdictWord({ v }: { v: Verdict }) {
  return <span className={`verdict verdict--${v}`}>{VERDICT_TEXT[v]}</span>;
}

function useResults() {
  return useQuery({ queryKey: ["results"], queryFn: api.results });
}

export function BetsPage() {
  const q = useResults();
  const reduce = useReducedMotion();
  if (q.isPending) return <Skeleton lines={6} label="Loading the bets" />;
  if (q.isError) return <ErrorState title="The bets could not be loaded" detail={q.error.message} onRetry={() => q.refetch()} />;
  if (!q.data.bets.length)
    return (
      <EmptyState title="No bets have run yet">
        <p>
          Run <code>npm run lab -- bets</code> to produce the results this page reads.
        </p>
      </EmptyState>
    );
  return (
    <section aria-labelledby="bets-title">
      <h1 id="bets-title" className="page-title">
        Four bets on what a contact-centre agent sends its model
      </h1>
      <p className="lede">
        Every bet runs the same customer conversations under a baseline and its variants, bills each request by the provider's documented caching rules, and
        ends in a decision: hand off to product, publish as guidance, iterate, or kill. {q.data.bets[0]?.runs[0]?.conversations ?? 0} conversations per arm on{" "}
        <code>{q.data.scenarioSet}</code>.
      </p>
      <ol className="bet-list">
        {q.data.bets.map((b, i) => (
          <motion.li
            key={b.id}
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: reduce ? 0 : i * 0.07, ease: [0.22, 1, 0.36, 1] }}
          >
            <a className="bet-row" href={`#/bets/${b.id}`}>
              <VerdictWord v={b.verdict} />
              <span className="bet-row__body">
                <span className="bet-row__title">{b.title}</span>
                <span className="bet-row__question">{b.question}</span>
                <span className="bet-row__headline">{b.headline}</span>
              </span>
            </a>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}

function armSplit(a: Arm) {
  const input = a.metrics.input_tokens;
  const read = input * a.metrics.cache_read_share;
  const write = input * a.metrics.cache_write_share;
  return { read, write, uncached: Math.max(0, input - read - write) };
}

function RunView({ bet, run }: { bet: Bet; run: BetRun }) {
  const arms = [run.baseline, ...run.arms];
  const metrics = [...new Set<MetricName>([bet.primary, ...bet.also, "resolved_rate", "repeat_asks", "cache_read_share"])];
  const scale = Math.max(...arms.map((a) => a.metrics.input_tokens));
  return (
    <section className="run" aria-label={`${run.provider}${run.chatterScale !== 1 ? `, calls ${run.chatterScale} times longer` : ""}`}>
      <h2 className="run__title">
        {run.provider === "anthropic" ? "Anthropic" : "OpenAI"} caching rules
        {run.chatterScale !== 1 ? <span className="run__note">, calls {run.chatterScale}× longer</span> : null}
      </h2>
      <div className="ribbons">
        {arms.map((a, i) => (
          <div key={a.config} className="ribbons__row">
            <span className="ribbons__label">
              {a.label}
              {i === 0 ? <span className="muted"> baseline</span> : null}
            </span>
            <Ribbon split={armSplit(a)} scale={scale} label={`${a.label}, input tokens per conversation`} />
            <span className="ribbons__value">{formatMetric("cost_per_conversation", a.metrics.cost_per_conversation)}</span>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Metrics per arm</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {arms.map((a) => (
                <th key={a.config} scope="col">
                  {a.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m} className={m === bet.primary ? "is-primary" : undefined}>
                <th scope="row">{METRIC_LABEL[m]}</th>
                {arms.map((a) => (
                  <td key={a.config}>{formatMetric(m, a.metrics[m])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="decisions">
        {run.variants.map((v) => (
          <div key={v.config} className="decision">
            <p>
              <VerdictWord v={v.verdict} /> <strong>{v.label}.</strong> {v.reasons.join("; ")}.
            </p>
            {v.assumptions.length ? <p className="decision__assumption">Rests on simulator assumptions: {v.assumptions.join("; ")}.</p> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function BetDetail({ id }: { id: string }) {
  const q = useResults();
  if (q.isPending) return <Skeleton lines={8} label="Loading the bet" />;
  if (q.isError) return <ErrorState title="The bet could not be loaded" detail={q.error.message} onRetry={() => q.refetch()} />;
  const bet = q.data.bets.find((b) => b.id === id);
  if (!bet)
    return (
      <EmptyState title={`There is no bet called ${id}`}>
        <a href="#/">Back to the bets</a>
      </EmptyState>
    );
  return (
    <article aria-labelledby="bet-title">
      <a className="back" href="#/">
        All bets
      </a>
      <h1 id="bet-title" className="page-title">
        {bet.title}
      </h1>
      <p className="lede">{bet.question}</p>
      <p className="verdict-line">
        <VerdictWord v={bet.verdict} /> {bet.headline}
      </p>
      <RibbonKey />
      {bet.runs.map((r) => (
        <RunView key={`${r.provider}-${r.chatterScale}`} bet={bet} run={r} />
      ))}
      <p className="muted">
        The full memo, with failures seen and limits: <a href={`/api/bets/${bet.id}/memo`}>{bet.id}.md</a>
      </p>
    </article>
  );
}
