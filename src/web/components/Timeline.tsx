import { Link } from "react-router-dom";
import { formatDate, formatTime, humanise } from "../format";
import type { ActivityViewItem } from "../types";

export function ActivityTimeline({ items, compact = false }: { items: ActivityViewItem[]; compact?: boolean }) {
  if (items.length === 0) return <p className="timeline-empty">No activity recorded yet.</p>;

  return (
    <ol className={`timeline${compact ? " timeline--compact" : ""}`}>
      {items.map((item) => (
        <li className={`timeline__item timeline__item--${item.kind}`} key={item.id}>
          <span aria-hidden="true" className="timeline__dot" />
          <div className="timeline__meta">
            <span>{humanise(item.kind.replace(/^update_/, ""))}</span>
            <time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time>
          </div>
          <p className="timeline__summary">{item.summary}</p>
          {item.projectTitle ? <Link to={`/projects/${item.projectId}`}>{item.projectTitle}</Link> : null}
          <time className="timeline__time" dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
        </li>
      ))}
    </ol>
  );
}

