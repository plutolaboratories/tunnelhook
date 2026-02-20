import { createFileRoute } from "@tanstack/react-router";
import { Package, Tag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { changelog } from "@/data/changelog";

export const Route = createFileRoute("/dashboard/changelog")({
  component: ChangelogPage,
});

function ChangelogPage() {
  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-8 py-5">
        <div>
          <h1 className="font-semibold text-[22px] leading-[28px] tracking-tight">
            Changelog
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Release history for the tunnelhook CLI
          </p>
        </div>
        <a
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-border px-3 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          href="https://www.npmjs.com/package/tunnelhook"
          rel="noopener noreferrer"
          target="_blank"
        >
          <Package className="size-3.5" />
          npm
        </a>
      </div>

      {/* Timeline */}
      <div className="flex flex-1 flex-col px-8 py-6">
        <div className="relative max-w-2xl">
          {/* Vertical line */}
          <div className="absolute top-0 bottom-0 left-[7px] w-px bg-border" />

          <div className="flex flex-col gap-10">
            {changelog.map((entry, index) => (
              <div className="relative flex gap-5 pl-7" key={entry.version}>
                {/* Dot */}
                <div
                  className={`absolute top-[6px] left-0 z-10 size-[15px] rounded-full border-2 ${
                    index === 0
                      ? "border-cyan bg-cyan-subtle"
                      : "border-border bg-card"
                  }`}
                />

                <div className="min-w-0 flex-1">
                  {/* Version header */}
                  <div className="flex items-center gap-2.5">
                    <h2 className="font-semibold text-[16px] tracking-tight">
                      v{entry.version}
                    </h2>
                    <Badge
                      variant={entry.type === "minor" ? "cyan" : "secondary"}
                    >
                      <Tag className="size-3" />
                      {entry.type}
                    </Badge>
                  </div>

                  <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                    {entry.date}
                  </p>

                  {/* Changes */}
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {entry.changes.map((change) => (
                      <li
                        className="flex items-start gap-2 text-[13px] text-foreground/80 leading-[20px]"
                        key={change}
                      >
                        <span className="mt-[7px] block size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                        {change}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
