import { useDeferredValue, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { EmptyState, ErrorNotice } from "../../components/Overlay";
import { Icon } from "../../components/Icon";
import { humanise } from "../../format";
import { useResource } from "../../useResource";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const initial = params.get("q") ?? "";
  const [query, setQuery] = useState(initial);
  const deferredQuery = useDeferredValue(params.get("q")?.trim() ?? "");
  const results = useResource(() => deferredQuery ? api.search(deferredQuery) : Promise.resolve([]), [deferredQuery]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    setParams(trimmed ? { q: trimmed } : {});
  }

  return (
    <div className="page page--search">
      <header className="page-heading"><h1>Search</h1><p>Find a project, phase, work item or remembered decision.</p></header>
      <form className="search-box search-box--page" onSubmit={submit} role="search">
        <Icon name="search" size={22} />
        <input aria-label="Search all project memory" autoFocus onChange={(event) => setQuery(event.target.value)} placeholder="Search all project memory" value={query} />
        <button className="button button--primary" type="submit">Search</button>
      </form>
      {results.error ? <ErrorNotice error={results.error} onRetry={results.reload} /> : null}
      {results.loading && deferredQuery ? <div className="search-loading">Searching project memory…</div> : null}
      {!deferredQuery ? <EmptyState title="Search across everything">Titles, descriptions, phases, work items and current update revisions are indexed locally.</EmptyState> : null}
      {deferredQuery && !results.loading && results.data?.length === 0 ? <EmptyState title="Nothing found">Try fewer words or a different term.</EmptyState> : null}
      {results.data?.length ? (
        <section aria-label="Search results" className="search-results">
          <div className="search-results__summary">{results.data.length} {results.data.length === 1 ? "result" : "results"} for “{deferredQuery}”</div>
          {results.data.map((result) => (
            <Link className="search-result" key={`${result.type}-${result.id}`} to={`/projects/${result.projectId}`}>
              <span className={`search-result__type search-result__type--${result.type}`}>{humanise(result.type)}</span>
              <div><h2>{result.title}</h2><p>{result.excerpt || "Open the project to see this item in context."}</p></div>
              <Icon name="chevron" />
            </Link>
          ))}
        </section>
      ) : null}
    </div>
  );
}

