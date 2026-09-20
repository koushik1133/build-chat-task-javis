"use client";

import { useState } from "react";
import { CheckCircle2, Clock, Edit2, Image as ImageIcon, Loader2, MoreHorizontal, Send, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlatformBadge } from "./platform-badge";

export type SocialPost = {
  id: string;
  platform: string;
  content_type: string;
  caption: string;
  image_url: string | null;
  hashtags: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  status: "draft" | "pending_approval" | "scheduled" | "published" | "failed";
  notes: string | null;
};

const STATUS_CONFIG: Record<string, { label: string; icon: React.ReactNode; class: string }> = {
  draft:            { label: "Draft",    icon: <Edit2 className="h-3 w-3" />,        class: "bg-secondary text-muted-foreground" },
  pending_approval: { label: "Pending",  icon: <Clock className="h-3 w-3" />,        class: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400" },
  scheduled:        { label: "Scheduled",icon: <Clock className="h-3 w-3" />,        class: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400" },
  published:        { label: "Published",icon: <CheckCircle2 className="h-3 w-3" />, class: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400" },
  failed:           { label: "Failed",   icon: <XCircle className="h-3 w-3" />,      class: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400" },
};

type PostCardProps = {
  post: SocialPost;
  onApprove?: (id: string) => void;
  onDelete?: (id: string) => void;
  onEdit?: (post: SocialPost) => void;
  onSchedule?: (post: SocialPost) => void;
};

export function PostCard({ post, onApprove, onDelete, onEdit, onSchedule }: PostCardProps) {
  const [imgErr, setImgErr]   = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu]       = useState(false);
  const [approving, setApproving] = useState(false);

  const statusCfg = STATUS_CONFIG[post.status] ?? STATUS_CONFIG.draft;

  async function handleApprove() {
    if (!onApprove) return;
    setApproving(true);
    await onApprove(post.id);
    setApproving(false);
  }

  const caption = post.caption ?? "";
  const truncated = caption.length > 160 && !expanded;
  const displayCaption = truncated ? caption.slice(0, 157) + "…" : caption;

  const scheduledDate = post.scheduled_at
    ? new Date(post.scheduled_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="group rounded-xl border border-border bg-card overflow-hidden hover:border-primary/30 transition-colors">
      {/* Image */}
      {post.image_url && !imgErr ? (
        <div className="aspect-video w-full overflow-hidden bg-secondary">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={post.image_url}
            alt="Post visual"
            className="w-full h-full object-cover"
            onError={() => setImgErr(true)}
          />
        </div>
      ) : (
        <div className="aspect-video w-full bg-gradient-to-br from-primary/5 to-primary/10 flex items-center justify-center">
          <ImageIcon className="h-8 w-8 text-primary/20" />
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <PlatformBadge platform={post.platform} />
            <span className="text-[10px] text-muted-foreground capitalize">{post.content_type}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 ${statusCfg.class}`}>
              {statusCfg.icon}{statusCfg.label}
            </span>
            <div className="relative">
              <button
                onClick={() => setMenu(m => !m)}
                className="p-1 rounded hover:bg-secondary transition-colors"
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
              {menu && (
                <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg p-1 min-w-[120px]" onMouseLeave={() => setMenu(false)}>
                  {onEdit && (
                    <button onClick={() => { onEdit(post); setMenu(false); }} className="w-full text-left text-xs px-3 py-1.5 rounded hover:bg-secondary flex items-center gap-2">
                      <Edit2 className="h-3 w-3" /> Edit
                    </button>
                  )}
                  {onSchedule && (
                    <button onClick={() => { onSchedule(post); setMenu(false); }} className="w-full text-left text-xs px-3 py-1.5 rounded hover:bg-secondary flex items-center gap-2">
                      <Clock className="h-3 w-3" /> Reschedule
                    </button>
                  )}
                  {onDelete && (
                    <button onClick={() => { onDelete(post.id); setMenu(false); }} className="w-full text-left text-xs px-3 py-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950 text-destructive flex items-center gap-2">
                      <Trash2 className="h-3 w-3" /> Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Caption */}
        <div>
          <p className="text-sm leading-relaxed text-foreground">
            {displayCaption}
            {truncated && (
              <button onClick={() => setExpanded(true)} className="text-primary text-xs ml-1">more</button>
            )}
          </p>
        </div>

        {/* Hashtags */}
        {post.hashtags && (
          <p className="text-xs text-primary/70 leading-relaxed">{post.hashtags}</p>
        )}

        {/* Schedule info */}
        {scheduledDate && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {post.status === "published" ? "Published" : "Scheduled"}: {scheduledDate}
          </div>
        )}

        {/* Actions */}
        {(post.status === "draft" || post.status === "pending_approval") && onApprove && (
          <Button
            size="sm"
            className="w-full h-8 text-xs gap-1.5"
            onClick={handleApprove}
            disabled={approving}
          >
            {approving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Approve & Schedule
          </Button>
        )}
      </div>
    </div>
  );
}
