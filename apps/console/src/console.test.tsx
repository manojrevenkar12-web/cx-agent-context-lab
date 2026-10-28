import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BetsPage } from "./Bets";
import { Ribbon } from "./Ribbon";

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Ribbon", () => {
  it("describes its slices in words for screen readers", () => {
    render(<Ribbon split={{ read: 900, write: 100, uncached: 0, output: 20 }} scale={2000} label="Call 1" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Call 1: 900 read from cache, 100 written to cache, 20 output");
  });
});

describe("BetsPage", () => {
  it("shows a loading state, then the bets with their verdicts", async () => {
    const results = {
      scenarioSet: "scenarios/dev",
      seeds: 3,
      bets: [
        {
          id: "tool-loading",
          title: "Loading tools",
          question: "Q?",
          headline: "search wins",
          verdict: "hand-off",
          primary: "cost_per_conversation",
          also: [],
          runs: [],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(results), { status: 200 })),
    );
    wrap(<BetsPage />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText("Loading tools")).toBeTruthy();
    expect(screen.getByText("Hand off")).toBeTruthy();
  });

  it("explains a failure and retries", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "No results yet. Run `npm run lab -- bets`." }), { status: 404 }));
    vi.stubGlobal("fetch", f);
    wrap(<BetsPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/No results yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("says what to run when there are no bets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ scenarioSet: "x", seeds: 1, bets: [] }), { status: 200 })),
    );
    wrap(<BetsPage />);
    expect(await screen.findByText("No bets have run yet")).toBeTruthy();
  });
});
