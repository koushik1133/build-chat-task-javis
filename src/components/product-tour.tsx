"use client";

import { useEffect, useState } from "react";
import { X, MessageSquare, FileText, Play, Mail, Compass, HelpCircle } from "lucide-react";

type TourStep = {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: string;
  actionDescription: string;
};

const TOUR_STEPS: TourStep[] = [
  {
    title: "Welcome to KernelHub!",
    description: "Your autonomous, multi-agent AI assistant space. Let's take a quick 1-minute tour to help you get started.",
    icon: Compass,
    badge: "Introduction",
    actionDescription: "You will learn how to navigate and make the most of Javis.",
  },
  {
    title: "Copilot Chat",
    description: "Brainstorm business strategies, generate complete websites, audit codebase security, or write files in real-time. Just talk to the AI Copilot to get started.",
    icon: MessageSquare,
    badge: "AI Studio",
    actionDescription: "Use this to program agents, generate code, and edit tasks dynamically.",
  },
  {
    title: "Knowledge Base (Files)",
    description: "Upload PDFs, slides, text documents, or connect GitHub repos. The AI reads them instantly to give context-aware responses tailored specifically to your data.",
    icon: FileText,
    badge: "Context & RAG",
    actionDescription: "Upload source documents here to enrich your agent's knowledge.",
  },
  {
    title: "Automations Runner",
    description: "Set up tasks, trigger HTTP webhooks, schedule recurring cron scripts, or deploy background agents to run automatically on your board columns.",
    icon: Play,
    badge: "Workflows",
    actionDescription: "Automate boring tasks by triggering pipelines on Kanban changes.",
  },
  {
    title: "Settings & Connections",
    description: "Link your Gmail account (via App Passwords) or configure Slack webhooks to receive real-time alerts whenever agents complete their background tasks.",
    icon: Mail,
    badge: "Integrations",
    actionDescription: "One-time setup so all automations can notify you instantly.",
  },
];

export function ProductTour() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    // Check if user has already completed the tour
    const completed = localStorage.getItem("completed_product_tour_v1");
    if (!completed) {
      setIsOpen(true);
    }
  }, []);

  if (!isOpen) {
    return (
      <button
        onClick={() => {
          setCurrentStep(0);
          setIsOpen(true);
        }}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-lg hover:bg-primary/95 transition-all hover:scale-105"
        title="Start Product Tour"
      >
        <HelpCircle className="h-4 w-4" />
        <span>Tour</span>
      </button>
    );
  }

  const step = TOUR_STEPS[currentStep];
  const Icon = step.icon;

  const handleNext = () => {
    if (currentStep < TOUR_STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleClose();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleClose = () => {
    localStorage.setItem("completed_product_tour_v1", "true");
    setIsOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200">
        
        {/* Close Button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Progress Bar */}
        <div className="flex gap-1.5 mb-6">
          {TOUR_STEPS.map((_, idx) => (
            <div
              key={idx}
              className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                idx <= currentStep ? "bg-primary" : "bg-secondary"
              }`}
            />
          ))}
        </div>

        {/* Card Header / Badge */}
        <div className="flex items-center justify-between mb-4">
          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-primary/10 text-primary">
            {step.badge}
          </span>
          <span className="text-xs text-muted-foreground font-medium">
            Step {currentStep + 1} of {TOUR_STEPS.length}
          </span>
        </div>

        {/* Step Icon */}
        <div className="mb-4 inline-flex items-center justify-center rounded-2xl bg-primary/5 p-4 text-primary">
          <Icon className="h-8 w-8" />
        </div>

        {/* Step Content */}
        <h3 className="text-lg font-bold text-foreground mb-2">{step.title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">{step.description}</p>

        {/* Dynamic Action Details Box */}
        <div className="rounded-xl bg-secondary/40 border border-border/50 p-3 mb-6 text-xs text-muted-foreground flex flex-col gap-1">
          <span className="font-semibold text-foreground uppercase tracking-wider text-[10px]">What is done here</span>
          <span>{step.actionDescription}</span>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between gap-3 mt-2">
          <button
            onClick={handleClose}
            className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
          >
            Skip Tour
          </button>
          
          <div className="flex gap-2">
            {currentStep > 0 && (
              <button
                onClick={handleBack}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-secondary transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/95 transition-colors"
            >
              {currentStep === TOUR_STEPS.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
