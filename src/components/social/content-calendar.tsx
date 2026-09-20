"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { getPlatformConfig } from "./platform-badge";
import { ALL_CHANNELS } from "@/lib/channels/registry";

type CalPost = {
  id: string;
  platform: string;
  status: string;
  scheduled_at: string | null;
  caption: string;
};

type ContentCalendarProps = {
  posts: CalPost[];
  onPostClick?: (post: CalPost) => void;
};

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

export function ContentCalendar({ posts, onPostClick }: ContentCalendarProps) {
  const today = new Date();

  const daysInMonth = getDaysInMonth(today.getFullYear(), today.getMonth());
  const firstDay    = getFirstDayOfMonth(today.getFullYear(), today.getMonth());

  // Group posts by day
  const postsByDay: Record<number, CalPost[]> = {};
  for (const post of posts) {
    if (!post.scheduled_at) continue;
    const d = new Date(post.scheduled_at);
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) {
      const day = d.getDate();
      if (!postsByDay[day]) postsByDay[day] = [];
      postsByDay[day].push(post);
    }
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const monthName = today.toLocaleString("en-US", { month: "long", year: "numeric" });

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">{monthName}</h3>
        <div className="flex items-center gap-1">
          <button className="p-1.5 rounded hover:bg-secondary transition-colors" disabled title="Navigate months coming soon">
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          </button>
          <button className="p-1.5 rounded hover:bg-secondary transition-colors" disabled title="Navigate months coming soon">
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Day names */}
      <div className="grid grid-cols-7 border-b border-border">
        {dayNames.map(d => (
          <div key={d} className="py-2 text-center text-[10px] font-medium text-muted-foreground">
            {d}
          </div>
        ))}
      </div>

      {/* Cells */}
      <div className="grid grid-cols-7">
        {cells.map((day, idx) => {
          const isToday = day === today.getDate();
          const dayPosts = day ? (postsByDay[day] ?? []) : [];

          return (
            <div
              key={idx}
              className={`min-h-[80px] p-1.5 border-b border-r border-border/50 last:border-r-0 ${
                !day ? "bg-secondary/20" : "hover:bg-secondary/30"
              }`}
            >
              {day && (
                <>
                  <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                    isToday ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                  }`}>
                    {day}
                  </div>
                  <div className="space-y-0.5">
                    {dayPosts.slice(0, 3).map(post => {
                      const cfg = getPlatformConfig(post.platform);
                      return (
                        <button
                          key={post.id}
                          onClick={() => onPostClick?.(post)}
                          className={`w-full text-left rounded px-1 py-0.5 text-[9px] font-medium truncate transition-opacity hover:opacity-80 ${cfg.bg} ${cfg.color}`}
                          title={post.caption}
                        >
                          {cfg.emoji} {post.caption.slice(0, 20)}…
                        </button>
                      );
                    })}
                    {dayPosts.length > 3 && (
                      <div className="text-[9px] text-muted-foreground px-1">
                        +{dayPosts.length - 3} more
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-t border-border flex items-center gap-3 flex-wrap">
        <span className="text-[10px] text-muted-foreground font-medium">Platforms:</span>
        {ALL_CHANNELS.map(c => c.id).map(p => {
          const cfg = getPlatformConfig(p);
          return (
            <span key={p} className={`text-[10px] flex items-center gap-0.5 ${cfg.color}`}>
              {cfg.emoji} {cfg.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
