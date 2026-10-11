import type { CSSProperties, ReactNode } from "react";
import type { Issue } from "../core";

/** The one way the studio shows what is wrong: each issue with the file or field it is about. */
export function IssueList({
  issues,
  title,
  style,
  children,
}: {
  issues: Issue[];
  title?: ReactNode;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div className="issues" role="alert" style={style}>
      {title && <strong>{title}</strong>}
      <ul>
        {children}
        {issues.map((issue) => (
          <li key={`${issue.code}|${issue.path ?? ""}|${issue.message}`}>
            {issue.path && <code>{issue.path}: </code>}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
