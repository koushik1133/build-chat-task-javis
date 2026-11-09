"use client";

import { useEffect, useRef, useState } from "react";
import { X, HelpCircle, LayoutDashboard, Boxes, LifeBuoy, Receipt, Bot, Command } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/ui/hooks";
import { cn } from "@/lib/utils";

type TourStep = {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: string;
  actionDescription: string;
};

/** Bump the key when steps change so returning users see the new tour once. */
const TOUR_STORAGE_KEY = "completed_product_tour_v2";

const TOUR_STEPS: TourStep[] = [
  {
    title: "Home is your day at a glance",
    description: "KPIs, what needs you, today's bookings and due work, and the agents working in the background — all on one screen, tailored to your role.",
    icon: LayoutDashboard,
    badge: "Home",
    actionDescription: "Start here each morning. The setup checklist stays until your workspace is fully configured.",
  },
  {
    title: "Records fit your business",
    description: "Install a pack for your industry — patients, matters, properties, jobs — and track every item through stages with custom fields and views.",
    icon: Boxes,
    badge: "Records",
    actionDescription: "Open Records to add types, import a CSV, or drag items across a pipeline.",
  },
  {
    title: "Helpdesk with SLAs",
    description: "Tickets from email, chat and the customer portal land in one queue. SLA timers, breaches and auto-resolve playbooks keep response times honest.",
    icon: LifeBuoy,
    badge: "Helpdesk",
    actionDescription: "Set a default SLA policy once; every ticket inherits it.",
  },
  {
    title: "Quotes, invoices and payments",
    description: "Send a quote, let the customer accept and e-sign online, and it becomes an invoice with a pay link. Expenses and time roll into job costing.",
    icon: Receipt,
    badge: "Billing",
    actionDescription: "Watch the cash-flow forecast on Home update as invoices are paid.",
  },
  {
    title: "Agents and playbooks",
    description: "Starter agents handle research, drafting and follow-ups. Playbooks detect stalled deals, unanswered messages and overdue work, then queue actions for your approval.",
    icon: Bot,
    badge: "Agents",
    actionDescription: "Choose how much autonomy each agent has: draft, ask first, or act.",
  },
  {
    title: "Jump anywhere with Cmd+K",
    description: "Press ⌘K (Ctrl+K on Windows) to search contacts, pages, quotes and tickets, or to run a quick action without leaving the keyboard.",
    icon: Command,
    badge: "Search",
    actionDescription: "Try it now — type a customer's name or 'new quote'.",
  },
];

function readCompleted(): boolean {
  try {
    return localStorage.getItem(TOUR_STORAGE_KEY) === "true";
  } catch {
    return true; // storage blocked: never nag
  }
}

function writeCompleted(): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, "true");
  } catch {
    // ignore: private mode / blocked storage
  }
}

export function ProductTour() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (!readCompleted()) setIsOpen(true);
  }, []);

  const handleClose = () => {
    writeCompleted();
    setIsOpen(false);
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => {
          setCurrentStep(0);
          setIsOpen(true);
        }}
        className="fixed right-4 z-50 flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-lg transition-all hover:scale-105 hover:bg-primary/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:scale-100 [bottom:max(1rem,env(safe-area-inset-bottom))]"
        aria-label="Start product tour"
      >
        <HelpCircle className="h-4 w-4" aria-hidden />
        <span>Tour</span>
      </button>
    );
  }

  return <TourDialog step={currentStep} onStep={setCurrentStep} onClose={handleClose} />;
}

/** Separate component so useModal mounts fresh each time the tour opens (focus trap, Escape, scroll lock, focus restore). */
function TourDialog({ step: currentStep, onStep, onClose }: { step: number; onStep: (n: number) => void; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModal(panelRef, onClose, { initialFocus: "container" });

  const step = TOUR_STEPS[currentStep];
  const Icon = step.icon;
  const last = currentStep === TOUR_STEPS.length - 1;

  const handleNext = () => {
    if (!last) onStep(currentStep + 1);
    else onClose();
  };
  const handleBack = () => {
    if (currentStep > 0) onStep(currentStep - 1);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm animate-in fade-in duration-200 motion-reduce:animate-none sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-desc"
        tabIndex={-1}
        className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-card p-6 shadow-2xl outline-none animate-in zoom-in-95 duration-200 motion-reduce:animate-none sm:rounded-2xl [padding-bottom:max(1.5rem,env(safe-area-inset-bottom))]"
      >
        <button
          type="button"
          data-dialog-close=""
          onClick={onClose}
          aria-label="Close tour"
          className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:right-3 sm:top-3 sm:h-9 sm:w-9"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div className="mb-6 flex gap-1.5" aria-hidden>
          {TOUR_STEPS.map((_, idx) => (
            <div key={idx} className={cn("h-1 flex-1 rounded-full transition-all duration-300 motion-reduce:transition-none", idx <= currentStep ? "bg-primary" : "bg-secondary")} />
          ))}
        </div>

        <div className="mb-4 flex items-center justify-between gap-2 pr-10">
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">{step.badge}</span>
          <span className="text-xs font-medium text-muted-foreground" aria-live="polite">
            Step {currentStep + 1} of {TOUR_STEPS.length}
          </span>
        </div>

        <div className="mb-4 inline-flex items-center justify-center rounded-2xl bg-primary/5 p-4 text-primary" aria-hidden>
          <Icon className="h-8 w-8" />
        </div>

        <h3 id="tour-title" className="mb-2 text-lg font-bold text-foreground">{step.title}</h3>
        <p id="tour-desc" className="mb-4 text-sm leading-relaxed text-muted-foreground">{step.description}</p>

        <div className="mb-6 flex flex-col gap-1 rounded-xl border border-border/50 bg-secondary/40 p-3 text-xs text-muted-foreground">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">Try this</span>
          <span>{step.actionDescription}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="ghost" size="sm" touch onClick={onClose} className="text-muted-foreground hover:text-foreground">
            Skip tour
          </Button>
          <div className="flex gap-2">
            {currentStep > 0 && (
              <Button type="button" variant="outline" size="sm" touch onClick={handleBack}>
                Back
              </Button>
            )}
            <Button type="button" size="sm" touch onClick={handleNext}>
              {last ? "Finish" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
