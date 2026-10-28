import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Ribbon, RibbonKey } from "./Ribbon";
import { EmptyState, ErrorState, Skeleton } from "./states";

type Item =
  | { kind: "customer"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "model"; purpose: string; read: number; write: number; uncached: number; output: number; ttftMs: number }
  | { kind: "tool"; name: string; isError: boolean };

interface Done {
  grade: { success: boolean; failures: string[] };
  costUsd: number;
  modelCalls: number;
  repeatAsks: number;
}

const LABELS: Record<string, Record<string, string>> = {
  layout: { "dynamic-first": "Time and caller first", "stable-first": "Policies first", "stable-tail": "Policies first, time on the message" },
  tools: { all: "Load all 154 tools", "search-append": "Search, add to tool list", "search-dispatch": "Search, call through a dispatcher" },
  context: { full: "Whole conversation", window: "Last six turns", summary: "Model summary of older turns", casefile: "Case file of older turns" },
};

export function Playground() {
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: api.scenarios });
  const options = useQuery({ queryKey: ["options"], queryFn: api.options });
  const [form, setForm] = useState({ scenario: "", provider: "anthropic", layout: "stable-tail", tools: "search-dispatch", context: "full" });
  const [items, setItems] = useState<Item[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error" | "done">("idle");
  const source = useRef<EventSource | null>(null);

  useEffect(() => () => source.current?.close(), []);

  if (scenarios.isPending || options.isPending) return <Skeleton lines={4} label="Loading scenarios" />;
  if (scenarios.isError || options.isError)
    return (
      <ErrorState
        title="The playground could not reach the lab API"
        detail={(scenarios.error ?? options.error)?.message ?? ""}
        onRetry={() => {
          void scenarios.refetch();
          void options.refetch();
        }}
      />
    );
  const scenario = form.scenario || scenarios.data[0]?.id || "";

  const run = () => {
    source.current?.close();
    setItems([]);
    setDone(null);
    setStatus("running");
    const qs = new URLSearchParams({ ...form, scenario });
    const es = new EventSource(`/api/stream?${qs}`);
    source.current = es;
    const add = (i: Item) => setItems((xs) => [...xs, i]);
    es.addEventListener("customer", (e) => add({ kind: "customer", text: JSON.parse((e as MessageEvent).data).text }));
    es.addEventListener("reply", (e) => add({ kind: "agent", text: JSON.parse((e as MessageEvent).data).text }));
    es.addEventListener("tool", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      add({ kind: "tool", name: d.name === "call_tool" ? String(d.input.name) : d.name, isError: d.isError });
    });
    es.addEventListener("model", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      add({
        kind: "model",
        purpose: d.purpose,
        read: d.usage.cacheReadTokens,
        write: d.usage.cacheWriteTokens,
        uncached: d.usage.inputTokens,
        output: d.usage.outputTokens,
        ttftMs: d.ttftMs,
      });
    });
    es.addEventListener("done", (e) => {
      setDone(JSON.parse((e as MessageEvent).data));
      setStatus("done");
      es.close();
    });
    es.onerror = () => {
      es.close();
      setStatus((s) => (s === "done" ? s : "error"));
    };
  };

  const models = items.filter((i): i is Extract<Item, { kind: "model" }> => i.kind === "model");
  const scale = Math.max(1, ...models.map((m) => m.read + m.write + m.uncached + m.output));
  const select = (key: keyof typeof form, values: readonly string[], label: string) => (
    <div className="field">
      <label className="field__label" htmlFor={`field-${key}`}>
        {label}
      </label>
      <select
        id={`field-${key}`}
        value={key === "scenario" ? scenario : form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        disabled={status === "running"}
      >
        {values.map((v) => (
          <option key={v} value={v}>
            {LABELS[key]?.[v] ?? v}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section aria-labelledby="play-title">
      <h1 id="play-title" className="page-title">
        Watch one conversation's bill
      </h1>
      <p className="lede">
        Pick a caller and a setup. Each model call is drawn as a ribbon of its input: what the provider read from its cache, what it had to write, and what it
        read fresh. Time runs eight times faster than a real call.
      </p>
      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        {select(
          "scenario",
          scenarios.data.map((s) => s.id),
          "Caller",
        )}
        {select("provider", options.data.providers, "Caching rules")}
        {select("layout", options.data.layouts, "Prompt layout")}
        {select("tools", options.data.tools, "Tools")}
        {select("context", options.data.contexts, "Context")}
        <button type="submit" className="button button--primary" disabled={status === "running"}>
          {status === "running" ? "Running…" : "Run conversation"}
        </button>
      </form>
      <RibbonKey />
      {status === "idle" ? (
        <EmptyState title="Nothing has run yet">
          <p>Run a conversation to see each request the agent sends, and how much of it the provider already had.</p>
        </EmptyState>
      ) : null}
      {status === "error" ? <ErrorState title="The conversation stopped" detail="The stream from the lab API broke off before the end." onRetry={run} /> : null}
      <ol className="transcript" aria-live="polite">
        {items.map((it, i) => {
          const key = `${i}-${it.kind}`;
          if (it.kind === "customer")
            return (
              <li key={key} className="line line--customer">
                <span className="line__who">Caller</span>
                <p>{it.text}</p>
              </li>
            );
          if (it.kind === "agent")
            return (
              <li key={key} className="line line--agent">
                <span className="line__who">Agent</span>
                <p>{it.text}</p>
              </li>
            );
          if (it.kind === "tool")
            return (
              <li key={key} className={`line line--tool${it.isError ? " is-error" : ""}`}>
                <span className="line__who">Tool</span>
                <code>{it.name}</code>
                {it.isError ? <span className="muted"> returned an error</span> : null}
              </li>
            );
          return (
            <li key={key} className="line line--model">
              <span className="line__who">{it.purpose === "summary" ? "Summary call" : "Model call"}</span>
              <Ribbon split={it} scale={scale} label={`Model call ${i + 1}`} />
              <span className="line__meta">
                {(it.read + it.write + it.uncached).toLocaleString("en-US")} in, first token {Math.round(it.ttftMs)} ms
              </span>
            </li>
          );
        })}
      </ol>
      {done ? (
        <div className={`outcome ${done.grade.success ? "outcome--pass" : "outcome--fail"}`} role="status">
          <p className="outcome__title">{done.grade.success ? "Resolved" : "Not resolved"}</p>
          <p>
            ${done.costUsd.toFixed(4)} for {done.modelCalls} model calls, {done.repeatAsks} repeat question{done.repeatAsks === 1 ? "" : "s"}.
          </p>
          {done.grade.failures.length ? (
            <ul>
              {done.grade.failures.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : status === "running" && items.length === 0 ? (
        <Skeleton lines={2} label="Starting the conversation" />
      ) : null}
    </section>
  );
}
