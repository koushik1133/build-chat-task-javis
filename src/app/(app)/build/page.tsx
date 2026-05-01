"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Wand2,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Upload,
  FileText,
  Sparkles,
} from "lucide-react";
import { JarvisMascot } from "@/components/jarvis-mascot";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn, timeAgo } from "@/lib/utils";
import {
  CATEGORIES,
  type Category,
  type IntakeField,
  type Theme,
} from "@/lib/build-categories";

type Site = { id: string; title: string; persona: string | null; updated_at: string };

type ResumeProfile = {
  name?: string;
  role?: string;
  shortBio?: string;
  skills?: string[];
  projects?: { title: string; desc: string }[];
  experience?: { company: string; role: string; years: string }[];
  suggestedThemes?: string[];
  themeReason?: string;
};

export default function BuildPage() {
  const router = useRouter();
  const [step, setStep] = useState<number>(0);
  const [sites, setSites] = useState<Site[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [themeId, setThemeId] = useState("");
  const [freeText, setFreeText] = useState("");
  const [resumeProfile, setResumeProfile] = useState<ResumeProfile | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const category: Category | undefined = useMemo(
    () => CATEGORIES.find((c) => c.id === categoryId),
    [categoryId]
  );

  useEffect(() => {
    fetch("/api/build/sites")
      .then((r) => r.json())
      .then((d) => setSites(d.sites ?? []))
      .catch(() => {});
  }, []);

  function setAnswer(id: string, v: string) {
    setAnswers((prev) => ({ ...prev, [id]: v }));
  }

  function pickCategory(id: string) {
    setCategoryId(id);
    setAnswers({});
    setThemeId("");
    setResumeProfile(null);
    setStep(1);
  }

  function intakeFilled(): boolean {
    if (!category) return false;
    for (const f of category.intake) {
      if (f.optional || f.type === "file") continue;
      const v = answers[f.id];
      if (!v || !v.trim()) return false;
    }
    return true;
  }

  async function generate() {
    if (!category || !themeId) return;
    setGenerating(true);
    setError("");
    try {
      const r = await fetch("/api/build/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: category.id,
          themeId,
          answers,
          freeText: freeText || undefined,
          resumeProfile: resumeProfile ?? undefined,
        }),
      });
      const text = await r.text();
      let data: { siteId?: string; error?: string } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Server returned non-JSON response (status ${r.status}). First 200 chars: ${text.slice(0, 200)}`
        );
      }
      if (!r.ok) throw new Error(data.error ?? `Generation failed (${r.status})`);
      if (!data.siteId) throw new Error("Server returned no siteId");
      router.push(`/build/${data.siteId}`);
    } catch (e) {
      setError((e as Error).message);
      setGenerating(false);
    }
  }

  if (generating) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="space-y-4 text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
          <JarvisMascot
            size="md"
            message="Building your site… first pass usually takes 20–60 seconds. Hang tight."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        {step === 0 && (
          <div className="space-y-8">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-semibold tracking-tight">Build something</h1>
              {sites.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {sites.length} site{sites.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            <JarvisMascot
              size="lg"
              message="Pick a category. I'll ask a few questions tailored to it, show themes that fit, and suggest features the world's top sites in your niche actually use."
            />

            <div>
              <p className="mb-3 text-sm font-medium">Which fits you best?</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => pickCategory(c.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-all hover:border-primary/40 hover:bg-secondary/40",
                      categoryId === c.id && "border-primary bg-secondary"
                    )}
                  >
                    <span className="text-2xl">{c.emoji}</span>
                    <div>
                      <div className="text-sm font-medium">{c.label}</div>
                      <div className="text-xs text-muted-foreground">{c.hint}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {sites.length > 0 && (
              <div className="border-t border-border pt-6">
                <p className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
                  Recent sites
                </p>
                <ul className="space-y-1">
                  {sites.slice(0, 6).map((s) => (
                    <li key={s.id}>
                      <Link
                        href={`/build/${s.id}`}
                        className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-secondary/60"
                      >
                        <span className="truncate">{s.title}</span>
                        <span className="text-xs text-muted-foreground">{timeAgo(s.updated_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {step === 1 && category && (
          <StepShell
            mascot={`Tell me about your ${category.label.toLowerCase()}. The more specific, the better — I'll use it to find features your top competitors actually use.`}
            back={() => setStep(0)}
            next={() => setStep(2)}
            canNext={intakeFilled()}
          >
            <div className="space-y-5">
              {category.intake.map((field) => (
                <IntakeFieldView
                  key={field.id}
                  field={field}
                  value={answers[field.id] ?? ""}
                  onChange={(v) => setAnswer(field.id, v)}
                  onResumeParsed={(profile) => {
                    setResumeProfile(profile);
                    if (profile.name && !answers.businessName) setAnswer("businessName", profile.name);
                    if (profile.role && !answers.role) setAnswer("role", profile.role);
                    if (profile.shortBio && !answers.goal) setAnswer("goal", profile.shortBio);
                    if (profile.suggestedThemes?.[0]) setThemeId(profile.suggestedThemes[0]);
                  }}
                  resumeBusy={resumeBusy}
                  setResumeBusy={setResumeBusy}
                  resumeError={resumeError}
                  setResumeError={setResumeError}
                />
              ))}
              {resumeProfile && (
                <ResumePreview profile={resumeProfile} />
              )}
            </div>
          </StepShell>
        )}

        {step === 2 && category && (
          <StepShell
            mascot="Pick a theme. This sets the look — typography, colors, layout style. You can refine anything afterward."
            back={() => setStep(1)}
            next={() => setStep(3)}
            canNext={themeId.length > 0}
          >
            {resumeProfile?.suggestedThemes && resumeProfile.suggestedThemes.length > 0 && (
              <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
                <Sparkles className="mr-1 inline h-3 w-3 text-primary" />
                Based on your resume: {resumeProfile.themeReason ?? "we recommend the highlighted theme."}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {category.themes.map((t) => {
                const recommended = resumeProfile?.suggestedThemes?.includes(t.id);
                return (
                  <ThemeCard
                    key={t.id}
                    theme={t}
                    selected={themeId === t.id}
                    recommended={!!recommended}
                    onClick={() => setThemeId(t.id)}
                  />
                );
              })}
            </div>
            <div className="mt-6">
              <p className="mb-2 text-xs text-muted-foreground">Anything else? (optional)</p>
              <Textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="Specific colors, must-have sections, things to avoid..."
                className="h-20 resize-none"
              />
            </div>
          </StepShell>
        )}

        {step === 3 && category && (
          <div className="space-y-6">
            <JarvisMascot
              size="md"
              message="Here's what I'll build. Looks right? Hit Generate."
            />

            <div className="rounded-xl border border-border bg-card p-6">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Locked scope preview
              </p>
              <h2 className="mt-2 text-lg font-semibold">
                {category.themes.find((t) => t.id === themeId)?.label} — {category.label}
              </h2>
              <ul className="mt-4 space-y-2 text-sm">
                {category.intake
                  .filter((f) => answers[f.id])
                  .map((f) => (
                    <li key={f.id}>
                      <span className="text-muted-foreground">{f.label}: </span>
                      <span className="whitespace-pre-wrap">{answers[f.id]}</span>
                    </li>
                  ))}
                {freeText && (
                  <li>
                    <span className="text-muted-foreground">Notes: </span>
                    {freeText}
                  </li>
                )}
                {resumeProfile && (
                  <li className="text-xs text-muted-foreground">
                    Resume parsed: {resumeProfile.skills?.length ?? 0} skills, {resumeProfile.projects?.length ?? 0} projects
                  </li>
                )}
              </ul>
              <div className="mt-4 rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                Estimated build time: ~30–60 seconds. After it&apos;s built, the Features tab will show what your top competitors actually use.
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button onClick={generate}>
                <Wand2 className="h-4 w-4" /> Generate site
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IntakeFieldView({
  field,
  value,
  onChange,
  onResumeParsed,
  resumeBusy,
  setResumeBusy,
  resumeError,
  setResumeError,
}: {
  field: IntakeField;
  value: string;
  onChange: (v: string) => void;
  onResumeParsed: (p: ResumeProfile) => void;
  resumeBusy: boolean;
  setResumeBusy: (v: boolean) => void;
  resumeError: string;
  setResumeError: (v: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setResumeBusy(true);
    setResumeError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/build/resume", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed to read resume");
      onResumeParsed(data.profile as ResumeProfile);
    } catch (e) {
      setResumeError((e as Error).message);
    } finally {
      setResumeBusy(false);
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">
        {field.label}
        {field.optional && <span className="ml-1 text-xs text-muted-foreground">(optional)</span>}
      </label>
      {field.hint && (
        <p className="mb-2 text-xs text-muted-foreground">{field.hint}</p>
      )}

      {field.type === "text" && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      )}

      {field.type === "textarea" && (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="h-28 resize-none"
        />
      )}

      {field.type === "chips" && field.options && (
        <div className="flex flex-wrap gap-2">
          {field.options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={cn(
                "rounded-full border border-border px-3 py-1.5 text-xs transition-colors",
                value === opt
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-secondary/60"
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {field.type === "multichips" && field.options && (
        <>
          <div className="flex flex-wrap gap-2">
            {field.options.map((opt) => {
              const list = value ? value.split(", ") : [];
              const active = list.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() =>
                    onChange(
                      active
                        ? list.filter((x) => x !== opt).join(", ")
                        : [...list, opt].join(", ")
                    )
                  }
                  className={cn(
                    "rounded-full border border-border px-3 py-1.5 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-secondary/60"
                  )}
                >
                  {opt}
                </button>
              );
            })}
          </div>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Selected, or write your own"
            className="mt-2"
          />
        </>
      )}

      {field.type === "file" && (
        <div className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={field.accept}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={resumeBusy}
          >
            {resumeBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {resumeBusy ? "Reading resume..." : "Upload PDF"}
          </Button>
          {resumeError && (
            <p className="text-xs text-destructive">{resumeError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ResumePreview({ profile }: { profile: ResumeProfile }) {
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
        <FileText className="h-4 w-4" /> Resume parsed
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        {profile.name && <div><strong>Name:</strong> {profile.name}</div>}
        {profile.role && <div><strong>Role:</strong> {profile.role}</div>}
        {profile.skills && profile.skills.length > 0 && (
          <div className="sm:col-span-2">
            <strong>Skills:</strong> {profile.skills.slice(0, 8).join(", ")}
          </div>
        )}
        {profile.projects && profile.projects.length > 0 && (
          <div className="sm:col-span-2">
            <strong>Projects:</strong> {profile.projects.length} found
          </div>
        )}
      </div>
    </div>
  );
}

function ThemeCard({
  theme,
  selected,
  recommended,
  onClick,
}: {
  theme: Theme;
  selected: boolean;
  recommended: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex flex-col gap-3 rounded-lg border border-border p-4 text-left transition-all",
        selected ? "border-primary ring-2 ring-primary/30" : "hover:border-primary/40"
      )}
    >
      {recommended && (
        <span className="absolute right-3 top-3 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          Recommended
        </span>
      )}
      <div className={cn("h-20 w-full rounded-md bg-gradient-to-br", theme.swatch)} />
      
      {theme.colors && (
        <div className="flex -space-x-1.5 pt-1">
          {theme.colors.map((hex, i) => (
            <div 
              key={i} 
              className="h-5 w-5 rounded-full border border-border shadow-sm ring-1 ring-background" 
              style={{ backgroundColor: hex }} 
            />
          ))}
        </div>
      )}

      <div>
        <div className="text-sm font-medium">{theme.label}</div>
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{theme.brief}</div>
      </div>
    </button>
  );
}

function StepShell({
  mascot,
  children,
  back,
  next,
  canNext,
}: {
  mascot: string;
  children: React.ReactNode;
  back: () => void;
  next: () => void;
  canNext: boolean;
}) {
  return (
    <div className="space-y-6">
      <JarvisMascot size="md" message={mascot} />
      <div>{children}</div>
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={back}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={next} disabled={!canNext}>
          Continue <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
