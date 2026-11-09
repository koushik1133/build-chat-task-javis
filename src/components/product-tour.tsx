"use client";

import { useEffect, useState } from "react";
import { X, HelpCircle, LayoutDashboard, Boxes, LifeBuoy, Receipt, Bot, Command } from "lucide-react";

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

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        writeCompleted();
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

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
        className="fixed bottom-4 right-4 z-50 flex min-h-[44px] items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-lg transition-all hover:scale-105 hover:bg-primary/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Start product tour"
      >
        <HelpCircle className="h-4 w-4" aria-hidden />
        <span>Tour</span>
      </button>
    );
  }

  const step = TOUR_STEPS[currentStep];
  const Icon = step.icon;

  const handleNext = () => {
    if (currentStep < TOUR_STEPS.length - 1) setCurrentStep(currentStep + 1);
    else handleClose();
  };
  const handleBack = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-200" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200">
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close tour"
          className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div className="mb-6 flex gap-1.5" aria-hidden>
          {TOUR_STEPS.map((_, idx) => (
            <div key={idx} className={`h-1 flex-1 rounded-full transition-all duration-300 ${idx <= currentStep ? "bg-primary" : "bg-secondary"}`} />
          ))}
        </div>

        <div className="mb-4 flex items-center justify-between">
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">{step.badge}</span>
          <span className="text-xs font-medium text-muted-foreground">Step {currentStep + 1} of {TOUR_STEPS.length}</span>
        </div>

        <div className="mb-4 inline-flex items-center justify-center rounded-2xl bg-primary/5 p-4 text-primary" aria-hidden>
          <Icon className="h-8 w-8" />
        </div>

        <h3 id="tour-title" className="mb-2 text-lg font-bold text-foreground">{step.title}</h3>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">{step.description}</p>

        <div className="mb-6 flex flex-col gap-1 rounded-xl border border-border/50 bg-secondary/40 p-3 text-xs text-muted-foreground">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">Try this</span>
          <span>{step.actionDescription}</span>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3">
          <button type="button" onClick={handleClose} className="min-h-[44px] rounded-md px-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Skip tour
          </button>
          <div className="flex gap-2">
            {currentStep > 0 && (
              <button type="button" onClick={handleBack} className="min-h-[44px] rounded-lg border border-border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Back
              </button>
            )}
            <button type="button" onClick={handleNext} className="min-h-[44px] rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {currentStep === TOUR_STEPS.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
