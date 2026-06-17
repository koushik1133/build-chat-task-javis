import type { LucideIcon } from "lucide-react";
import {
  MessageSquare,
  FileText,
  Github,
  ListTodo,
  Wand2,
  BarChart2,
  Briefcase,
  Bot,
  Zap,
  Kanban,
} from "lucide-react";

export type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export const APP_NAV: AppNavItem[] = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/files", label: "Files", icon: FileText },
  { href: "/github", label: "GitHub", icon: Github },
  { href: "/build", label: "AI Studio", icon: Wand2 },
  { href: "/production", label: "Production", icon: Kanban },
  { href: "/agents", label: "AI Agents", icon: Bot },
  { href: "/automations", label: "Automations", icon: Zap },
  { href: "/strategy", label: "Strategy Hub", icon: Briefcase },
  { href: "/analytics", label: "Data Analysis", icon: BarChart2 },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
];
