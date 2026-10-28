import { useEffect, useState } from "react";
import { BetDetail, BetsPage } from "./Bets";
import { Playground } from "./Playground";

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const bet = hash.match(/^#\/bets\/([a-z0-9-]+)$/)?.[1];
  const page = hash.startsWith("#/play") ? "play" : "bets";
  return (
    <>
      {/* the hash is the router, so the skip control moves focus instead of navigating */}
      <button type="button" className="skip" onClick={() => document.getElementById("main")?.focus()}>
        Skip to content
      </button>
      <header className="masthead">
        <a className="wordmark" href="#/">
          Context Lab
        </a>
        <nav aria-label="Sections">
          <a href="#/" aria-current={page === "bets" ? "page" : undefined}>
            Bets
          </a>
          <a href="#/play" aria-current={page === "play" ? "page" : undefined}>
            Playground
          </a>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {page === "play" ? <Playground /> : bet ? <BetDetail id={bet} /> : <BetsPage />}
      </main>
    </>
  );
}
